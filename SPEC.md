# Reticulum Network System: JavaScript Implementation Specification (RETICULUM-JS)

## 1. Architectural Overview & Objectives

This document outlines the technical specification for a clean-room, zero-dependency JavaScript implementation of the Reticulum Network System (RNS).

The architecture is strictly bound to native ES6 modules, `Uint8Array`, `DataView`, and the Web Crypto API. By avoiding NPM runtime dependencies entirely, the resulting codebase can stay in working order for the years to come, and is less susceptible to supply-chain vulnerabilities.

This implementation is optimized to operate as a "leaf node" transport layer. Functionality needed for building Reticulum Transport nodes in JavaScript may be added later.

### Reference

See `PROTOCOL-SPEC.md` for a non-canonical but hopefully helpful protocol specification.

The canonical specification is the Reticulum Network Python implementation which can be found in the `Reticulum/RNS` folder.

When the two disagree, the Python implementation is correct.

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
│   │   ├── framer.js      # TransformStreams for TCP/WS chunk slicing
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

Because TCP and WebSockets are stream-based, raw binary chunks are piped through a `TransformStream` that reassembles partial bytes into complete RNS packets before yielding them to the transport layer.

```javascript
export class RNSFramerStream extends TransformStream {
    constructor() {
        let buffer = new Uint8Array(0);
        super({
            transform(chunk, controller) {
                // Concatenate incoming chunk
                const combined = new Uint8Array(buffer.length + chunk.length);
                combined.set(buffer);
                combined.set(chunk, buffer.length);
                buffer = combined;

                // Slice and yield complete packets based on header length checks
                while (buffer.length >= 2) {
                    const expectedLength = parsePacketLength(buffer); 
                    if (buffer.length >= expectedLength) {
                        controller.enqueue(buffer.slice(0, expectedLength));
                        buffer = buffer.slice(expectedLength);
                    } else break; 
                }
            }
        });
    }
}

```

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
