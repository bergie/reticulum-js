/**
 * @file ciphers.js
 * @description AES-128-CBC, HKDF derivation
 */

import { hmac } from './hmac.js';

/**
 * Performs HKDF to derive bits.
 * @param {any} masterKey
 * @param {any} salt
 * @param {any} info
 * @param {number} lengthInBytes
 * @returns {Promise<Uint8Array>}
 */
export async function hkdf(masterKey, salt, info, lengthInBytes) {
    // HKDF-Extract
    const prk = await hmac(/** @type {any} */ (salt.length === 0 ? new Uint8Array(32) : salt), masterKey);

    // HKDF-Expand
    const okm = new Uint8Array(lengthInBytes);
    let lastT = new Uint8Array(0);
    let offset = 0;
    let counter = 1;

    while (offset < lengthInBytes) {
        const input = new Uint8Array(lastT.length + info.length + 1);
        input.set(lastT, 0);
        input.set(info, lastT.length);
        input[input.length - 1] = counter;

        const t = /** @type {any} */ (await hmac(prk, input));
        const toCopy = Math.min(t.length, lengthInBytes - offset);
        okm.set(/** @type {any} */ (t.slice(0, toCopy)), offset);
        
        offset += toCopy;
        lastT = t;
        counter++;
    }

    return okm;
}

/**
 * Derives a key using HKDF.
 * @param {CryptoKey} masterKey
 * @param {Uint8Array} salt
 * @param {Uint8Array} info
 * @param {number} lengthInBits
 * @param {string} algorithm
 * @param {Array<string>} usages
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(masterKey, salt, info, lengthInBits, algorithm, usages) {
    return await crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: /** @type {any} */ (salt),
            info: /** @type {any} */ (info)
        },
        masterKey,
        { name: algorithm, length: lengthInBits },
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
