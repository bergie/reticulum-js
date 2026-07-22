/**
 * Reticulum Network System - JavaScript Implementation
 * Zero-dependency, EUPL-1.2 compliant protocol stack.
 */

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
// Interface classes are NOT re-exported here: several of them pull in
// Node.js builtins (`node:net`, `node:dgram`, `node:http`, ...) at module
// top level, and ESM eagerly evaluates the whole static import graph — so
// re-exporting them here would make `import { Reticulum } from "reticulum-js"`
// fail in browsers. Import the interface you need directly by subpath, e.g.:
//   import { TCPClientInterface } from "reticulum-js/src/interfaces/tcp.js";
// The interface registry (`src/interfaces/registry.js`) is likewise Node-only
// (it imports every interface) and must be imported by subpath as well.
export * as LXMFConstants from "./lxmf/constants.js";
// --- 5. LXMF (Lightweight Extensible Message Format) ---
// Asynchronous, store-and-forward messaging primitives.
export { Message as LXMessage } from "./lxmf/message.js";
export { LXMRouter } from "./lxmf/router.js";
export * as LXStamper from "./lxmf/stamper.js";
// Web Stream byte-stream adapters over a Channel (RNS/Buffer.py). Importing
// this also wires channel.openReadable / openWritable / openDuplex.
export {
  openDuplex,
  openReadable,
  openWritable,
} from "./transport/buffer.js";
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
  StreamDataMessage,
  SystemMessageTypes,
} from "./transport/channel.js";

import "./transport/buffer.js";

// --- Interface discovery (consumer side; work doc #17) ---
// Listens for `rnstransport.discovery.interface` announces so a leaf can find
// connectable transport-node interfaces on the mesh.
export {
  ACCEPTED_INTERFACE_TYPES,
  APP_NAME as DISCOVERY_APP_NAME,
  ASPECT as DISCOVERY_ASPECT,
  aspectNameHash,
  buildConfigEntry as buildDiscoveryConfigEntry,
  buildDiscoveryAppData,
  DEFAULT_STAMP_VALUE as DISCOVERY_DEFAULT_STAMP_VALUE,
  DISCOVERABLE_TYPES,
  FLAG_ENCRYPTED as DISCOVERY_FLAG_ENCRYPTED,
  FLAG_SIGNED as DISCOVERY_FLAG_SIGNED,
  generateDiscoveryStamp,
  InterfaceDiscovery,
  isHostname,
  isIpAddress,
  parseDiscoveryAnnounce,
  STATUS_AVAILABLE as DISCOVERY_STATUS_AVAILABLE,
  STATUS_STALE as DISCOVERY_STATUS_STALE,
  STATUS_UNKNOWN as DISCOVERY_STATUS_UNKNOWN,
  sanitizeName as sanitizeDiscoveryName,
  THRESHOLD_REMOVE as DISCOVERY_THRESHOLD_REMOVE,
  THRESHOLD_STALE as DISCOVERY_THRESHOLD_STALE,
  THRESHOLD_UNKNOWN as DISCOVERY_THRESHOLD_UNKNOWN,
  WORKBLOCK_EXPAND_ROUNDS as DISCOVERY_WORKBLOCK_EXPAND_ROUNDS,
} from "./transport/discovery.js";
export { Link } from "./transport/link.js";
export {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  fromHex,
  toHex,
} from "./utils/encoding.js";
// --- Logging control (work doc #21) ---
// Browser-safe (only defensive globalThis + console.log). The threshold can
// also be set declaratively via `Reticulum({ logLevel })` or the
// `RETICULUM_LOG_LEVEL` env var; these let an app read/change it at runtime.
export {
  getLogLevel,
  LOG_LEVEL_ENV,
  LogLevel,
  parseLogLevel,
  setLogLevel,
} from "./utils/log.js";
// --- 6. Utilities ---
// Exposed purely for convenience if the caller needs them, but not strictly required.
export { MicroMsgPack as MsgPack } from "./utils/msgpack.js";
// --- WebRTC transport upgrade (work doc #19) ---
// Browser-safe signaling orchestrator. Dependency-injection-first: pass a
// `createPeerConnection` factory (Node.js needs the companion package; the
// browser global is auto-detected). The `WebRTCInterface` itself lives in
// `src/interfaces/webrtc.js` and is created programmatically by this
// orchestrator once a data channel opens.
export {
  CAPABILITY_FLAG as WEBRTC_CAPABILITY_FLAG,
  CHANNEL_LABEL as WEBRTC_CHANNEL_LABEL,
  DEFAULT_DESTINATION_NAME as WEBRTC_DEFAULT_DESTINATION_NAME,
  MAX_SDP_SIZE as WEBRTC_MAX_SDP_SIZE,
  SDP_TYPE_ANSWER as WEBRTC_SDP_TYPE_ANSWER,
  SDP_TYPE_CANDIDATE as WEBRTC_SDP_TYPE_CANDIDATE,
  SDP_TYPE_OFFER as WEBRTC_SDP_TYPE_OFFER,
  WebRTCSignaling,
} from "./webrtc/signaling.js";
