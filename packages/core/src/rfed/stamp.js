/**
 * @module stamp
 * @description rfed channel proof-of-work stamp contract.
 *
 * A rfed SEND payload ends with an optional 32-byte proof-of-work stamp bound
 * to the bytes it accompanies. The stamp material and value semantics are fixed
 * by `RFed/SPEC.md` "PoW STAMP CONTRACT":
 * ```
 * material     = channel_hash(16) ‖ inner_blob     // i.e. payload[..len-STAMP_SIZE]
 * transient_id = SHA-256(material)
 * workblock    = LXStamper::stamp_workblock(transient_id, STAMP_EXPAND_ROUNDS=16)
 * value        = leading_zero_bits(SHA-256(workblock ‖ stamp))
 * valid        = value >= stamp_cost
 * ```
 *
 * The workblock, stamp generation, and validation semantics are the standard
 * LXMF ones from `../lxmf/stamper.js` (byte-compatible with Python LXMF's
 * `LXStamper`), run at rfed's 16 expansion rounds. This module is a thin
 * wrapper that locks the rfed material layout (`channel_hash ‖ inner_blob`)
 * and constants. (An interim incompatibility in `reticulum-rust`'s `LXStamper`
 * once required mirroring an iterated-SHA-256 stub workblock; it was fixed
 * upstream in https://github.com/jrl290/Reticulum-rust/pull/2.)
 *
 * `stamp_cost` is owned by the `/rfed/subscribe` reply: a cost of `0` (or
 * `nil`) means stamping is disabled and no stamp is required or appended.
 */

import { Identity } from "../core/identity.js";
import {
  generateStamp as lxmfGenerateStamp,
  stampValid as lxmfStampValid,
  stampWorkblock as lxmfStampWorkblock,
} from "../lxmf/stamper.js";
import { concatBytes } from "../utils/encoding.js";
import { STAMP_EXPAND_ROUNDS, STAMP_SIZE } from "./constants.js";

export { STAMP_SIZE };

/**
 * Computes the transient id and workblock for a channel stamp.
 *
 * `transientId = SHA-256(channel_hash ‖ inner_blob)`; the workblock is the
 * standard LXMF memory-hard HKDF expansion at rfed's 16 rounds
 * (`STAMP_EXPAND_ROUNDS × 256` bytes).
 *
 * @param {Uint8Array} channelHash - 16-byte channel identity hash.
 * @param {Uint8Array} innerBlob - EC-encrypted channel message (no stamp).
 * @returns {Promise<{ transientId: Uint8Array, workblock: Uint8Array }>}
 */
export async function channelStampWorkblock(channelHash, innerBlob) {
  const material = concatBytes(channelHash, innerBlob);
  const transientId = await Identity.fullHash(material);
  const workblock = await lxmfStampWorkblock(transientId, STAMP_EXPAND_ROUNDS);
  return { transientId, workblock };
}

/**
 * Searches for a valid 32-byte channel PoW stamp.
 *
 * Thin wrapper over the LXMF `generateStamp` random-trial search, keyed on the
 * transient id of `channel_hash ‖ inner_blob` and expanded at rfed's 16
 * rounds. Returns `[stamp, achievedValue]` once
 * `stampValue(workblock, stamp) >= stampCost`.
 *
 * @param {Uint8Array} channelHash - 16-byte channel identity hash.
 * @param {Uint8Array} innerBlob - EC-encrypted channel message.
 * @param {number} stampCost - Required leading zero bits (rfed default 16).
 * @returns {Promise<[Uint8Array, number]>} `[stamp, achievedValue]`.
 */
export async function generateChannelStamp(channelHash, innerBlob, stampCost) {
  const { transientId } = await channelStampWorkblock(channelHash, innerBlob);
  const [stamp, value] = await lxmfGenerateStamp(
    transientId,
    stampCost,
    STAMP_EXPAND_ROUNDS,
  );
  return [stamp, value];
}

/**
 * Validates a channel PoW stamp against a required cost.
 *
 * @param {Uint8Array} channelHash - 16-byte channel identity hash.
 * @param {Uint8Array} innerBlob - EC-encrypted channel message.
 * @param {Uint8Array} stamp - 32-byte candidate stamp.
 * @param {number} stampCost - Minimum required leading zero bits.
 * @returns {Promise<boolean>}
 */
export async function validateChannelStamp(
  channelHash,
  innerBlob,
  stamp,
  stampCost,
) {
  if (stamp.length < STAMP_SIZE) return false;
  const { workblock } = await channelStampWorkblock(channelHash, innerBlob);
  return lxmfStampValid(stamp, stampCost, workblock);
}
