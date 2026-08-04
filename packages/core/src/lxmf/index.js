/**
 * LXMF (Lightweight Extensible Message Format) — public barrel.
 *
 * Asynchronous, store-and-forward messaging primitives: one-to-one messages,
 * the router, paper/QR messaging, and the propagation-node server.
 *
 * LXMF is intentionally NOT re-exported from the package root (`src/index.js`):
 * it is a sizable, server-leaning module and ESM eagerly evaluates the whole
 * static import graph, so re-exporting it would bloat
 * `import { Reticulum } from "@reticulum/core"` for browsers. Import it here
 * by subpath instead:
 *
 *   import { LXMessage, LXMRouter } from "@reticulum/core/src/lxmf/index.js";
 *
 * For the leanest possible graph, import a single symbol directly from its
 * module file (e.g. `.../lxmf/message.js`) — importing from this barrel pulls
 * in every LXMF module.
 */

export * as LXMFConstants from "./constants.js";
export { Message as LXMessage } from "./message.js";
export { MessageStore } from "./message_store.js";
export { LXMRouter } from "./router.js";
export { LXMPeer, PeerState } from "./peer.js";
export { PropagationNode } from "./propagation_node.js";
export * as LXStamper from "./stamper.js";
export {
  buildAnnounceAppData,
  buildPropagationNodeAppData,
  parseAnnounceAppData,
  parsePropagationNodeAppData,
} from "./announce_data.js";
export {
  packPropagationContainer,
  unpackPropagationContainer,
} from "./propagation.js";
