/**
 * @module @reticulum/core/src/utils/stamper.js
 * @description Generic LXMF-style proof-of-work stamp primitives, mirroring
 *   `LXMF/LXStamper.py` (verified against LXMF 1.0.1).
 *
 *   A stamp is a proof-of-work value that lets a recipient gate inbound
 *   traffic against unsolicited senders (LXMF §5.7). The workblock is built
 *   by memory-inflating the material through rounds of 256-byte HKDF, then a
 *   32-byte value is searched such that SHA256(workblock || stamp) starts
 *   with `target_cost` leading zero bits.
 *
 *   These primitives are LXMF-agnostic — the same machinery backs LXMF
 *   message stamps (work doc #35: `@reticulum/lxmf`), rfed channel stamps
 *   (`@reticulum/rfed`), and interface-discovery announces at their own
 *   expansion-round counts — which is why they live in core. The
 *   LXMF-specific validators (peering keys, propagation-node stamps) live in
 *   `@reticulum/lxmf`'s `stamper.js`, which re-exports these primitives under
 *   the `LXStamper` namespace for API continuity.
 *
 *   ## Pluggable engines (work doc #45)
 *
 *   The default engine is pure WebCrypto (WinterTC minimum common API only),
 *   so it runs everywhere — browsers included. On runtimes where WebCrypto
 *   hashing is slow (it re-hashes the entire workblock on every stamp
 *   trial), a platform package may install a faster engine via
 *   {@link setStamper} — e.g. `@reticulum/node`'s `node:crypto` engine with
 *   hash-state copying and worker-thread generation. The wire format and
 *   validation semantics are engine-invariant: any engine must produce
 *   byte-identical workblocks and agree on stamp validity.
 */

/* @ts-self-types="../../types/src/utils/stamper.d.ts" */

/**
 * Pluggable proof-of-work stamp engine. All methods are asynchronous and
 * return promises; semantics must match the WebCrypto default engine exactly
 * (byte-identical workblocks, identical validity boundary
 * `SHA256(workblock || stamp) <= 2^(256 - targetCost)`).
 *
 * @typedef {Object} StamperEngine
 * @property {(data: Uint8Array) => Promise<Uint8Array>} fullHash
 *   Computes SHA-256 of the input.
 * @property {(material: Uint8Array, expandRounds?: number) => Promise<Uint8Array>} stampWorkblock
 *   Builds the memory-hard workblock for the given material.
 * @property {(stamp: Uint8Array, targetCost: number, workblock: Uint8Array) => Promise<boolean>} stampValid
 *   Validates a stamp against a target proof-of-work cost.
 * @property {(workblock: Uint8Array, stamp: Uint8Array) => Promise<number>} stampValue
 *   Returns the leading-zero-bit value of a stamp.
 * @property {(messageId: Uint8Array, stampCost: number, expandRounds?: number) => Promise<[Uint8Array, number]>} generateStamp
 *   Searches for a valid 32-byte stamp, returning `[stamp, value]`.
 */

import { hkdf } from "../crypto/ciphers.js";

/**
 * Encodes a non-negative integer as MessagePack (positive fixint, uint8,
 * uint16, uint32, uint64). Used for the per-round stamp-workblock salt counter
 * so the workblock is byte-identical to the Python LXMF reference's at any
 * round count (rfed 16, LXMF PN 1000, LXMF message 3000).
 *
 * Exported so alternative {@link StamperEngine} implementations can build
 * byte-identical per-round salt inputs.
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
export function msgpackUint(n) {
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

// ---------------------------------------------------------------------
// Default engine: pure WebCrypto (WinterTC-only, browser-safe)
// ---------------------------------------------------------------------

/**
 * Computes SHA-256 of the input.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function webCryptoFullHash(data) {
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
async function webCryptoStampWorkblock(
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
    const salt = await webCryptoFullHash(saltInput);
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
 * Returns the number of leading zero bits in SHA256(workblock || stamp).
 *
 * This is the actual proof-of-work value achieved, which may exceed the
 * recipient's required cost.
 *
 * @param {Uint8Array} workblock
 * @param {Uint8Array} stamp
 * @returns {Promise<number>}
 */
