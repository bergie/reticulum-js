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
 *   The same engine seam also carries RNS 1.6.0 network stamps
 *   (`RNS/Stamps.py`, see {@link module:utils/stamps.js}): destination
 *   announces, path requests and interface discovery validate against the
 *   fractional 8.8 fixed-point target grid ({@link targetFromCost}). At
 *   whole-number costs that target is exactly `2^(256 - cost)` — the LXMF
 *   leading-zero-bit boundary — so a single generation entry point serves
 *   both stamp families: the installed engine mines off the calling thread
 *   (worker thread, WASM midstate or yield-sliced loop depending on the
 *   platform package), while `utils/stamps.js` keeps the single-core
 *   reference miner (Python `Stamps.job_simple` mode) for parity tests.
 *
 *   The fractional fixed-point machinery (mantissa table {@link TAB},
 *   quantization and target helpers) lives here so engine implementations
 *   need only this module to stay byte-compatible: they derive trial
 *   targets with {@link stampTargetBytesFromCost}. `utils/stamps.js`
 *   re-exports all of it under its historical names.
 *
 *   ## Pluggable engines (work doc #45)
 *
 *   The default engine is pure WebCrypto (WinterTC minimum common API only),
 *   so it runs everywhere — browsers included. On runtimes where WebCrypto
 *   hashing is slow (it re-hashes the entire workblock on every stamp
 *   trial), a platform package may install a faster engine via
 *   {@link setStamper} — e.g. `@reticulum/node`'s `node:crypto` engine with
 *   hash-state copying and worker-thread generation, or
 *   `@reticulum/wasm-stamper`'s hash-wasm engine for browsers (WASM SHA-256
 *   with `save()`/`load()` midstate cloning). The wire format and
 *   validation semantics are engine-invariant: any engine must produce
 *   byte-identical workblocks and agree on stamp validity.
 */

/* @ts-self-types="../../types/src/utils/stamper.d.ts" */

/**
 * Options for the engine {@link StamperEngine.generateStamp} search.
 *
 * Engines must also tolerate the legacy call form where the third argument
 * is a bare `expandRounds` number (see {@link normalizeGenerateStampOptions}).
 *
 * @typedef {Object} GenerateStampOptions
 * @property {number} [expandRounds] - HKDF workblock expansion rounds.
 *   Defaults to {@link WORKBLOCK_EXPAND_ROUNDS} (3000, LXMF message stamps).
 *   RNS 1.6.0 announce and path request stamps pass `0` — their proof hashes
 *   the raw material (Python passes `expand_rounds=0` explicitly).
 * @property {number} [size] - Stamp length in bytes. Defaults to
 *   {@link STAMP_SIZE} (32, the LXMF/Python `generate_stamp` default). RNS
 *   detached stamps pass {@link module:utils/stamps.js}.STAMP_LENGTH (14,
 *   Python `Identity.STAMPLENGTH`).
 * @property {AbortSignal} [signal] - Cancels the search: the call resolves
 *   to `null` once the signal is aborted. Engines check the signal at their
 *   natural suspension points; a worker-thread engine cannot interrupt a
 *   search already dispatched to its worker.
 */

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
 * @property {(messageId: Uint8Array, stampCost: number, expandRoundsOrOptions?: number|GenerateStampOptions) => Promise<[Uint8Array, number]|null>} generateStamp
 *   Searches for a valid stamp (Python `Stamps.generate_stamp`), returning
 *   `[stamp, value]` where `value` is the stamp's leading-zero-bit count, or
 *   `null` when a supplied {@link GenerateStampOptions.signal} aborted the
 *   search. `stampCost` is a fractional 8.8 fixed-point cost quantized onto
 *   the {@link TAB} target grid — at whole-number costs the target is
 *   byte-identical to the `2^(256 - cost)` LXMF boundary, so integer-cost
 *   callers are unaffected.
 */

import { hkdf } from "../crypto/ciphers.js";
import { concatBytes } from "./encoding.js";

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

// ---------------------------------------------------------------------
// Fractional (8.8 fixed-point) cost grid — RNS 1.6.0 `Stamps.py`
//
// Shared by the engine seam so every engine mines against the same
// targets; `utils/stamps.js` re-exports these under their historical
// names. Stamps may carry fractional costs (e.g. announce target 25.0,
// path requests 15.8); targets are built from a 256-entry mantissa
// table, never recomputed.
// ---------------------------------------------------------------------

/**
 * Global hard cap on stamp cost. Keeps the search space viable for 14-byte
 * stamps (`RNS.Transport.STAMP_COST_CAP` in the Python reference).
 * @type {number}
 */
