/**
 * @module reticulum-js-webrtc-node
 * @description reticulum-js-webrtc-node — Node.js WebRTC support for the
 *   zero-dependency, browser-safe `reticulum-js` core.
 *
 * Node.js has no native `RTCPeerConnection`. The core's `WebRTCSignaling`
 * (in `reticulum-js`) is dependency-injection-first: it accepts a
 * `createPeerConnection` factory and only falls back to the browser global.
 * This package supplies that factory, backed by
 * [werift](https://github.com/shinyoshiaki/werift), closing the loop for Node:
 *
 * ```js
 * import { WebRTCSignaling } from "reticulum-js";
 * import { createPeerConnection } from "reticulum-js-webrtc-node";
 *
 * const signaling = new WebRTCSignaling({ rns, createPeerConnection });
 * ```
 */

import { RTCPeerConnection } from "werift";

export { RTCPeerConnection };

/**
 * Factory returning a new werift `RTCPeerConnection`, suitable as the
 * `createPeerConnection` option to
 * {@link import("reticulum-js/src/webrtc/signaling.js").WebRTCSignaling}.
 *
 * The returned object is duck-compatible with the `RTCPeerConnection` shape the
 * core's WebRTC transport expects (`createDataChannel`, `createOffer`,
 * `createAnswer`, `setLocalDescription`, `setRemoteDescription`,
 * `addIceCandidate`, `close`, …), so it can be used wherever the browser global
 * would be.
 *
 * @param {ConstructorParameters<typeof RTCPeerConnection>[0]} [config] -
 *   Optional werift configuration, e.g. `{ iceServers }` for STUN/TURN.
 * @returns {RTCPeerConnection}
 */
export function createPeerConnection(config) {
  return new RTCPeerConnection(config);
}
