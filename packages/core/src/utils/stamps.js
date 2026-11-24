/**
 * @module @reticulum/core/src/utils/stamps.js
 * @description RNS 1.6.0 network-stamp primitives, mirroring `RNS/Stamps.py`
 *   (verified against the Python reference implementation in
 *   `./Reticulum/RNS`, version 1.6.0).
 *
 *   RNS 1.6.0 brings proof-of-work stamps into Reticulum core: destination
 *   announces, path requests and link requests can all carry stamps to raise
 *   the cost of spam and abuse. Unlike the LXMF stamps in
 *   {@link module:utils/stamper.js}, RNS stamps use:
 *
 *   - **Fractional costs** — a cost is a float quantized to 8.8 fixed point
 *     (e.g. `23.5` for destination announces, `15.8` for path requests,
 *     `12.5` for link requests). Targets are built from a 256-entry mantissa
 *     table ({@link TAB}), never recomputed.
 *   - **No workblock expansion** — the proof hashes the identifying material
 *     directly (`SHA256(material ‖ stamp)`), so there is no memory-hard
 *     workblock to build.
 *   - **14-byte detached stamps** for announces and path requests, and
 *     **stamped keys** for identities and link requests — the X25519 public
 *     key itself is the stamp, mined so `SHA256(material ‖ public_key)`
 *     meets the target. This carries zero extra wire bytes.
 *
 *   Phased rollout upstream: 1.6.0 verifies but does not enforce, 1.6.1
 *   emits by default, 1.6.2 enforces (unstamped announces, path requests and
 *   link requests are dropped).
 *
 *   All hashing routes through the pluggable engine seam from work doc #45
 *   ({@link module:utils/stamper.js}), so the `@reticulum/node` fast engine
 *   accelerates stamp generation and validation automatically.
 */

/* @ts-self-types="../../types/src/utils/stamps.d.ts" */

import {
  exportPublicKey,
  exportRawPrivateKey,
  generateX25519KeyPair,
} from "../crypto/keys.js";
import {
  assertValidCost,
  COST_FP_BITS,
  costFromFp,
  costToFp,
  fullHash,
  MANTISSA_BITS,
  stampWorkblock,
  TAB,
  targetFromCost,
  targetFromFp,
} from "./stamper.js";

// The fractional (8.8 fixed-point) cost machinery — mantissa table, cost
// helpers and target computation — lives in the engine seam
// (`./stamper.js`) so alternative engines need only that module to mine
// byte-compatible stamps. Re-exported here under the historical names so
// this module keeps its `RNS/Stamps.py`-mirroring API surface.
export {
  COST_FP,
  COST_FP_BITS,
  costFromBytes,
  costFromFp,
  costInt,
  costToBytes,
  costToFp,
  fpFromBytes,
  fpToBytes,
  MANTISSA_BITS,
  PRM_DIGEST,
  quantizeCost,
  STAMP_COST_CAP,
  STAMP_SIZE,
  TAB,
  TAB_DIGEST,
  targetFromCost,
  targetFromFp,
} from "./stamper.js";

/**
 * Detached-stamp length in bytes (`Identity.STAMPLENGTH` in the Python
 * reference). Used by destination announce stamps and path request stamps.
 * Note: LXMF message stamps are 32 bytes — do not confuse the two.
 * @type {number}
 */
export const STAMP_LENGTH = 14;

/**
 * Marker byte that opens a stamped extension payload (`0xC1`,
 * `Identity.EXTPAYLOADMARKER` — "never used at msgpack object boundaries",
 * which makes the marker unambiguous against legitimate app_data).
 * @type {number}
 */
export const EXT_PAYLOAD_MARKER = 0xc1;

/** Stamped-extension header length in bytes (marker + flags).
 * @type {number} */
export const EXT_HEADER_LENGTH = 2;

/** Link-request cost field length in bytes (fixed-point cost). @type {number} */
export const LR_COST_LENGTH = 2;

/**
 * Full stamped extension payload length on announces:
 * `EXT_HEADER_LENGTH + STAMP_LENGTH + LR_COST_LENGTH` = 18
 * (`Identity.EXTPAYLOADLENGTH`).
 * @type {number}
 */
export const EXT_PAYLOAD_LENGTH =
  EXT_HEADER_LENGTH + STAMP_LENGTH + LR_COST_LENGTH;