export const STAMP_COST_CAP = 100;

/** Mantissa bit count of the fixed-point target mantissa table. @type {number} */
export const MANTISSA_BITS = 33;
/** Fractional bits of the 8.8 fixed-point cost representation. @type {number} */
export const COST_FP_BITS = 8;
/** Fixed-point scale factor (`1 << COST_FP_BITS` = 256). @type {number} */
export const COST_FP = 1 << COST_FP_BITS;

export const TAB_DIGEST =
  "55ba3ce1df224895b0dfdc102eb4359fc2f5a7efefee68df0cc90c8a8ac24f48";
export const PRM_DIGEST =
  "21436fc98e76a12cad7c52ebeb6ab76c2ae93b4cd768949df7fdd4e2f98c378d";

// Fixed-point stamp target mantissa table
// TAB[f] = floor(2^33 * 2^(f/256)), f = 0..255
//
// These values are authoritative (digest-checked in the test suite against
// the Python reference). DO NOT regenerate or alter them.
export const TAB = [
  0x200000000, 0x201635f4b, 0x202c7b53f, 0x2042d0287, 0x2059347ce, 0x206fa85c2,
  0x20862bd0d, 0x209cbee5e, 0x20b361a62, 0x20ca141c7, 0x20e0d653b, 0x20f7a856e,
  0x210e8a30e, 0x21257becc, 0x213c7d958, 0x21538f363, 0x216ab0d9f, 0x2181e28bc,
  0x21992456e, 0x21b076467, 0x21c7d865a, 0x21df4abfb, 0x21f6cd5ff, 0x220e6051a,
  0x222603a02, 0x223db756b, 0x22557b80d, 0x226d5029e, 0x2285355d5, 0x229d2b269,
  0x22b531914, 0x22cd48a8e, 0x22e57078f, 0x22fda90d2, 0x2315f2711, 0x232e4cb06,
  0x2346b7d6d, 0x235f33f02, 0x2377c1080, 0x23905f2a5, 0x23a90e62d, 0x23c1cebd6,
  0x23daa045f, 0x23f383087, 0x240c7710c, 0x24257c6af, 0x243e9322f, 0x2457bb44f,
  0x2470f4dce, 0x248a3ff70, 0x24a39c9f6, 0x24bd0ae23, 0x24d68acbc, 0x24f01c683,
  0x2509bfc3e, 0x252374eb2, 0x253d3bea3, 0x255714cda, 0x2570ffa1b, 0x258afc72e,
  0x25a50b4dc, 0x25bf2c3ec, 0x25d95f527, 0x25f3a4957, 0x260dfc146, 0x262865dbd,
  0x2642e1f89, 0x265d70775, 0x26781164c, 0x2692c4cdc, 0x26ad8abf2, 0x26c86345b,
  0x26e34e6e7, 0x26fe4c463, 0x27195cda0, 0x27348036e, 0x274fb669c, 0x276aff7fd,
  0x27865b862, 0x27a1ca89d, 0x27bd4c982, 0x27d8e1be3, 0x27f48a095, 0x28104586c,
  0x282c1443e, 0x2847f64e1, 0x2863ebb2a, 0x287ff47f0, 0x289c10c0c, 0x28b840854,
  0x28d483da3, 0x28f0dacd1, 0x290d456b8, 0x2929c3c32, 0x294655e1a, 0x2962fbd4d,
  0x297fb5aa6, 0x299c83702, 0x29b96533f, 0x29d65b03b, 0x29f364ed3, 0x2a1082fe8,
  0x2a2db5459, 0x2a4afbd07, 0x2a6856ad3, 0x2a85c5e9e, 0x2aa34994b, 0x2ac0e1bbd,
  0x2ade8e6d6, 0x2afc4fb7c, 0x2b1a25a92, 0x2b38104ff, 0x2b560fba9, 0x2b7423f75,
  0x2b924d14b, 0x2bb08b213, 0x2bcede2b5, 0x2bed4641b, 0x2c0bc372e, 0x2c2a55cd9,
  0x2c48fd607, 0x2c67ba3a3, 0x2c868c699, 0x2ca573fd7, 0x2cc47104a, 0x2ce3838e1,
  0x2d02aba89, 0x2d21e9633, 0x2d413cccf, 0x2d60a5f4e, 0x2d8024ea1, 0x2d9fb9bba,
  0x2dbf6478c, 0x2ddf2530b, 0x2dfefbf2a, 0x2e1ee8cde, 0x2e3eebd1d, 0x2e5f050dd,
  0x2e7f34914, 0x2e9f7a6ba, 0x2ebfd6ac8, 0x2ee049635, 0x2f00d29fb, 0x2f2172715,
  0x2f4228e7d, 0x2f62f612e, 0x2f83da026, 0x2fa4d4c5f, 0x2fc5e66d9, 0x2fe70f092,
  0x30084ea87, 0x3029a55ba, 0x304b13329, 0x306c983d7, 0x308e348c4, 0x30afe82f3,
  0x30d1b3368, 0x30f395b26, 0x31158fb31, 0x3137a148f, 0x3159ca845, 0x317c0b75a,
  0x319e642d6, 0x31c0d4bc1, 0x31e35d322, 0x3205fda05, 0x3228b6172, 0x324b86a75,
  0x326e6f619, 0x32917056b, 0x32b489979, 0x32d7bb34e, 0x32fb053fb, 0x331e67c8f,
  0x3341e2e19, 0x3365769aa, 0x338923054, 0x33ace8329, 0x33d0c633c, 0x33f4bd1a0,
  0x3418ccf6b, 0x343cf5db1, 0x346137d89, 0x348593008, 0x34aa07647, 0x34ce9515e,
  0x34f33c266, 0x3517fca78, 0x353cd6aaf, 0x3561ca426, 0x3586d77fa, 0x35abfe747,
  0x35d13f32b, 0x35f699cc4, 0x361c0e531, 0x36419cd93, 0x366745709, 0x368d082b6,
  0x36b2e51bc, 0x36d8dc53e, 0x36feede5f, 0x372519e44, 0x374b60614, 0x3771c16f3,
  0x37983d209, 0x37bed387e, 0x37e584b7a, 0x380c50c28, 0x383337bb0, 0x385a39b3f,
  0x388156bff, 0x38a88ef1f, 0x38cfe25ca, 0x38f751131, 0x391edb280, 0x394680aea,
  0x396e41b9d, 0x39961e5cd, 0x39be16aab, 0x39e62ab6b, 0x3a0e5a940, 0x3a36a6561,
  0x3a5f0e101, 0x3a8791d59, 0x3ab031b9f, 0x3ad8edd0c, 0x3b01c62d9, 0x3b2abae3f,
  0x3b53cc07b, 0x3b7cf9ac7, 0x3ba643e60, 0x3bcfaac83, 0x3bf92e66f, 0x3c22ced63,
  0x3c4c8c29e, 0x3c7666762, 0x3ca05dcf1, 0x3cca7248c, 0x3cf4a3f78, 0x3d1ef2ef9,
  0x3d495f454, 0x3d73e90cf, 0x3d9e905b1, 0x3dc955443, 0x3df437dcc, 0x3e1f38396,
  0x3e4a566ed, 0x3e759291b, 0x3ea0ecb6d, 0x3ecc64f31, 0x3ef7fb5b3, 0x3f23b0044,
  0x3f4f83033, 0x3f7b746d2, 0x3fa784571, 0x3fd3b2d65,
];

