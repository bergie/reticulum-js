/**
 * Reticulum Network System - JavaScript Implementation
 * Zero-dependency, EUPL-1.2 compliant protocol stack.
 */

export { Destination } from "./core/destination.js";
// --- 2. Cryptography & Identity ---
// Everything needed to create, load, and sign data as an RNS node.
export { Identity } from "./core/identity.js";
// Packet-level primitives: enums consumers reference when building packets/destinations.
export {
  ContextType,
  DestType,
  HeaderType,
  Packet,
  PacketType,
  TransportType,
} from "./core/packet.js";
export { Resource } from "./core/resource.js";
// --- 1. Core Orchestration ---
// The primary client class that wires the transport router, interfaces, and compression together.
export { Reticulum } from "./core/reticulum.js";
// --- 3. Network Interfaces ---
// The physical and virtual pathways into the mesh.
export { TCPClientInterface, TCPServerInterface } from "./interfaces/tcp.js";
export { Message as LXMessage } from "./lxmf/message.js";

// --- 5. LXMF (Lightweight Extensible Message Format) ---
// Asynchronous, store-and-forward messaging primitives.
export { LXMRouter } from "./lxmf/router.js";
// --- 4. Application Protocols (RPC & Streams) ---
// The primitives for building Yjs sync, rngit, and NomadNet layers.
export { Link } from "./transport/link.js";
export { fromHex, toHex } from "./utils/encoding.js";
// --- 6. Utilities ---
// Exposed purely for convenience if the caller needs them, but not strictly required.
export { MicroMsgPack as MsgPack } from "./utils/msgpack.js";
