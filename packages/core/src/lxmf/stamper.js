/**
 * @file stamper.js
 * @description LXMF proof-of-work stamps and tickets. Mirrors
 *   `LXMF/LXStamper.py` (verified against LXMF 1.0.1).
 *
 *   A stamp is a proof-of-work value that lets a recipient gate inbound
 *   messages against unsolicited senders (§5.7). The workblock is built by
 *   memory-inflating the message_id through 3000 rounds of 256-byte HKDF,
 *   then a 32-byte value is searched such that SHA256(workblock || stamp)
 *   starts with `target_cost` leading zero bits.
 */

import { hkdf } from "../crypto/ciphers.js";
import { LXMF_OVERHEAD } from "./constants.js";

/**
 * Encodes a non-negative integer as MessagePack, matching `umsgpack.packb` /
 * `msgpack.packb` for unsigned ints (positive fixint, uint8, uint16, uint32,
 * uint64). Used for the per-round stamp-workblock salt counter so the workblock
 * is byte-identical to Python LXMF's at any round count (rfed 16, LXMF PN 1000,
 * LXMF message 3000).
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function msgpackUint(n) {
  if (n < 0x80) return new Uint8Array([n]);
  if (n <= 0xff) return new Uint8Array([0xcc, n]);
  if (n <= 0xffff) return new Uint8Array([0xcd, (n >> 8) & 0xff, n & 0xff]);
  if (n <= 0xffffffff)
    return new Uint8Array([
      0xce,
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ]);
  // uint64 (big-endian)
  const out = new Uint8Array(9);
  out[0] = 0xcf;
  let v = BigInt(n);
  for (let i = 8; i >= 1; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Standard message-stamp HKDF expansion rounds (regular stamps). */
export const WORKBLOCK_EXPAND_ROUNDS = 3000;
/** Propagation-node stamp expansion rounds (cheaper — store-and-forward throttles). */
export const WORKBLOCK_EXPAND_ROUNDS_PN = 1000;
/** Peering-key expansion rounds (cheapest — between propagation nodes). */
export const WORKBLOCK_EXPAND_ROUNDS_PEERING = 25;
/** Stamp size in bytes: HASHLENGTH//8 = 256//8 = 32. */
export const STAMP_SIZE = 32;

/**
 * Computes SHA-256 of the input.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function fullHash(data) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    /** @type {any} */ (data),
  );
  return new Uint8Array(digest);
}

/**
 * Builds the memory-hard workblock used for stamp proof-of-work.
 *
 * Repeats `expandRounds` iterations, each producing 256 bytes of HKDF output
 * keyed on the material and salted with `SHA256(material || msgpack(n))`. With
 * the default 3000 rounds the workblock is 768 KiB — deliberately
 * cache-unfriendly to limit GPU/ASIC speedup.
 *
 * @param {Uint8Array} material - The 32-byte message_id (or peering_id).
 * @param {number} [expandRounds] - Number of HKDF expansion rounds.
 * @returns {Promise<Uint8Array>} The concatenated workblock.
 */
export async function stampWorkblock(
  material,
  expandRounds = WORKBLOCK_EXPAND_ROUNDS,
) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  for (let n = 0; n < expandRounds; n++) {
    // material || msgpack(n) — the per-round salt input. umsgpack.packb
    // encodes unsigned ints as positive fixint (<0x80), then uint8/16/32/64,
    // so the counter is multi-byte once n >= 128 (LXMF PN/message rounds).
    const counter = msgpackUint(n);
    const saltInput = new Uint8Array(material.length + counter.length);
    saltInput.set(material, 0);
    saltInput.set(counter, material.length);
    const salt = await fullHash(saltInput);
    const derived = await hkdf(material, salt, new Uint8Array(0), 256);
    chunks.push(derived);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const workblock = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    workblock.set(c, offset);
    offset += c.length;
  }
  return workblock;
}

/**
 * Converts a big-endian byte array into a BigInt.
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
function bigIntFromBytesBE(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

/**
 * Returns the number of leading zero bits in SHA256(workblock || stamp).
 *
 * This is the actual proof-of-work value achieved, which may exceed the
 * recipient's required cost.
 *
 * @param {Uint8Array} workblock
 * @param {Uint8Array} stamp
 * @returns {Promise<number>}
 */
export async function stampValue(workblock, stamp) {
  const material = new Uint8Array(workblock.length + stamp.length);
  material.set(workblock, 0);
  material.set(stamp, workblock.length);
  const hash = await fullHash(material);
  let value = 0;
  const bits = 256;
  let i = bigIntFromBytesBE(hash);
  const highBit = 1n << BigInt(bits - 1);
  while ((i & highBit) === 0n) {
    i = i << 1n;
    value += 1;
  }
  return value;
}

/**
 * Validates a stamp against a target proof-of-work cost.
 *
 * `target_cost` is the required number of leading zero bits in
 * SHA256(workblock || stamp). A stamp with `target_cost = 8` is valid when the
 * hash is <= 2^248.
 *
 * @param {Uint8Array} stamp
 * @param {number} targetCost
 * @param {Uint8Array} workblock
 * @returns {Promise<boolean>}
 */
export async function stampValid(stamp, targetCost, workblock) {
  const material = new Uint8Array(workblock.length + stamp.length);
  material.set(workblock, 0);
  material.set(stamp, workblock.length);
  const result = await fullHash(material);
  const target = 1n << BigInt(256 - targetCost);
  return bigIntFromBytesBE(result) <= target;
}

/**
 * Searches for a valid 32-byte stamp by random trial.
 *
 * @param {Uint8Array} messageId - The 32-byte LXMF message_id.
 * @param {number} stampCost - Required leading zero bits.
 * @param {number} [expandRounds] - HKDF expansion rounds for the workblock.
 * @returns {Promise<[Uint8Array, number]|null>} `[stamp, value]` or null.
 */
export async function generateStamp(
  messageId,
  stampCost,
  expandRounds = WORKBLOCK_EXPAND_ROUNDS,
) {
  const workblock = await stampWorkblock(messageId, expandRounds);
  const stamp = new Uint8Array(STAMP_SIZE);
  while (true) {
    crypto.getRandomValues(stamp);
    if (await stampValid(stamp, stampCost, workblock)) {
      const value = await stampValue(workblock, stamp);
      return [stamp, value];
    }
  }
}

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
