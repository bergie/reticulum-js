/**
 * @file ciphers.js
 * @description AES-128-CBC, HKDF derivation
 */

/**
 * Derives a key using HKDF.
 * @param {CryptoKey} masterKey - The master key to derive from.
 * @param {Uint8Array} salt - The salt for HKDF.
 * @param {Uint8Array} info - The info for HKDF.
 * @param {number} length - The length of the key to derive in bits.
 * @param {string} algorithm - The name of the algorithm to derive (e.g., "AES-CBC").
 * @param {Array<string>} usages - The usages for the derived key.
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(masterKey, salt, info, length, algorithm, usages) {
    return await crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: /** @type {any} */ (salt),
            info: /** @type {any} */ (info)
        },
        masterKey,
        { name: algorithm, length: length },
        false,
        /** @type {any} */ (usages)
    );
}

/**
 * Encrypts a Uint8Array using AES-CBC.
 * @param {CryptoKey} key - The AES-CBC key.
 * @param {Uint8Array} iv - 16-byte initialization vector.
 * @param {Uint8Array} data - Plaintext data.
 * @returns {Promise<Uint8Array>}
 */
export async function encryptAES(key, iv, data) {
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: /** @type {any} */ (iv) },
        key,
        /** @type {any} */ (data)
    );
    return new Uint8Array(/** @type {any} */ (encrypted));
}

/**
 * Decrypts a Uint8Array using AES-CBC.
 * @param {CryptoKey} key - The AES-CBC key.
 * @param {Uint8Array} iv - 16-byte initialization vector.
 * @param {Uint8Array} data - Ciphertext data.
 * @returns {Promise<Uint8Array>}
 */
export async function decryptAES(key, iv, data) {
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-CBC", iv: /** @type {any} */ (iv) },
        key,
        /** @type {any} */ (data)
    );
    return new Uint8Array(/** @type {any} */ (decrypted));
}
