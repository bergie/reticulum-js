/**
 * @file keys.js
 * @description X25519 / Ed25519 generation and parsing
 */

/**
 * @typedef KeyPair
 * @property {CryptoKey} privateKey
 * @property {CryptoKey} publicKey
 */

/**
 * Generates an Ed25519 key pair.
 * @returns {Promise<KeyPair>}
 */
export async function generateEd25519KeyPair() {
  return /** @type {Promise<KeyPair>} */ (
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  );
}

/**
 * Generates an X25519 key pair.
 * @returns {Promise<KeyPair>}
 */
export async function generateX25519KeyPair() {
  return /** @type {Promise<KeyPair>} */ (
    crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveKey",
      "deriveBits",
    ])
  );
}

/**
 * Exports the public key as a raw Uint8Array.
 * @param {CryptoKey} publicKey
 * @returns {Promise<Uint8Array>}
 */
export async function exportPublicKey(publicKey) {
  const exported = await crypto.subtle.exportKey("raw", publicKey);
  return new Uint8Array(/** @type {any} */ (exported));
}

/**
 * Imports a raw Ed25519 public key.
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
export async function importEd25519PublicKey(rawKey) {
  return await crypto.subtle.importKey(
    "raw",
    /** @type {any} */ (rawKey),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
}

/**
 * Imports a raw X25519 public key.
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
export async function importX25519PublicKey(rawKey) {
  return await crypto.subtle.importKey(
    "raw",
    /** @type {any} */ (rawKey),
    { name: "X25519" },
    true,
    [],
  );
}

/**
 * Exports the private key as PKCS#8.
 * @param {CryptoKey} privateKey
 * @returns {Promise<Uint8Array>}
 */
export async function exportPrivateKey(privateKey) {
  const exported = await crypto.subtle.exportKey("pkcs8", privateKey);
  return new Uint8Array(/** @type {any} */ (exported));
}

/**
 * Exports the private key as raw bytes (32 bytes).
 * @param {CryptoKey} privateKey
 * @returns {Promise<Uint8Array>}
 */
export async function exportRawPrivateKey(privateKey) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return new Uint8Array(pkcs8).slice(-32);
}

/**
 * Imports an Ed25519 private key (PKCS#8).
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
export async function importEd25519PrivateKey(rawKey) {
  return await crypto.subtle.importKey(
    "pkcs8",
    /** @type {any} */ (rawKey),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
}

/**
 * Imports an X25519 private key (PKCS#8).
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
export async function importX25519PrivateKey(rawKey) {
  return await crypto.subtle.importKey(
    "pkcs8",
    /** @type {any} */ (rawKey),
    { name: "X25519" },
    true,
    ["deriveKey", "deriveBits"],
  );
}

/**
 * Imports an Ed25519 private key from raw bytes.
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
export async function importRawEd25519PrivateKey(rawKey) {
  const wrapped = new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x04,
    0x22,
    0x04,
    0x20,
    ...rawKey,
  ]);
  return await crypto.subtle.importKey(
    "pkcs8",
    /** @type {any} */ (wrapped),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
}

/**
 * Decodes an unpadded base64url string into a byte array.
 * @param {string} s
 * @returns {Uint8Array}
 * @private
 */
function base64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derives the public key corresponding to an OKP (X25519 / Ed25519) private
 * key.
 *
 * WebCrypto has no direct "give me my public key" call, but exporting an OKP
 * private key as JWK yields the public component in the `x` field
 * (RFC 8037), which we re-import as a raw public key. Used by
 * {@link import("../core/identity.js").Identity.fromPrivateKey} to build a
 * full identity from private-key material alone — mirroring the Python
 * reference's `Identity.load_private_key`, which derives `pub`/`sig_pub` from
 * `prv`/`sig_prv`.
 * @param {CryptoKey} privateKey An extractable X25519 or Ed25519 private key.
 * @returns {Promise<{publicKey: CryptoKey, raw: Uint8Array}>} The matching
 *   public key, both as a CryptoKey and as 32 raw bytes.
 */
export async function derivePublicKeyFromPrivate(privateKey) {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const raw = base64urlToBytes(/** @type {string} */ (jwk.x));
  const algorithm = /** @type {{ name: string }} */ (privateKey.algorithm);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    /** @type {any} */ (raw),
    { name: algorithm.name },
    true,
    algorithm.name === "Ed25519" ? ["verify"] : [],
  );
  return { publicKey, raw };
}

/**
 * Imports an X25519 private key from raw bytes.
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
export async function importRawX25519PrivateKey(rawKey) {
  const wrapped = new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x6e,
    0x04,
    0x22,
    0x04,
    0x20,
    ...rawKey,
  ]);
  return await crypto.subtle.importKey(
    "pkcs8",
    /** @type {any} */ (wrapped),
    { name: "X25519" },
    true,
    ["deriveKey", "deriveBits"],
  );
}