/**
 * Default required announce stamp cost (`Transport.DESTINATION_COST`):
 * the cost an announce stamp must meet when no interface- or
 * destination-specific requirement is configured.
 * @type {number}
 */
export const DEFAULT_DESTINATION_COST = 23.5;

/**
 * Default target stamp value for emitted announces
 * (`Transport.DESTINATION_VALUE`). Generation targets are always at least
 * the required cost, so a freshly mined stamp passes verification with
 * headroom.
 * @type {number}
 */
export const DEFAULT_DESTINATION_VALUE = 25.0;

/**
 * Default required path request stamp cost (`Transport.PR_COST`).
 * @type {number}
 */
export const DEFAULT_PR_COST = 15.8;

/**
 * Stamped path request extension header length in bytes (marker + flags;
 * Python `Transport.PR_EXT_HEADERLENGTH`).
 * @type {number}
 */
export const PR_EXT_HEADER_LENGTH = 2;

/**
 * Default target stamp value for emitted path requests
 * (`Transport.PR_VALUE`).
 * @type {number}
 */
export const DEFAULT_PR_VALUE = 15.8;

/**
 * Default required link request stamp cost (`Transport.LR_COST`) — the cost
 * assumed for link requests to a destination that has not announced one.
 * @type {number}
 */
export const DEFAULT_LR_COST = 12.5;

/**
 * Converts a big-endian byte array into a BigInt.
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
function bigIntFromBytesBE(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Concatenates two byte arrays into a fresh array.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Right-bisects {@link TAB} with `x`, returning the count of entries at or
 * below it (Python's `bisect.bisect_right`).
 * @param {number} x
 * @returns {number}
 */
