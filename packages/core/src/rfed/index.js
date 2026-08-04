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

export {
  parseFanoutPayload,
  parseSendPayload,
  unwrapChannelMessage,
  wrapChannelMessage,
} from "./blob.js";
export { channelPath, deliveryHashFor, deriveChannel } from "./channel.js";
export { RFedClient } from "./client.js";
export * as RFedConstants from "./constants.js";
export { BlobStore } from "./blob_store.js";
export { DeferredQueue } from "./deferred_queue.js";
export { RFedNode } from "./node.js";
export { SubscriptionTable } from "./subscription.js";
export {
  NotifyRegistry,
  encodeWakePayload,
  parseNotifyCommand,
  validateRelayHash,
} from "./notify.js";
export {
  decodeBlobStream,
  encodeBlobStream,
  fullManifest,
  gapFromPeer,
} from "./sync.js";
export {
  channelStampWorkblock,
  generateChannelStamp,
  STAMP_SIZE as RFED_STAMP_SIZE,
  validateChannelStamp,
} from "./stamp.js";