// Invariants of the mantissa table (see the Python reference's assertions).
if (
  TAB.length !== COST_FP ||
  TAB[0] !== 2 ** MANTISSA_BITS ||
  !TAB.every((v, i) => i === 0 || v > TAB[i - 1])
) {
  throw new Error("Stamps: mantissa table TAB is corrupt");
}

/**
 * Validates a requested stamp cost against the global cap.
 * @param {number} stampCost
 * @returns {void}
 * @throws {RangeError} if the cost is negative or above {@link STAMP_COST_CAP}.
 */
export function assertValidCost(stampCost) {
  if (stampCost < 0 || stampCost > STAMP_COST_CAP) {
    throw new RangeError(
      `Invalid stamp cost, cannot generate: ${stampCost} (cap ${STAMP_COST_CAP})`,
    );
  }
}

/**
 * Quantizes a (possibly fractional) stamp cost to the 8.8 fixed-point
 * representation, clamped to `STAMP_COST_CAP`. Mirrors `cost_to_fp`.
 * @param {number} cost
 * @returns {number} The fixed-point value (cost × 256, rounded half-up).
 */
export function costToFp(cost) {
  const value = Math.floor(Number(cost) * COST_FP + 0.5);
  return Math.max(0, Math.min(value, STAMP_COST_CAP * COST_FP));
}

/**
 * Encodes a fixed-point cost as its 2-byte big-endian representation
 * (`[integer part, fractional part]`). Mirrors `fp_to_bytes`.
 * @param {number} fp
 * @returns {Uint8Array} 2 bytes.
 */
export function fpToBytes(fp) {
  return new Uint8Array([(fp >> COST_FP_BITS) & 0xff, fp & 0xff]);
}