async function webCryptoStampValue(workblock, stamp) {
  const material = new Uint8Array(workblock.length + stamp.length);
  material.set(workblock, 0);
  material.set(stamp, workblock.length);
  const hash = await webCryptoFullHash(material);
  const bits = 256;
  let value = 0;
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
 * `targetCost` is the required number of leading zero bits in
 * SHA256(workblock || stamp). A stamp with `targetCost = 8` is valid when the
 * hash is <= 2^248.
 *
 * @param {Uint8Array} stamp
 * @param {number} targetCost
 * @param {Uint8Array} workblock
 * @returns {Promise<boolean>}
 */
async function webCryptoStampValid(stamp, targetCost, workblock) {
  const material = new Uint8Array(workblock.length + stamp.length);
  material.set(workblock, 0);
  material.set(stamp, workblock.length);
  const result = await webCryptoFullHash(material);
  const target = 1n << BigInt(256 - targetCost);
  return bigIntFromBytesBE(result) <= target;
}

/**
 * Searches for a valid 32-byte stamp by random trial.
 *
 * @param {Uint8Array} messageId - The 32-byte LXMF message_id.
 * @param {number} stampCost - Required leading zero bits.
 * @param {number} [expandRounds] - HKDF expansion rounds for the workblock.
 * @returns {Promise<[Uint8Array, number]>} `[stamp, value]`.
 */
async function webCryptoGenerateStamp(
  messageId,
  stampCost,
  expandRounds = WORKBLOCK_EXPAND_ROUNDS,
) {
  const workblock = await webCryptoStampWorkblock(messageId, expandRounds);
  const stamp = new Uint8Array(STAMP_SIZE);
  while (true) {
    crypto.getRandomValues(stamp);
    if (await webCryptoStampValid(stamp, stampCost, workblock)) {
      const value = await webCryptoStampValue(workblock, stamp);
      return [stamp, value];
    }
  }
}

/** @type {StamperEngine} */
const webCryptoEngine = {
  fullHash: webCryptoFullHash,
  stampWorkblock: webCryptoStampWorkblock,
  stampValid: webCryptoStampValid,
  stampValue: webCryptoStampValue,
  generateStamp: webCryptoGenerateStamp,
};

// ---------------------------------------------------------------------
// Engine registry (work doc #45)
// ---------------------------------------------------------------------

/** @type {StamperEngine} */
let engine = webCryptoEngine;

/**
 * Returns the currently installed {@link StamperEngine}. The default is the
 * pure-WebCrypto engine; platform packages may replace it via
 * {@link setStamper}.
 *
 * @returns {StamperEngine}
 */
export function getStamper() {
  return engine;
}

/**
 * Installs a {@link StamperEngine} (or resets to the WebCrypto default with
 * `null`). Callers must pass an object providing all five engine functions;
 * otherwise a `TypeError` is thrown and the current engine is left untouched.
 *
 * This is an explicit opt-in: importing `@reticulum/core` never changes the
 * engine, and the default keeps the library browser-safe.
 *
 * @param {StamperEngine | null} next - The engine to install, or `null` to
 *   restore the WebCrypto default.
 * @returns {void}
 */
export function setStamper(next) {
  if (next === null) {
    engine = webCryptoEngine;
    return;
  }
  if (
    typeof next !== "object" ||
    next === null ||
    typeof next.fullHash !== "function" ||
    typeof next.stampWorkblock !== "function" ||
    typeof next.stampValid !== "function" ||
    typeof next.stampValue !== "function" ||
    typeof next.generateStamp !== "function"
  ) {
    throw new TypeError(
      "Stamper engine must provide fullHash, stampWorkblock, stampValid, stampValue and generateStamp functions",
    );
  }
  engine = next;
}

// ---------------------------------------------------------------------
// Public primitives — delegate to the installed engine
// ---------------------------------------------------------------------

/**
 * Computes SHA-256 of the input.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export function fullHash(data) {
  return engine.fullHash(data);
}

/**
 * Builds the memory-hard workblock used for stamp proof-of-work.
 *
 * @param {Uint8Array} material - The 32-byte message_id (or peering_id).
 * @param {number} [expandRounds] - Number of HKDF expansion rounds.
 * @returns {Promise<Uint8Array>} The concatenated workblock.
 */
export function stampWorkblock(material, expandRounds) {
  return engine.stampWorkblock(
    material,
    expandRounds === undefined ? WORKBLOCK_EXPAND_ROUNDS : expandRounds,
  );
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
export function stampValue(workblock, stamp) {
  return engine.stampValue(workblock, stamp);
}

/**
 * Validates a stamp against a target proof-of-work cost.
 *
 * @param {Uint8Array} stamp
 * @param {number} targetCost
 * @param {Uint8Array} workblock
 * @returns {Promise<boolean>}
 */
export function stampValid(stamp, targetCost, workblock) {
  return engine.stampValid(stamp, targetCost, workblock);
}

/**
 * Searches for a valid 32-byte stamp by random trial.
 *
 * @param {Uint8Array} messageId - The 32-byte LXMF message_id.
 * @param {number} stampCost - Required leading zero bits.
 * @param {number} [expandRounds] - HKDF expansion rounds for the workblock.
 * @returns {Promise<[Uint8Array, number]>} `[stamp, value]`.
 */
export function generateStamp(messageId, stampCost, expandRounds) {
  return engine.generateStamp(
    messageId,
    stampCost,
    expandRounds === undefined ? WORKBLOCK_EXPAND_ROUNDS : expandRounds,
  );
}