function bisectRight(x) {
  let lo = 0;
  let hi = TAB.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < TAB[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/////////////////////////////////////////////////////////////////////////
// Fixed-point cost helpers live in `./stamper.js` (shared with the engine
// seam) and are re-exported above — `Stamps.py` "Fixed-point Helpers".
/////////////////////////////////////////////////////////////////////////

/////////////////////////////////////////////////////////////////////////
// Stamp validation and generation
/////////////////////////////////////////////////////////////////////////

/**
 * Computes the fractional value of a stamp as a float, mirroring
 * `stamp_value`. The value is derived from the hash's leading zero count
 * (its integer part) refined by bisecting the normalized mantissa against
 * {@link TAB} (the fractional 1/256-step part), so a stamp whose hash lands
 * partway between two powers of two earns fractional credit.
 *
 * @param {Uint8Array} workblock - The stamp's identifying material (for RNS
 *   stamps this is the material itself — no expansion rounds).
 * @param {Uint8Array} stamp - The stamp bytes (or a stamped public key).
 * @returns {Promise<number>} The achieved value as a float (e.g. `23.5`).
 */
export async function stampValue(workblock, stamp) {
  const product = await fullHash(concat(workblock, stamp));
  const hn = bigIntFromBytesBE(product);
  if (hn === 0n) return 256;
  const nb = MANTISSA_BITS + 1; // Normalized mantissa bit count (leading 1)
  const bl = hn.toString(2).length;
  const lz = 256 - bl;
  // Normalize the mantissa to TAB's scale (33 bits after the leading one).
  const mn = bl > nb ? hn >> BigInt(bl - nb) : hn << BigInt(nb - bl); // Number-safe: mn < 2^34
  // Leading zeros give the integer part (ceiling), the mantissa's climb
  // through the current range is subtracted, flooring onto the grid.
  const valueFp = ((lz + 1) << COST_FP_BITS) - bisectRight(Number(mn));
  return costFromFp(valueFp);
}

/**
 * Validates a stamp against a required fractional cost: valid when
 * `SHA256(workblock ‖ stamp) <= target_from_cost(cost)`. Mirrors
 * `stamp_valid`.
 *
 * @param {Uint8Array} stamp - The stamp bytes (or a stamped public key).
 * @param {number} targetCost - The required cost as a float.
 * @param {Uint8Array} workblock - The stamp's identifying material.
 * @returns {Promise<boolean>}
 */
export async function stampValid(stamp, targetCost, workblock) {
  const target = targetFromFp(costToFp(targetCost));
  const result = await fullHash(concat(workblock, stamp));
  return bigIntFromBytesBE(result) <= target;
}

/**
 * Options for {@link generateStamp} and {@link generateStampedKey}.
 *
 * @typedef {Object} GenerateOptions
 * @property {number} [expandRounds] - HKDF workblock expansion rounds.
 *   RNS stamps use 0 (the default): the material is hashed directly.
 * @property {number} [size] - Stamp length in bytes. Defaults to
 *   {@link STAMP_LENGTH} (14), the detached RNS stamp size (Python passes
 *   `size=Identity.STAMPLENGTH` explicitly for destination and path request
 *   stamps). Interface discovery stamps are 32 bytes (`STAMP_SIZE`), the
 *   Python `generate_stamp` default, and pass `size` explicitly.
 * @property {AbortSignal} [signal] - Cancels generation; the call resolves
 *   to `null` once the signal is aborted.
 */

/**
 * Searches for a detached stamp meeting the requested fractional cost,
 * mirroring `generate_stamp` (single-core simple mode; parallelism and
 * cancellation semantics are provided by the installed engine and the
 * caller-supplied signal).
 *
 * This is the single-threaded **reference** implementation: production
 * callers (announce and path request emission, interface discovery) mine
 * through the installed engine via {@link module:utils/stamper.js}
 * `.generateStamp` instead, so the search runs off the calling thread. This
 * function remains the parity oracle for the engine path and backs the
 * stamped-key flows ({@link generateStampedKey}).
 *
 * The proof hashes `workblock ‖ stamp` where the workblock is the stamp's
 * identifying material (expandRounds = 0) — see the module docs.
 *
 * @param {Uint8Array} material - The stamp's identifying material (e.g.
 *   `dest_hash ‖ public_key ‖ name_hash` for announces,
 *   `dest_hash ‖ tag` for path requests).
 * @param {number} stampCost - Required fractional cost (e.g. `15.8`).
 * @param {GenerateOptions} [options]
 * @returns {Promise<[Uint8Array, number]|null>} `[stamp, value]`, or `null`
 *   when generation was aborted via the signal.
 * @throws {RangeError} if `stampCost` is out of range.
 */
export async function generateStamp(material, stampCost, options = {}) {
  assertValidCost(stampCost);
  const { expandRounds = 0, size = STAMP_LENGTH, signal } = options;
  const workblock = await stampWorkblock(material, expandRounds);
  const target = targetFromCost(stampCost);
  const stamp = new Uint8Array(size);
  while (true) {
    if (signal?.aborted) return null;
    crypto.getRandomValues(stamp);
    const candidate = concat(workblock, stamp);
    if (bigIntFromBytesBE(await fullHash(candidate)) <= target) {
      return [stamp, await stampValue(workblock, stamp)];
    }
  }
}

/**
 * Generates a new, internally stamped X25519 keypair whose public key
 * *is* the stamp — mirroring `generate_stamped_key`. The proof hashes
 * `material ‖ public_key`, so anyone holding the public key (and the
 * domain material) can verify the work without any detached stamp.
 *
 * This is how RNS 1.6.0 stamps link requests and (optionally) identities
 * with zero extra wire bytes: the ephemeral link-request X25519 key, or an
 * identity's X25519 key, is mined against the domain material:
 *
 * - Link request: `material = dest_hash ‖ initiator_signing_public_key`
 * - Identity: `material = identity_signing_public_key`
 *
 * The returned private key loads into an identity via
 * `Identity.fromPrivateKey` in the usual way.
 *
 * @param {Uint8Array} material - The domain material the key is bound to.
 * @param {number} stampCost - Required fractional cost.
 * @param {GenerateOptions} [options]
 * @returns {Promise<{privateKey: Uint8Array, publicKey: Uint8Array, value: number}|null>}
 *   The raw 32-byte private/public keypair and achieved value, or `null`
 *   when aborted via the signal.
 * @throws {RangeError} if `stampCost` is out of range.
 */
export async function generateStampedKey(material, stampCost, options = {}) {
  assertValidCost(stampCost);
  const { signal } = options;
  const target = targetFromCost(stampCost);
  while (true) {
    if (signal?.aborted) return null;
    const keypair = await generateX25519KeyPair();
    const publicKey = await exportPublicKey(keypair.publicKey);
    if (
      bigIntFromBytesBE(await fullHash(concat(material, publicKey))) <= target
    ) {
      const privateKey = await exportRawPrivateKey(keypair.privateKey);
      return {
        privateKey,
        publicKey,
        value: await stampValue(material, publicKey),
      };
    }
  }
}