/**
 * Encodes a (possibly fractional) cost directly to wire bytes. Mirrors
 * `cost_to_bytes`.
 * @param {number} cost
 * @returns {Uint8Array} 2 bytes.
 */
export function costToBytes(cost) {
  return fpToBytes(costToFp(cost));
}

/**
 * Decodes a 2-byte fixed-point cost representation. Mirrors `fp_from_bytes`.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function fpFromBytes(bytes) {
  return (bytes[0] << COST_FP_BITS) | bytes[1];
}

/**
 * Converts a fixed-point value back to a float cost. Mirrors `cost_from_fp`.
 * @param {number} fp
 * @returns {number}
 */
export function costFromFp(fp) {
  return fp / COST_FP;
}

/**
 * Decodes a 2-byte wire cost back to a float. Mirrors `cost_from_bytes`.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function costFromBytes(bytes) {
  return costFromFp(fpFromBytes(bytes));
}

/**
 * Quantizes a cost onto the fixed-point grid and returns the resulting float.
 * Two costs comparing equal after quantization are interchangeable in
 * verification decisions. Mirrors `quantize_cost`.
 * @param {number} cost
 * @returns {number}
 */
export function quantizeCost(cost) {
  return costFromFp(costToFp(cost));
}

/**
 * Legacy integer (whole-number) representation of a fixed-point cost, used
 * for display. Mirrors `cost_int`.
 * @param {number} fp
 * @returns {number}
 */
export function costInt(fp) {
  return fp >> COST_FP_BITS;
}

/**
 * Computes the proof-of-work target for a fixed-point cost: the largest
 * value a stamp hash may take while remaining valid. Mirrors
 * `target_from_fp`:
 *
 * ```
 * i, f = divmod(256*COST_FP - fp, COST_FP)
 * target = (TAB[f] << i) >> MANTISSA_BITS
 * ```
 *
 * @param {number} fp Fixed-point cost (`costToFp(cost)`).
 * @returns {bigint} The inclusive upper bound for the stamp hash value.
 * @throws {RangeError} if `fp` is outside `[0, STAMP_COST_CAP × COST_FP]`.
 */
export function targetFromFp(fp) {
  if (fp < 0 || fp > STAMP_COST_CAP * COST_FP) {
    throw new RangeError(`Invalid fixed-point stamp cost: ${fp}`);
  }
  const span = BigInt(256 * COST_FP - fp);
  const i = span / BigInt(COST_FP);
  const f = Number(span % BigInt(COST_FP));
  return (BigInt(TAB[f]) << i) >> BigInt(MANTISSA_BITS);
}

/**
 * Computes the proof-of-work target for a (possibly fractional) cost.
 * Mirrors `target_from_cost`.
 * @param {number} cost
 * @returns {bigint}
 */
export function targetFromCost(cost) {
  return targetFromFp(costToFp(cost));
}

/**
 * Computes the 32-byte big-endian proof-of-work target for a (possibly
 * fractional) cost — the encoding engine implementations compare candidate
 * digests against bytewise during {@link StamperEngine.generateStamp}
 * searches. The value mirrors Python `Stamps.target_from_cost`; the bytewise
 * encoding is the JS engine seam's form of the `LXMF.LXStamper`
 * `SHA256(workblock || stamp) <= 2^(256 - target_bits)` threshold.
 *
 * At whole-number costs this is exactly the `2^(256 - cost)` LXMF boundary
 * encoding, so engines previously mining integer-bit targets produce
 * byte-identical comparisons. Python compares BigInts, where a cost-0
 * target of `2^256` passes every digest; the all-ones encoding used here
 * for that case is exactly equivalent for 32-byte digests, since no digest
 * can exceed `2^256 - 1`.
 *
 * @param {number} cost
 * @returns {Uint8Array} 32 bytes, big-endian.
 * @throws {RangeError} if the cost is negative or above {@link STAMP_COST_CAP}
 *   (Python `generate_stamp` raises for the same range).
 */
