/**
 * @file propagation.js
 * @description LXMF propagation submit/sync container packing (§5.3).
 *
 * When a client submits messages to a propagation node — or peers sync — the
 * payload sent over the link is the `propagation_packed` container
 * (`LXMessage.propagation_packed` in the Python reference):
 *
 *   msgpack([ send_time_float, [ lxmf_data, ... ] ])
 *
 * Each `lxmf_data` is the per-message propagation form produced by
 * {@link Message.toPropagationData}. The node unpacks this in
 * `LXMRouter.propagation_resource_concluded` and ingests each entry via
 * `lxmf_propagation`.
 */

import { MicroMsgPack } from "../utils/msgpack.js";

/**
 * Parsed propagation container.
 *
 * @typedef {Object} PropagationContainer
 * @property {number} sendTime Originator send time (unix seconds, float).
 * @property {Uint8Array[]} messages List of `lxmf_data` blobs.
 */

/**
 * Packs a propagation submit/sync container: `msgpack([sendTime, [lxmfData...]])`.
 *
 * @param {Uint8Array[]} lxmfDataList One or more `lxmf_data` blobs.
 * @param {number} [sendTime=Date.now()/1000] Originator send time (unix sec).
 * @returns {Uint8Array}
 */
export function packPropagationContainer(
  lxmfDataList,
  sendTime = Date.now() / 1000,
) {
  return MicroMsgPack.encode([sendTime, lxmfDataList]);
}

/**
 * Unpacks a propagation submit/sync container.
 *
 * @param {Uint8Array} bytes
 * @returns {PropagationContainer|null} `null` if the bytes are not the
 *   expected `[float, [bin...]]` shape.
 */
export function unpackPropagationContainer(bytes) {
  let value;
  try {
    value = MicroMsgPack.decode(bytes);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length < 2) return null;
  const sendTime = typeof value[0] === "number" ? value[0] : 0;
  const messages = Array.isArray(value[1]) ? value[1] : [];
  return { sendTime, messages };
}
