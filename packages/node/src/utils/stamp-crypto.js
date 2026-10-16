/**
 * @file stamp-crypto.js
 * @description Synchronous `node:crypto` primitives for the fast stamp
 *   engine (work doc #45). These mirror the WebCrypto default engine in
 *   `@reticulum/core`'s `utils/stamper.js` byte-for-byte — the workblock is
 *   identical, and stamp validity uses the same boundary semantics
 *   (`SHA256(workblock || stamp) <= 2^(256 - targetCost)`, exactly as the
 *   Python `LXStamper` reference — note this is subtly different from pure
 *   leading-zero-bit counting at the boundary value) — but run 1–2 orders of
 *   magnitude faster by:
 *
 *   - using OpenSSL's SHA-256 (`createHash`), which avoids re-hashing the
 *     whole workblock per stamp trial via `hash.copy()` + `update(stamp)`;
 *   - avoiding all BigInt/hex round-trips (bytewise digest comparison);
 *   - building the workblock with `hkdfSync` instead of three async
 *     WebCrypto calls per round.
 *
 *   Everything here is synchronous so it can run inside a worker thread
 *   (`stamp-worker.js`) without holding the host event loop.
 */

/* @ts-self-types="../../types/src/utils/stamp-crypto.d.ts" */

import { createHash, hkdfSync, randomBytes, randomFillSync } from "node:crypto";
import {
  msgpackUint,
  WORKBLOCK_EXPAND_ROUNDS,
} from "@reticulum/core/src/utils/stamper.js";

/**
 * Computes SHA-256 of the input.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function fullHashSync(data) {
  return createHash("sha256").update(data).digest();
}

/**
 * Builds the memory-hard workblock, byte-identical to the WebCrypto default
 * engine's (each round: `SHA256(material || msgpack(n))` salt, then 256 bytes
 * of HKDF output keyed on the material).
 *
 * @param {Uint8Array} material - The 32-byte message_id (or peering_id).
 * @param {number} [expandRounds] - Number of HKDF expansion rounds.
 * @returns {Uint8Array} The concatenated workblock.
 */
export function stampWorkblockSync(
  material,
  expandRounds = WORKBLOCK_EXPAND_ROUNDS,
) {
  const workblock = new Uint8Array(expandRounds * 256);
  for (let n = 0; n < expandRounds; n++) {
    const counter = msgpackUint(n);
    const salt = createHash("sha256").update(material).update(counter).digest();
    const derived = new Uint8Array(
      // hkdfSync(digest, ikm, salt, info, keylen) — matches the default
      // engine's hkdf(material, salt, empty, 256) call exactly. Returns an
      // ArrayBuffer, so wrap it for the workblock copy.
      hkdfSync("sha256", material, salt, new Uint8Array(0), 256),
    );
    workblock.set(derived, n * 256);
  }
  return workblock;
}

/**
 * Computes the 32-byte big-endian encoding of the validity threshold
 * `2^(256 - targetCost)`.
 *
 * @param {number} targetCost - Required leading zero bits (1..256).
 * @returns {Uint8Array}
 */
export function stampTargetBytes(targetCost) {
  if (!Number.isInteger(targetCost) || targetCost < 1 || targetCost > 256) {
    throw new RangeError(
      `targetCost must be an integer in 1..256, got ${targetCost}`,
    );
  }
  const target = new Uint8Array(32);
  // Bit (256 - targetCost) counted from the least significant bit, i.e. the
  // byte at index floor((targetCost - 1) / 8) from the most significant byte,
  // bit (targetCost - 1) % 8 within that byte (MSB-first).
  const byteIndex = Math.floor((targetCost - 1) / 8);
  const bitInByte = (targetCost - 1) % 8;
  target[byteIndex] = 1 << (7 - bitInByte);
  return target;
}

/**
 * Bytewise big-endian comparison: `a <= b` for equal-length digests.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function digestLessOrEqual(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}

/**
 * Counts the leading zero bits of a digest.
 *
 * @param {Uint8Array} hash
 * @returns {number}
 */
function leadingZeroBits(hash) {
  let value = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i];
    if (byte === 0) {
      value += 8;
      continue;
    }
    // Math.clz32(byte) = 24 + (leading zeros within the byte).
    value += Math.clz32(byte) - 24;
    break;
  }
  return value;
}

/**
 * Validates a stamp against a target proof-of-work cost, identically to the
 * default engine's `stampValid` (`SHA256(workblock || stamp) <= 2^(256 -
 * targetCost)`).
 *
 * @param {Uint8Array} stamp
 * @param {number} targetCost
 * @param {Uint8Array} workblock
 * @returns {boolean}
 */
export function stampValidSync(stamp, targetCost, workblock) {
  if (targetCost <= 0) return true;
  const hash = createHash("sha256").update(workblock).update(stamp).digest();
  return digestLessOrEqual(hash, stampTargetBytes(targetCost));
}

/**
 * Returns the number of leading zero bits in SHA256(workblock || stamp),
 * identically to the default engine's `stampValue`.
 *
 * @param {Uint8Array} workblock
 * @param {Uint8Array} stamp
 * @returns {number}
 */
export function stampValueSync(workblock, stamp) {
  const hash = createHash("sha256").update(workblock).update(stamp).digest();
  return leadingZeroBits(hash);
}

/** Random-byte pool size for stamp trials (64 trials per refill). */
const STAMP_POOL_SIZE = 64 * 32;

/**
 * Searches for a valid 32-byte stamp by random trial, using `hash.copy()` so
 * each trial only hashes the 32-byte stamp instead of the entire workblock.
 * Mathematically identical to hashing `workblock || stamp` per trial.
 *
 * @param {Uint8Array} messageId - The 32-byte message_id (or peering_id).
 * @param {number} stampCost - Required leading zero bits.
 * @param {number} [expandRounds] - HKDF expansion rounds for the workblock.
 * @returns {[Uint8Array, number]} `[stamp, value]`.
 */
export function generateStampSync(
  messageId,
  stampCost,
  expandRounds = WORKBLOCK_EXPAND_ROUNDS,
) {
  const workblock = stampWorkblockSync(messageId, expandRounds);
  const base = createHash("sha256").update(workblock);
  const target = stampTargetBytes(stampCost);
  const pool = randomBytes(STAMP_POOL_SIZE);
  let poolOffset = pool.length;
  while (true) {
    if (poolOffset + 32 > pool.length) {
      randomFillSync(pool);
      poolOffset = 0;
    }
    const trial = pool.subarray(poolOffset, poolOffset + 32);
    poolOffset += 32;
    const hash = base.copy().update(trial).digest();
    if (digestLessOrEqual(hash, target)) {
      // Copy out of the pool: the pool is reused (and overwritten) by later
      // trials, so the returned stamp must own its memory.
      return [new Uint8Array(trial), leadingZeroBits(hash)];
    }
  }
}
