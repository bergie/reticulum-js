# Reticulum Network System: JavaScript Implementation Specification (RETICULUM-JS)

## 1. Architectural Overview & Objectives

This document outlines the technical specification for a clean-room, zero-dependency JavaScript implementation of the Reticulum Network System (RNS).

The architecture is strictly bound to native ES6 modules, `Uint8Array`, `DataView`, and the Web Crypto API. By avoiding NPM runtime dependencies entirely, the resulting codebase can stay in working order for the years to come, and is less susceptible to supply-chain vulnerabilities.

This implementation is optimized to operate as a "leaf node" transport layer. Functionality needed for building Reticulum Transport nodes in JavaScript may be added later.

### 1.1 Dependency & import boundaries

The public entry point (`src/index.js`) and every module in its **static
import graph** must remain browser-safe and free of runtime dependencies
beyond the [WinterTC Minimum Common API](https://min-common-api.proposal.wintertc.org/).

- **No Node.js imports reachable from `index.js`.** Files imported
  transitively via static `import` from `src/index.js` — the core
  (`src/core`, `src/crypto`, `src/transport`) — **must not** import Node.js
  dependencies, including the `node:` core libraries (`node:net`,
  `node:http`, `node:dgram`, `node:fs`, …). This is what guarantees a browser
  bundler (webpack, tsdown/rolldown, vite, esbuild, rollup) never pulls
  Node-only code into a browser build, with zero per-tool configuration.
  (The only `node:` import outside `src/interfaces/` today is
  `src/utils/netinfo.js` → `node:os`, and it is imported exclusively by the
  AutoInterface — never by `index.js`.)

- **Functionality needing third-party or Node-only libraries must either:**
  1. be wired in via **dependency injection**, so the core has no static
     `import` of the dependency and the caller supplies the concrete
     implementation — exactly how bz2 compression is handled
     (`new Reticulum({ compressionProvider })` is threaded down to
     `Resource`/`Link` as `options.bz2`; `@digitaldefiance/bzip2-wasm` is a
     devDependency only); **or**
  2. be **published as a separate package** that imports from `reticulum-js`
     and injects its concrete runtime (dependency direction is one-way:
     companion → core, never core → companion). This is the chosen home for
     Node-only runtimes that carry native dependencies — e.g. Node.js WebRTC
     and the Node.js WebSocket Server (work doc #19).

Interfaces built on `node:` libraries (e.g. `src/interfaces/tcp.js`,
`src/interfaces/local_client.js`) are therefore **not** imported by
`src/index.js`; Node consumers import the module path directly, and browser
consumers simply do not.

---

## 2. Core Directory Structure

The system utilizes native ES Modules and a domain-driven structure, isolating cryptographic operations from network transport and application logic.

```text
reticulum-js/
├── src/
│   ├── crypto/            # Pure Web Crypto API wrappers
│   │   ├── keys.js        # X25519 / Ed25519 generation and parsing
│   │   └── ciphers.js     # AES-128-CBC, HKDF derivation
│   ├── core/              # Reticulum domain logic
│   │   ├── identity.js    # Identity creation, signing, and verification
│   │   ├── destination.js # Routing targets (EventTargets)
│   │   └── packet.js      # Binary serialization/deserialization
│   ├── transport/         # Mesh routing and link management
│   │   ├── hdlc-framer.js # HDLC stream framing (TCP / loopback default)
│   │   ├── kiss-framer.js # KISS stream framing (serial/RNode; optional TCP/WS)
│   │   └── link.js        # Encrypted session establishment (ECIES)
│   ├── interfaces/        # Environment-agnostic I/O
│   │   ├── base.js        # Interface interface (Base class)
│   │   ├── tcp.js         # Node.js / Deno direct sockets
│   │   └── websocket.js   # Browser-to-Node / Node-to-Node
└── index.js               # Public API exports

```

---

## 3. Cryptographic Subsystem

To achieve byte-for-byte compatibility with the Python RNS reference, the cryptographic layer maps directly to `globalThis.crypto.subtle`.

### 3.1 Primitives

* **Signatures:** Ed25519 (64-byte signatures appended to packet payloads).
* **Key Exchange:** Ephemeral X25519 (ECDH).
* **Key Derivation:** HKDF with SHA-256.
* **Symmetric Encryption:** AES-128-CBC.

### 3.2 Key Management & Memory

Web Crypto requires `ArrayBuffer`, while standard network manipulation uses `Uint8Array`. The implementation must use zero-copy `.subarray()` slicing and extract the `.buffer` precisely to prevent memory corruption.

### 3.3 Link Establishment (ECIES Flow)

Establishing an encrypted tunnel relies on a chained asynchronous Promise flow to derive the symmetric operational key.

```javascript
export class LinkEncryption {
    static async deriveLinkKey(localPrivateX25519, remotePublicX25519, salt) {
        // 1. ECDH Shared Secret
        const sharedSecretBits = await crypto.subtle.deriveBits(
            { name: "X25519", public: remotePublicX25519 },
            localPrivateX25519,
            256
        );

        // 2. Import Master Key for HKDF
        const hkdfMasterKey = await crypto.subtle.importKey(
            "raw", sharedSecretBits, { name: "HKDF" }, false, ["deriveKey"]
        );

        // 3. Derive 128-bit AES-CBC Key
        return await crypto.subtle.deriveKey(
            {
                name: "HKDF", hash: "SHA-256", salt: salt,
                info: new Uint8Array([0x52, 0x4e, 0x53]) // "RNS" protocol info
            },
            hkdfMasterKey,
            { name: "AES-CBC", length: 128 },
            false, // Non-extractable for memory security
            ["encrypt", "decrypt"]
        );
    }
}

```

---

## 4. Binary Framing & Serialization

RNS enforces a compact binary wire format. Serialization relies heavily on `DataView` for Big-Endian network byte order and bitwise manipulation.

### 4.1 Header Bitmasking

The first byte (Byte 0) of an RNS packet contains dense routing flags.

```javascript
function buildHeaderByteZero(ifacFlag, headerType, contextFlag, packetType) {
    let byte0 = 0x00;
    byte0 |= (ifacFlag & 0x01) << 7;
    byte0 |= (headerType & 0x01) << 6;
    byte0 |= (contextFlag & 0x01) << 5;
    byte0 |= (packetType & 0x0F); 
    return byte0;
}

```

### 4.2 Packet Construction

Packets are allocated exactly to their required byte length to prevent memory bloat during high-frequency CRDT visual coordinate updates.

```javascript
export class PacketSerializer {
    static serialize(destinationHash, contextByte, payloadBytes, packetType) {
        const totalLength = 19 + payloadBytes.length;
        const buffer = new ArrayBuffer(totalLength);
        const view = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);

        view.setUint8(0, buildHeaderByteZero(0, 0x00, 0, packetType)); // Byte 0: Flags
        view.setUint8(1, 0x00);                                        // Byte 1: Hops
        uint8.set(destinationHash, 2);                                 // Byte 2-17: Dest Hash
        view.setUint8(18, contextByte);                                // Byte 18: Context
        uint8.set(payloadBytes, 19);                                   // Byte 19+: Payload

        return uint8;
    }
}

```

---

## 5. Network Interfaces & Native Streams

Concurrency is managed through Native Web Streams API rather than legacy event emitters, allowing for automatic backpressure handling.

### 5.1 The Interface Abstract Base

All physical connections conform to a standard Interface class, allowing seamless swapping between TCP (for Node/Deno runtimes) and WebSockets (for browsers).

### 5.2 Stream Framing (`TransformStream`)

Stream-oriented interfaces (TCP, local Unix socket) pipe raw byte chunks
through a `TransformStream` that reassembles them into complete RNS packets
before handing them to the transport layer. Two interchangeable framers are
provided, mirroring the Python reference's `HDLC` and `KISS` classes (see
`PROTOCOL-SPEC.md` §8):

- **HDLC** (`src/transport/hdlc-framer.js`) — `0x7E`/`0x7D` byte-stuffing.
  The default for TCP and the local client interface.
- **KISS** (`src/transport/kiss-framer.js`) — `FEND`/`FESC` byte-stuffing
  with a `CMD_DATA` command byte. Used by serial/RNode interfaces, and
  selectable on TCP (`framing: "kiss"`, matching Python's `kiss_framing`)
  and WebSocket (`framing: "kiss"`, for RNode-style KISS-over-WS peers).

Message-oriented transports (WebSocket in its default `raw` mode) send one
RNS packet per binary message and need no framing transform.

---

## 6. Mesh Integration & Application Boundary

To minimize initial scope, the JS implementation operates as a non-routing **Leaf Node**. It connects to an existing Python RNS (or other Reticulum) transport node via WebSocket or TCP.

### 6.1 The Announce Mechanism

To become reachable, the application constructs and transmits an `AnnouncePacket`.

1. **Construct Payload:** `[Destination Hash (16 bytes)] + [Ed25519 Public Key (32 bytes)] + [App Data]`
2. **Sign Payload:** Utilize `crypto.subtle.sign` to generate a 64-byte Ed25519 signature over the payload.
3. **Assemble & Transmit:** Append the signature to the raw payload, attach the RNS header, and push down the active interface stream.

### 6.2 Application Layer Handoff

High-level classes extend the native `EventTarget` to provide a clean, DOM-like API for the application layer.

```javascript
// Example Application Boundary implementation
const myAppDest = new Destination(myIdentity, Destination.IN, Destination.SINGLE, "myapp", "feature");

myAppDest.addEventListener('link', (event) => {
    const activeLink = event.detail.link;
    
    // Pipe the decrypted, ordered RNS stream directly into your app
    activeLink.readable
        .pipeTo(WritableStreamFromMyApp);
});
```
