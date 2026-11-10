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
import { fullHash } from "./stamper.js";

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
 * Message-stamp length in bytes (`STAMP_SIZE` in `Stamps.py`), matching the
 * LXMF stamp size. Kept here for parity with the Python module.
 * @type {number}
 */
export const STAMP_SIZE = 32;

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
// Fixed-point cost helpers (Stamps.py "Fixed-point Helpers")
/////////////////////////////////////////////////////////////////////////

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
 * @property {AbortSignal} [signal] - Cancels generation; the call resolves
 *   to `null` once the signal is aborted.
 */

/**
 * Validates a requested stamp cost against the global cap.
 * @param {number} stampCost
 * @returns {void}
 * @throws {RangeError} if the cost is negative or above {@link STAMP_COST_CAP}.
 */
function assertValidCost(stampCost) {
  if (stampCost < 0 || stampCost > STAMP_COST_CAP) {
    throw new RangeError(
      `Invalid stamp cost, cannot generate: ${stampCost} (cap ${STAMP_COST_CAP})`,
    );
  }
}

/**
 * Searches for a detached stamp meeting the requested fractional cost,
 * mirroring `generate_stamp` (single-core simple mode; parallelism and
 * cancellation semantics are provided by the installed engine and the
 * caller-supplied signal).
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
  const { expandRounds = 0, signal } = options;
  const { stampWorkblock } = await import("./stamper.js");
  const workblock = await stampWorkblock(material, expandRounds);
  const target = targetFromCost(stampCost);
  const size = STAMP_LENGTH;
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
