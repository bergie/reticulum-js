/**
 * @file stamp.js
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
 * ⚠️ **Workblock divergence.** The SPEC defers to `LXStamper::stamp_workblock`,
 * expecting Python LXMF's memory-hard HKDF expansion (768 KiB at 3000 rounds,
 * 4 KiB at rfed's 16). However the **deployed `reticulum-rust` `LXStamper`
 * is an incompatible stub**: its workblock is just `SHA-256` iterated
 * `rounds + 1` times over the transient id — a 32-byte value, not the
 * memory-hard HKDF expansion. The value/stamp-valid semantics match Python
 * (leading-zero-bits of `SHA-256(workblock ‖ stamp)`), but the workblock bytes
 * differ, so stamps do **not** cross-validate.
 *
 * To interoperate with live rfed nodes (built from current `reticulum-rust`),
 * this module therefore mirrors the **reticulum-rust** workblock and nonce
 * search exactly. A corrective patch for `reticulum-rust/src/lxstamper.rs`
 * exists alongside this change (see the work document / changelog); once that
 * lands upstream, this module should revert to the memory-hard HKDF workblock
 * in `../lxmf/stamper.js`, which is already byte-compatible with Python LXMF.
 *
 * `stamp_cost` is owned by the `/rfed/subscribe` reply: a cost of `0` (or
 * `nil`) means stamping is disabled and no stamp is required or appended.
 *
 * See also https://github.com/jrl290/Reticulum-rust/pull/2
 */

import { Identity } from "../core/identity.js";
// The CORRECT, Python-LXMF-compatible memory-hard workblock. Imported so the
// switch in `computeWorkblock` below is a one-line flip once reticulum-rust
// fixes its `LXStamper` (see USE_RUST_STUB_WORKBLOCK).
import { stampWorkblock as lxmfStampWorkblock } from "../lxmf/stamper.js";
import { concatBytes } from "../utils/encoding.js";
import { STAMP_EXPAND_ROUNDS, STAMP_SIZE } from "./constants.js";

export { STAMP_SIZE };

/**
 * ⚠️ rfed workblock implementation switch — THE ONE PLACE TO CHANGE.
 *
 * The SPEC defers the workblock to `LXStamper::stamp_workblock`, expecting the
 * memory-hard HKDF expansion in `../lxmf/stamper.js` (byte-compatible with
 * Python LXMF). The **deployed** `reticulum-rust` `LXStamper` is an
 * incompatible stub (iterated SHA-256, 32 bytes), so rfed nodes built from it
 * reject SPEC-valid stamps.
 *
 * To interoperate with live nodes today we mirror the stub. Once the fix lands
 * upstream (https://github.com/jrl290/Reticulum-rust/pull/2), set this to
 * `false` (or delete it together with the `true` branch in `computeWorkblock`).
 *
 * The `false` branch is a one-liner over the already-tested `lxmfStampWorkblock`,
 * so it cannot silently bit-rot.
 */
const USE_RUST_STUB_WORKBLOCK = true;

/**
 * Mirrors the iteration cap in `reticulum-rust`'s `LXStamper::generate_stamp`.
 * Costs used by rfed (e.g. 12) terminate far below this (~2^cost trials).
 */
const STAMP_NONCE_CAP = 1_000_000n;

/**
 * Counts the number of leading zero bits in `data`.
 *
 * Matches `LXStamper::stamp_value`'s bit-counting loop (and Python LXMF's
 * `stamp_value`): 8 per all-zero byte, then `leading_zeros()` of the first
 * non-zero byte.
 *
 * @param {Uint8Array} data
 * @returns {number}
 */
function leadingZeroBits(data) {
  let value = 0;
  for (const byte of data) {
    if (byte === 0) {
      value += 8;
    } else {
      value += Math.clz32(byte) - 24;
      break;
    }
  }
  return value;
}

/**
 * Encodes a `bigint` as a 16-byte little-endian unsigned integer, matching
 * Rust's `u128::to_le_bytes` (the nonce width used by `compute_stamp`).
 *
 * @param {bigint} value
 * @returns {Uint8Array}
 */
