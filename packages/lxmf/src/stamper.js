/**
 * @file stamper.js
 * @description LXMF-specific proof-of-work stamp validators, mirroring
 *   `LXMF/LXStamper.py` (verified against LXMF 1.0.1).
 *
 *   The generic stamp primitives (workblock expansion, value search,
 *   validation, generation) live in `@reticulum/core`'s
 *   `utils/stamper.js` — they are shared with rfed and interface discovery —
 *   and are re-exported here so the `LXStamper` namespace keeps its
 *   historical shape. What stays in this module are the validators that
 *   understand LXMF wire formats: propagation-node peering keys and
 *   propagation blobs.
 */

import {
  fullHash,
  STAMP_SIZE,
  stampValid,
  stampValue,
  stampWorkblock,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
  WORKBLOCK_EXPAND_ROUNDS_PN,
} from "@reticulum/core/src/utils/stamper.js";
import { LXMF_OVERHEAD } from "./constants.js";

export {
  generateStamp,
  STAMP_SIZE,
  stampValid,
  stampValue,
  stampWorkblock,
  WORKBLOCK_EXPAND_ROUNDS,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
  WORKBLOCK_EXPAND_ROUNDS_PN,
} from "@reticulum/core/src/utils/stamper.js";

/**
 * Validates a peering key between two propagation nodes (§5.8.4).
 *
 * The peering_id is `receiving_identity.hash || offering_identity.hash`
 * (32 bytes), and the workblock uses the cheaper peering expansion rounds.
 *
 * @param {Uint8Array} peeringId - `receiving_hash || offering_hash` (32 bytes).
 * @param {Uint8Array} peeringKey - The 32-byte candidate peering key.
 * @param {number} targetCost - Required leading zero bits.
 * @returns {Promise<boolean>}
 */
export async function validatePeeringKey(peeringId, peeringKey, targetCost) {
  const workblock = await stampWorkblock(
    peeringId,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  return stampValid(peeringKey, targetCost, workblock);
}

/**
 * A propagation blob split into its base `lxmf_data` and the trailing stamp,
 * with the derived `transient_id` and validated stamp value.
 *
 * @typedef {Object} ValidatedPnStamp
 * @property {Uint8Array} transientId SHA-256(lxmfData) — the store/dedup key.
 * @property {Uint8Array} lxmfData Base `dest_hash || E(...)` (stamp stripped).
 * @property {Uint8Array} stampData The trailing 32-byte stamp.
 * @property {number} stampValue Leading-zero-bit value of the stamp.
 */

/**
 * Validates a single propagation-node stamp from a received propagation blob
 * (`LXStamper.validate_pn_stamp`). The blob is `lxmf_data || stamp`; the
 * trailing {@link STAMP_SIZE} bytes are the stamp and `transient_id` is
 * SHA-256 over the base `lxmf_data` (so it is stable across stamp changes).
 *
 * @param {Uint8Array} transientData The propagation blob (lxmf_data + stamp).
 * @param {number} targetCost Minimum required stamp value (leading zero bits).
 * @returns {Promise<ValidatedPnStamp|null>} `null` when the blob is too short
 *   or the stamp does not meet `targetCost`.
 */
export async function validatePnStamp(transientData, targetCost) {
  if (transientData.length <= LXMF_OVERHEAD + STAMP_SIZE) return null;
  const lxmfData = transientData.subarray(0, transientData.length - STAMP_SIZE);
  const stampData = transientData.subarray(transientData.length - STAMP_SIZE);
  const transientId = await fullHash(lxmfData);
  const workblock = await stampWorkblock(
    transientId,
    WORKBLOCK_EXPAND_ROUNDS_PN,
  );
  if (!(await stampValid(stampData, targetCost, workblock))) return null;
  const value = await stampValue(workblock, stampData);
  return { transientId, lxmfData, stampData, stampValue: value };
}

/**
 * Validates a list of propagation blobs (`LXStamper.validate_pn_stamps`),
 * dropping any whose stamp is missing or below `targetCost`.
 *
 * @param {Uint8Array[]} transientList
 * @param {number} targetCost
 * @returns {Promise<ValidatedPnStamp[]>}
 */
export async function validatePnStamps(transientList, targetCost) {
  /** @type {ValidatedPnStamp[]} */
  const out = [];
  for (const td of transientList) {
    const v = await validatePnStamp(td, targetCost);
    if (v) out.push(v);
  }
  return out;
}
