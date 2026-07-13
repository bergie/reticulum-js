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
    const counter = new Uint8Array([n]);
    // material || msgpack(n)  — umsgpack packs small non-negative ints as
    // positive fixint, so a single byte.
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
