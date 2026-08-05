/**
 * rfed (Reticulum Federation) — public barrel.
 *
 * Wire-compatible with the Rust `rfed` reference (protocol version 1).
 *
 * rfed is intentionally NOT re-exported from the package root (`src/index.js`):
 * it is a sizable, server-leaning module and ESM eagerly evaluates the whole
 * static import graph, so re-exporting it would bloat
 * `import { Reticulum } from "@reticulum/core"` for browsers. Import it here
 * by subpath instead:
 *
 *   import { RFedNode, BlobStore } from "@reticulum/core/src/rfed/index.js";
 *
 * For the leanest possible graph, import a single symbol directly from its
 * module file (e.g. `.../rfed/node.js`) — importing from this barrel pulls in
 * every rfed module.
 */

/* @ts-self-types="../../types/src/rfed/index.d.ts" */

export {
  parseFanoutPayload,
  parseSendPayload,
  unwrapChannelMessage,
  wrapChannelMessage,
} from "./blob.js";
export { BlobStore } from "./blob_store.js";
export { channelPath, deliveryHashFor, deriveChannel } from "./channel.js";
export { RFedClient } from "./client.js";
/** rfed protocol constants (magic, version, opcodes, …). */
export * as RFedConstants from "./constants.js";
export { DeferredQueue } from "./deferred_queue.js";
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
