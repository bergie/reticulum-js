/**
 * @file keys.js
 * @description X25519 / Ed25519 generation and parsing
 */

/**
 * Generates an Ed25519 key pair.
 * @returns {Promise<{privateKey: CryptoKey, publicKey: CryptoKey}>}
 */
export async function generateEd25519KeyPair() {
    return await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
    );
}

/**
 * Generates an X25519 key pair.
 * @returns {Promise<{privateKey: CryptoKey, publicKey: CryptoKey}>}
 */
export async function generateX25519KeyPair() {
    return await crypto.subtle.generateKey(
        { name: "X25519" },
        true,
        ["deriveKey", "deriveBits"]
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
        ["verify"]
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
        []
    );
}

/**
 * Exports the private key.
 * For X25519 and Ed25519, this returns the PKCS#8 encoded key.
 * @param {CryptoKey} privateKey
 * @returns {Promise<Uint8Array>}
 */
export async function exportPrivateKey(privateKey) {
    const exported = await crypto.subtle.exportKey("pkcs8", privateKey);
    return new Uint8Array(/** @type {any} */ (exported));
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
        ["sign"]
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
        ["deriveKey", "deriveBits"]
    );
}
