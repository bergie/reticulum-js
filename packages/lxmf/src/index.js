/**
 * @module @reticulum/lxmf
 * @description LXMF (Lightweight Extensible Message Format)
 *
 * Asynchronous, store-and-forward messaging primitives: one-to-one messages,
 * the router, paper/QR messaging, and the propagation-node server.
 *
 * Depends on `@reticulum/core` for the RNS stack (destinations, packets,
 * links, resources). For the leanest possible graph, import a single symbol
 * from its module file (e.g. `@reticulum/lxmf/src/message.js`) — importing
 * from this barrel pulls in every LXMF module.
 */

/* @ts-self-types="../types/src/index.d.ts" */

export {
  buildAnnounceAppData,
  buildPropagationNodeAppData,
  parseAnnounceAppData,
  parsePropagationNodeAppData,
} from "./announce_data.js";
/** LXMF protocol constants (`fields`, `states`, `OPORTUNISTIC_*`, …). */
export * as LXMFConstants from "./constants.js";
export { Message as LXMessage } from "./message.js";
export { MessageStore } from "./message_store.js";
export { LXMPeer, PeerState } from "./peer.js";
export {
  packPropagationContainer,
  unpackPropagationContainer,
} from "./propagation.js";
export { PropagationNode } from "./propagation_node.js";
export { LXMRouter } from "./router.js";
/** LXMF stamping (LXST) protocol constants and helpers. */
export * as LXStamper from "./stamper.js";
