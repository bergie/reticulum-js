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
  return await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
}

/**
 * Generates an X25519 key pair.
 * @returns {Promise<KeyPair>}
 */
export async function generateX25519KeyPair() {
  return await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveKey",
    "deriveBits",
  ]);
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
