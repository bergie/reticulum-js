/**
 * @module @reticulum/rfed
 * @description rfed (Reticulum Federation)
 *
 * Wire-compatible with the Rust `rfed` reference (protocol version 1).
 *
 * Depends on `@reticulum/lxmf` (message format, stamps) and
 * `@reticulum/core` (RNS stack). For the leanest possible graph, import a
 * single symbol from its module file (e.g. `@reticulum/rfed/src/node.js`) —
 * importing from this barrel pulls in every rfed module.
 */

/* @ts-self-types="../types/src/index.d.ts" */

export {
  parseFanoutPayload,
  parseSendPayload,
  unwrapChannelMessage,
  unwrapRawChannelMessage,
  wrapChannelMessage,
  wrapRawChannelMessage,
} from "./blob.js";
export { BlobStore } from "./blob_store.js";
export { channelPath, deliveryHashFor, deriveChannel } from "./channel.js";
export { RFedClient } from "./client.js";
/** rfed protocol constants (magic, version, opcodes, …). */
export * as RFedConstants from "./constants.js";
export { DeferredQueue } from "./deferred_queue.js";
export { FedSync } from "./fed_sync.js";
export { RFedNode } from "./node.js";
export {
  encodeWakePayload,
  NotifyRegistry,
  parseNotifyCommand,
  validateRelayHash,
} from "./notify.js";
export {
  channelStampWorkblock,
  generateChannelStamp,
  STAMP_SIZE as RFED_STAMP_SIZE,
  validateChannelStamp,
} from "./stamp.js";
export { SubscriptionTable } from "./subscription.js";
export {
  decodeBlobStream,
  encodeBlobStream,
  fullManifest,
  gapFromPeer,
} from "./sync.js";
