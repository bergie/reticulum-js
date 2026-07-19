/**
 * Reticulum Network System - JavaScript Implementation
 * Zero-dependency, EUPL-1.2 compliant protocol stack.
 */

// Reticulum config discovery (shared-instance port/transport, Python `~/.reticulum/config`).
export {
  getSharedInstanceEndpoint,
  loadConfig,
  parseConfigFile,
  resolveConfigDir,
} from "./core/config.js";
export { Allow, Destination } from "./core/destination.js";
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
export { PacketReceipt, ReceiptStatus } from "./core/packet_receipt.js";
export { Resource, ResourceStatus } from "./core/resource.js";
export {
  ResourceAdvertisement,
  ResourceFlag,
} from "./core/resource_advertisement.js";
// --- 1. Core Orchestration ---
// The primary client class that wires the transport router, interfaces, and compression together.
export { Reticulum } from "./core/reticulum.js";
// --- 3. Network Interfaces ---
// The physical and virtual pathways into the mesh.
export { AutoInterface } from "./interfaces/auto.js";
export { HttpPostClientInterface } from "./interfaces/http.js";
export { HttpPostServerInterface } from "./interfaces/http_server.js";
export { LocalClientInterface } from "./interfaces/local_client.js";
// Interface discovery: enumerate available interfaces and their configuration
// schemas for dynamically-generated setup UIs.
export {
  getInterface,
  getSchema,
  listInterfaces,
  registerInterface,
} from "./interfaces/registry.js";
export { TCPClientInterface, TCPServerInterface } from "./interfaces/tcp.js";
export {
  WebSocketClientInterface,
  WebSocketServerInterface,
} from "./interfaces/websocket.js";
export * as LXMFConstants from "./lxmf/constants.js";
// --- 5. LXMF (Lightweight Extensible Message Format) ---
// Asynchronous, store-and-forward messaging primitives.
export { Message as LXMessage } from "./lxmf/message.js";
export { LXMRouter } from "./lxmf/router.js";
export * as LXStamper from "./lxmf/stamper.js";
// --- 4. Application Protocols (RPC & Streams) ---
// The primitives for building Yjs sync, rngit, and NomadNet layers.
export {
  CEType,
  Channel,
  ChannelException,
  Envelope,
  LinkChannelOutlet,
  MessageBase,
  MessageState,
  SystemMessageTypes,
} from "./transport/channel.js";
export { Link } from "./transport/link.js";
export {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  fromHex,
  toHex,
} from "./utils/encoding.js";
// --- 6. Utilities ---
// Exposed purely for convenience if the caller needs them, but not strictly required.
export { MicroMsgPack as MsgPack } from "./utils/msgpack.js";
