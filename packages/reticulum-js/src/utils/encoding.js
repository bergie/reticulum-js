/**
 * Minimal, zero-dependency encoding utilities for the Reticulum Network System.
 * Strictly utilizes standard ES6 TypedArrays and Strings.
 */

/**
 * Converts a Uint8Array to a lowercase hexadecimal string.
 * This is primarily used for indexing Routing Tables and displaying Destination Hashes.
 * * @param {Uint8Array} bytes - The raw byte array to convert.
 * @returns {string} The resulting hexadecimal string.
 */
export function toHex(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("toHex expects a Uint8Array");
  }

  // We pre-allocate the array for slight memory optimization over .map()
  const hex = new Array(bytes.length);

  for (let i = 0; i < bytes.length; i++) {
    // .toString(16) drops leading zeros (e.g., 0x0A becomes 'a').
    // .padStart(2, '0') guarantees we always have valid 2-character hex pairs.
    hex[i] = bytes[i].toString(16).padStart(2, "0");
  }

  return hex.join("");
}

/**
 * Constant-time-ish equality check for two Uint8Arrays.
 *
 * Used for comparing hashes / public keys where short-circuiting on the first
 * differing byte would leak timing information. Returns true only when both
 * arrays are the same length and every byte matches.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
    throw new TypeError("bytesEqual expects Uint8Array arguments");
  }
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Concatenates a variable number of Uint8Array (or array-like byte sources)
 * into a single new Uint8Array. Accepts Uint8Array values directly; anything
 * else is coerced via `new Uint8Array(source)`.
 *
 * @param {...Uint8Array | ArrayLike<number>} arrays
 * @returns {Uint8Array}
 */
export function concatBytes(...arrays) {
  /** @type {Uint8Array[]} */
  const parts = arrays.map((a) =>
    a instanceof Uint8Array ? a : new Uint8Array(/** @type {any} */ (a)),
  );
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Encodes a Uint8Array into standard (RFC 4648) base64.
 *
 * Pure-JS implementation (no `Buffer`/`btoa`) so it runs unchanged on every
 * WinterTC-compatible runtime.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("bytesToBase64 expects a Uint8Array");
  }
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars[(n >> 18) & 0x3f];
    out += chars[(n >> 12) & 0x3f];
    out += chars[(n >> 6) & 0x3f];
    out += chars[n & 0x3f];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += chars[(n >> 18) & 0x3f];
    out += chars[(n >> 12) & 0x3f];
    out += "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += chars[(n >> 18) & 0x3f];
    out += chars[(n >> 12) & 0x3f];
    out += chars[(n >> 6) & 0x3f];
    out += "=";
  }
  return out;
}

// Reverse lookup table for base64 decoding (covers both standard and URL-safe
// alphabets so the decoder tolerates either input).
const B64_DEC = (() => {
  const t = new Int8Array(128).fill(-1);
  const std =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < std.length; i++) t[std.charCodeAt(i)] = i;
  // URL-safe alphabet aliases.
  t["-".charCodeAt(0)] = 62;
  t["_".charCodeAt(0)] = 63;
  return t;
})();

/**
 * Decodes a (standard or URL-safe, padded or unpadded) base64 string.
 *
 * Tolerant in the same ways the LXMF Python reference is when ingesting paper
 * URIs: stray padding is ignored and missing padding is restored.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
export function base64ToBytes(str) {
  if (typeof str !== "string") {
    throw new TypeError("base64ToBytes expects a string");
  }
  // Normalise to the standard alphabet, drop padding, then re-pad correctly.
  let s = str.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const pad = (4 - (s.length % 4)) % 4;
  if (pad) s += "=".repeat(pad);

  const out = new Uint8Array((s.length / 4) * 3);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c0 = B64_DEC[s.charCodeAt(i)];
    const c1 = B64_DEC[s.charCodeAt(i + 1)];
    const c2 =
      s.charCodeAt(i + 2) === "=".charCodeAt(0)
        ? -1
        : B64_DEC[s.charCodeAt(i + 2)];
    const c3 =
      s.charCodeAt(i + 3) === "=".charCodeAt(0)
        ? -1
        : B64_DEC[s.charCodeAt(i + 3)];
    const n = (c0 << 18) | (c1 << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
    out[o++] = (n >> 16) & 0xff;
    if (c2 !== -1) out[o++] = (n >> 8) & 0xff;
    if (c3 !== -1) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

/**
 * Encodes bytes as URL-safe base64 **without** padding, the exact form used by
 * the LXMF paper-message `lxm://` URI (`LXMessage.as_uri`).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decodes a URL-safe (or standard) base64 string, tolerating missing padding —
 * the inverse of {@link bytesToBase64Url}.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(str) {
  return base64ToBytes(str);
}

/**
 * Converts a hexadecimal string back into a raw Uint8Array.
 * Useful for parsing user-provided destination hashes or static routing configurations.
 *
 * @param {string} hexString - The hexadecimal string to convert.
 * @returns {Uint8Array} The resulting raw byte array.
 */
export function fromHex(hexString) {
  if (typeof hexString !== "string") {
    throw new TypeError("fromHex expects a string");
  }

  // Strip out any accidental spaces, dashes, or formatting
  const cleanHex = hexString.replace(/[\s-]/g, "");

  if (cleanHex.length % 2 !== 0) {
    throw new Error("Hex string must have an even number of characters");
  }

  const bytes = new Uint8Array(cleanHex.length / 2);

  for (let i = 0; i < bytes.length; i++) {
    const start = i * 2;
    // Parse each 2-character chunk as a base-16 integer
    bytes[i] = parseInt(cleanHex.substring(start, start + 2), 16);
  }

  return bytes;
}
