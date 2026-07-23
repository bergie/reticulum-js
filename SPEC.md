# Reticulum Network System: JavaScript Implementation Specification (RETICULUM-JS)

## 1. Architectural Overview & Objectives

This document outlines the technical specification for a clean-room, zero-dependency JavaScript implementation of the Reticulum Network System (RNS).

The architecture is strictly bound to native ES6 modules, `Uint8Array`, `DataView`, and the Web Crypto API. By avoiding NPM runtime dependencies entirely, the resulting codebase can stay in working order for the years to come, and is less susceptible to supply-chain vulnerabilities.

This implementation is optimized to operate as a "leaf node" transport layer. Functionality needed for building Reticulum Transport nodes in JavaScript may be added later.

### 1.1 Dependency & import boundaries

The codebase is an npm-workspaces monorepo (see §2). Only the **core
package** (`packages/core`) must stay browser-safe: its public entry
point (`src/index.js`) and every module in its **static import graph** must
remain free of runtime dependencies beyond the
[WinterTC Minimum Common API](https://min-common-api.proposal.wintertc.org/).
Paths written as `src/...` in this section are relative to the core package.

- **No Node.js imports reachable from the core `index.js`.** Files imported
  transitively via static `import` from `src/index.js` — `src/core`,
  `src/crypto`, `src/transport`, `src/lxmf`, `src/webrtc`, and the
  browser-safe entries under `src/interfaces` — **must not** import Node.js
  dependencies, including the `node:` core libraries (`node:net`,
  `node:http`, `node:dgram`, `node:fs`, …). This is what guarantees a browser
  bundler (webpack, tsdown/rolldown, vite, esbuild, rollup) never pulls
  Node-only code into a browser build, with zero per-tool configuration.
  Node-builtin interfaces and `src/utils/netinfo.js` (`node:os`) live in the
  `@reticulum/node` companion.)

- **Functionality needing third-party or Node-only libraries must either:**
  1. be wired in via **dependency injection**, so the core has no static
     `import` of the dependency and the caller supplies the concrete
     implementation — exactly how bz2 compression is handled
     (`new Reticulum({ compressionProvider })` is threaded down to
     `Resource`/`Link` as `options.bz2`; `@digitaldefiance/bzip2-wasm` is a
     devDependency only); **or**
  2. be **published as a separate package** that imports from `@reticulum/core`
     and injects its concrete runtime (dependency direction is one-way:
     companion → core, never core → companion). The companions are
     `@reticulum/node` (Node-builtin interfaces — TCP, AutoInterface,
     LocalClient, HTTP POST server — plus the interface registry),
     `@reticulum/webrtc-node` (a werift-backed `createPeerConnection`
     factory for the core's WebRTC transport), and
     `@reticulum/websocket-server-node` (a ws-backed WebSocket **server**).

Interfaces built on `node:` libraries (e.g. `tcp.js`, `local_client.js`)
therefore **do not live in the core package at all** — Node consumers import
them from the `@reticulum/node` companion, and browser consumers simply do
not use them.

### 1.2 Logging

All diagnostic output goes through `log(module, message, level)` in
`src/utils/log.js` (never `console.*` directly). The `LogLevel` enum is
aligned with the Python reference `RNS.LOG_*` (`RNS/__init__.py:65-74`), so
the names, ordering and numeric values match Python exactly. **Always
reference a level by its `LogLevel` name, never by a raw number** — numbers
are a convenience for the `RETICULUM_LOG_LEVEL` env var / `setLogLevel`, not
for call sites.

The active threshold defaults to `NOTICE` (Python's `LOG_NOTICE`). A message
prints when `level <= threshold`. This makes the choice of level primarily a
*visibility* decision, so pick the level by what an operator should see by
default:

| Level | Use for |
|-------|---------|
| `CRITICAL` | unrecoverable failures that abort a subsystem |
| `ERROR` | operation failed, but the node continues |
| `WARNING` | degraded/recoverable condition (e.g. bad PRF, HMU sequencing error) |
| `NOTICE` | **default-visible** operational events: engine init, interface attached/removed, destination registered, link established, peer discovered |
| `INFO` | one notch above default — useful progress that is off by default |
| `VERBOSE` | detailed step-by-step flow for tracing a single operation |
| `DEBUG` | per-method diagnostic detail |
| `PATHING` | path/route resolution and announce processing detail |
| `EXTREME` | per-packet / per-byte dumps (full frame hex, raw ciphertext) |

Two consequences call-site authors must keep in mind:

- **`log(module, message)` defaults to `DEBUG`** — i.e. *hidden* by default.
  Anything that should appear at the default verbosity (the `NOTICE` row
  above) **must** pass an explicit `LogLevel.NOTICE` (or lower). Bare calls are
  treated as debug noise.
- **Message bodies must be cheap to build.** `log()` always evaluates its
  arguments (including any template-string interpolation) *before* the
  threshold check discards them. For `EXTREME`/`PATHING` dumps that are
  expensive to format (large `toHex()` of whole frames), gate the work on the
  threshold — e.g. `if (getLogLevel() >= LogLevel.EXTREME) log("Mod", hexDump(), LogLevel.EXTREME)` — so a production node pays nothing for them.

Operators control the threshold in three ways, with precedence (highest
first): the `Reticulum({ logLevel })` constructor option, the
`RETICULUM_LOG_LEVEL` environment variable (read once at module load, name or
number), and the `NOTICE` default. The exported `setLogLevel()` /
`getLogLevel()` adjust it at runtime; both accept a name or number.

---

## 2. Package Structure

The project is an npm-workspaces monorepo: a zero-dependency, browser-safe **core** package plus small **companion** packages that add Node-only or external-dependency interfaces. The core uses native ES Modules with a domain-driven structure, isolating cryptographic operations from network transport and application logic.

```text
reticulum-js/                                 # private monorepo root (npm workspaces)
├── packages/
│   ├── core/                                 # CORE — zero-dep, browser-safe
│   │   └── src/
│   │       ├── crypto/                       # Web Crypto wrappers (keys, ciphers, token, hmac, pkcs7)
│   │       ├── core/                         # domain logic (identity, destination, packet, resource, …)
│   │       ├── transport/                    # mesh routing + link mgmt (link, channel, buffer,
│   │       │                                 #   hdlc/kiss-framer, discovery, transport, router)
│   │       ├── lxmf/                         # LXMF messaging (message, router, propagation, …)
│   │       ├── webrtc/                       # WebRTC transport signaling (DI-first)
│   │       ├── interfaces/                   # browser-safe I/O ONLY
│   │       │   ├── base.js                   # Interface base class
│   │       │   ├── http.js                   # HttpPostClientInterface (fetch)
│   │       │   ├── websocket.js              # WebSocketClientInterface
│   │       │   └── webrtc.js                 # WebRTCInterface (wraps an RTCDataChannel)
│   │       ├── utils/                        # encoding, log, msgpack
│   │       └── index.js                      # public API exports
│   ├── node/                                 # Node-builtin interfaces + registry
│   │   └── src/
│   │       ├── interfaces/                   # auto, tcp, local_client, http_server, registry
│   │       ├── utils/                        # netinfo (node:os)
│   │       └── index.js
│   ├── webrtc-node/                          # werift-backed createPeerConnection
│   └── websocket-server-node/                # ws-backed WebSocketServerInterface
└── …
```

Dependency direction is one-way: every companion depends on `@reticulum/core`;
the core never depends on a companion.

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