export function stampTargetBytesFromCost(cost) {
  assertValidCost(cost);
  const target = targetFromCost(cost);
  const out = new Uint8Array(32);
  // Clamp 2^256 (cost 0) into 32 bytes: any 32-byte digest ≤ 2^256 - 1 is
  // also ≤ 2^256, so the all-ones encoding is exactly equivalent.
  let value = target >= 1n << BigInt(256) ? (1n << BigInt(256)) - 1n : target;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/**
 * Normalizes the legacy engine call form — a bare `expandRounds` number as
 * the third argument of {@link StamperEngine.generateStamp} — into the
 * canonical {@link GenerateStampOptions} object. `undefined` and `null`
 * yield the empty options object (engines then apply their defaults).
 *
 * No Python counterpart: this exists so the work-doc-#45 engine seam can
 * grow the announce/path-request options without breaking the historical
 * positional call form.
 *
 * Exported so alternative engine implementations share the exact tolerance.
 *
 * @param {number|GenerateStampOptions|null} [expandRoundsOrOptions]
 * @returns {GenerateStampOptions}
 */
export function normalizeGenerateStampOptions(expandRoundsOrOptions) {
  if (typeof expandRoundsOrOptions === "number") {
    return { expandRounds: expandRoundsOrOptions };
  }
  return expandRoundsOrOptions ?? {};
}

/**
 * Bytewise big-endian comparison: `a <= b` for equal-length digests.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function digestLessOrEqualBytes(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
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
  // Python-faithful 0-round semantics: `LXStamper.stamp_workblock` returns
  // the material itself when no expansion is requested (`not expand_rounds`).
  // RNS 1.6.0 network stamps always validate against the raw material, so
  // this path must never yield an empty workblock.
  if (!expandRounds) return material.slice();
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
 * Searches for a valid stamp by random trial (Python `Stamps.generate_stamp`'s
 * `job_simple` mode, on the calling thread).
 *
 * @param {Uint8Array} messageId - The 32-byte LXMF message_id (or any stamp
 *   material).
 * @param {number} stampCost - Required fractional 8.8 fixed-point cost.
 * @param {number|GenerateStampOptions} [expandRoundsOrOptions] - Legacy
 *   positional `expandRounds`, or {@link GenerateStampOptions}.
 * @returns {Promise<[Uint8Array, number]|null>} `[stamp, value]` (value =
 *   leading-zero-bit count), or `null` when aborted via the signal.
 */
async function webCryptoGenerateStamp(
  messageId,
  stampCost,
  expandRoundsOrOptions,
) {
  const {
    expandRounds = WORKBLOCK_EXPAND_ROUNDS,
    size = STAMP_SIZE,
    signal,
  } = normalizeGenerateStampOptions(expandRoundsOrOptions);
  const workblock = await webCryptoStampWorkblock(messageId, expandRounds);
  const target = stampTargetBytesFromCost(stampCost);
  const stamp = new Uint8Array(size);
  while (true) {
    if (signal?.aborted) return null;
    crypto.getRandomValues(stamp);
    const hash = await webCryptoFullHash(concatBytes(workblock, stamp));
    if (digestLessOrEqualBytes(hash, target)) {
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
 * Searches for a valid stamp by random trial through the installed engine
 * (Python `Stamps.generate_stamp`). The search never blocks the calling
 * thread when the installed engine mines off-thread (e.g. `@reticulum/node`'s
 * worker-thread engine).
 *
 * The third argument keeps its historical positional form — a bare
 * `expandRounds` number (default {@link WORKBLOCK_EXPAND_ROUNDS}) — and also
 * accepts a {@link GenerateStampOptions} object for the RNS 1.6.0 call sites
 * (`expandRounds: 0`, `size: STAMP_LENGTH`, optional `signal`). The engine is
 * dispatched in whichever form the caller supplied, so engines built for the
 * positional contract keep working unchanged.
 *
 * @param {Uint8Array} messageId - The 32-byte LXMF message_id (or any stamp
 *   material, e.g. `dest_hash ‖ public_key ‖ name_hash` for announces).
 * @param {number} stampCost - Required fractional 8.8 fixed-point cost (at
 *   whole-number costs identical to the historical leading-zero-bit target).
 * @param {number|GenerateStampOptions} [expandRoundsOrOptions]
 * @returns {Promise<[Uint8Array, number]|null>} `[stamp, value]` (value =
 *   leading-zero-bit count), or `null` when aborted via a supplied signal.
 * @throws {RangeError} if `stampCost` is negative or above the cost cap.
 */
export function generateStamp(messageId, stampCost, expandRoundsOrOptions) {
  assertValidCost(stampCost);
  if (
    expandRoundsOrOptions === undefined ||
    typeof expandRoundsOrOptions === "number"
  ) {
    // Historical engine contract: the third argument is the expandRounds
    // number, with the LXMF default applied when omitted.
    const expandRounds =
      expandRoundsOrOptions === undefined
        ? WORKBLOCK_EXPAND_ROUNDS
        : expandRoundsOrOptions;
    return engine.generateStamp(messageId, stampCost, expandRounds);
  }
  if (expandRoundsOrOptions.signal?.aborted) {
    return Promise.resolve(null);
  }
  return engine.generateStamp(messageId, stampCost, expandRoundsOrOptions);
}