function u128leBytes(value) {
  const bytes = new Uint8Array(16);
  let v = value;
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/**
 * Computes the rfed stamp workblock for a transient id.
 *
 * Branches on {@link USE_RUST_STUB_WORKBLOCK}:
 *   - `true` (current): mirrors the deployed `reticulum-rust` `LXStamper` —
 *     `SHA-256` iterated `rounds + 1` times over the transient id (32 bytes).
 *   - `false` (once the Rust PR lands): the SPEC-correct memory-hard HKDF
 *     expansion from `../lxmf/stamper.js`, byte-compatible with Python LXMF.
 *
 * @param {Uint8Array} transientId
 * @returns {Promise<Uint8Array>}
 */
async function computeWorkblock(transientId) {
  if (USE_RUST_STUB_WORKBLOCK) {
    let workblock = await Identity.fullHash(transientId);
    for (let i = 0; i < STAMP_EXPAND_ROUNDS; i++) {
      workblock = await Identity.fullHash(workblock);
    }
    return workblock;
  }
  return lxmfStampWorkblock(transientId, STAMP_EXPAND_ROUNDS);
}

/**
 * Computes the transient id and workblock for a channel stamp.
 *
 * `transientId = SHA-256(channel_hash ‖ inner_blob)`; the workblock comes from
 * {@link computeWorkblock}.
 *
 * @param {Uint8Array} channelHash - 16-byte channel identity hash.
 * @param {Uint8Array} innerBlob - EC-encrypted channel message (no stamp).
 * @returns {Promise<{ transientId: Uint8Array, workblock: Uint8Array }>}
 */
export async function channelStampWorkblock(channelHash, innerBlob) {
  const material = concatBytes(channelHash, innerBlob);
  const transientId = await Identity.fullHash(material);
  const workblock = await computeWorkblock(transientId);
  return { transientId, workblock };
}

/**
 * Leading-zero-bit value of a stamp over the given workblock, i.e.
 * `leadingZeroBits(SHA-256(workblock ‖ stamp))`. Matches
 * `LXStamper::stamp_value` / Python LXMF `stamp_value`.
 *
 * @param {Uint8Array} workblock
 * @param {Uint8Array} stamp
 * @returns {Promise<number>}
 */
async function stampValue(workblock, stamp) {
  const hash = await Identity.fullHash(concatBytes(workblock, stamp));
  return leadingZeroBits(hash);
}

/**
 * Searches for a valid 32-byte channel PoW stamp.
 *
 * Mirrors `reticulum-rust`'s `LXStamper::generate_stamp`: a stamp is
 * `SHA-256(workblock ‖ nonce_le16)` for an increasing `u128` nonce, accepted
 * once `stampValue(workblock, stamp) >= stampCost`.
 *
 * @param {Uint8Array} channelHash - 16-byte channel identity hash.
 * @param {Uint8Array} innerBlob - EC-encrypted channel message.
 * @param {number} stampCost - Required leading zero bits (rfed default 16).
 * @returns {Promise<[Uint8Array, number]>} `[stamp, achievedValue]`.
 * @throws if no stamp meets the cost within {@link STAMP_NONCE_CAP} trials.
 */
export async function generateChannelStamp(channelHash, innerBlob, stampCost) {
  const { workblock } = await channelStampWorkblock(channelHash, innerBlob);
  for (let nonce = 0n; nonce <= STAMP_NONCE_CAP; nonce++) {
    const stamp = await Identity.fullHash(
      concatBytes(workblock, u128leBytes(nonce)),
    );
    const value = await stampValue(workblock, stamp);
    if (value >= stampCost) {
      return [stamp, value];
    }
  }
  throw new Error(
    `rfed stamp generation exhausted ${STAMP_NONCE_CAP} trials at cost ${stampCost}`,
  );
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
  const value = await stampValue(workblock, stamp);
  return value >= stampCost;
}
