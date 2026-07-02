/**
 * @file token.js
 * @description Token implementation (modified Fernet)
 */

import { hmac } from './hmac.js';
import { pkcs7 } from './pkcs7.js';
import { encryptAES, decryptAES } from './ciphers.js';

/**
 * @enum {string}
 */
export const MODE = {
    AES_128_CBC: 'AES_128_CBC',
    AES_256_CBC: 'AES_256_CBC'
};

/**
 * This class provides a slightly modified implementation of the Fernet spec.
 * Reticulum strips the version and timestamp fields from the token to reduce overhead.
 */
export class Token {
    /**
     * @param {Uint8Array} key
     * @param {string} [mode=MODE.AES_256_CBC]
     */
    constructor(key, mode = MODE.AES_256_CBC) {
        if (!key) throw new Error("Token key cannot be null");

        if (mode === MODE.AES_128_CBC) {
            if (key.length !== 32) throw new Error("Token key must be 32 bytes for AES_128_CBC");
            this.mode = MODE.AES_128_CBC;
            this.signingKey = key.slice(0, 16);
            this.encryptionKey = key.slice(16);
            this.algorithm = "AES-CBC";
        } else if (mode === MODE.AES_256_CBC) {
            if (key.length !== 64) throw new Error("Token key must be 64 bytes for AES_256_CBC");
            this.mode = MODE.AES_256_CBC;
            this.signingKey = key.slice(0, 32);
            this.encryptionKey = key.slice(32);
            this.algorithm = "AES-CBC";
        } else {
            throw new Error("Invalid token mode");
        }
    }

    /**
     * Generates a new random token key.
     * @param {string} [mode=MODE.AES_256_CBC]
     * @returns {Promise<Uint8Array>}
     */
    static async generateKey(mode = MODE.AES_256_CBC) {
        const length = mode === MODE.AES_128_CBC ? 32 : 64;
        return crypto.getRandomValues(new Uint8Array(length));
    }

    /**
     * Verifies the HMAC of a token.
     * @param {Uint8Array} token
     * @returns {Promise<boolean>}
     */
    async verifyHmac(token) {
        if (token.length <= 32) throw new Error("Cannot verify HMAC on token of only " + token.length + " bytes");
        const receivedHmac = token.slice(-32);
        const dataToVerify = token.slice(0, -32);
        const expectedHmac = await hmac(this.signingKey, dataToVerify);

        return this.constantTimeCompare(receivedHmac, expectedHmac);
    }

    /**
     * Encrypts the provided data.
     * @param {Uint8Array} data
     * @returns {Promise<Uint8Array>}
     */
    async encrypt(data) {
        if (!(data instanceof Uint8Array)) throw new TypeError("Token plaintext input must be Uint8Array");
        
        const iv = crypto.getRandomValues(new Uint8Array(16));
        const paddedData = pkcs7.pad(data);

        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            this.encryptionKey,
            { name: this.algorithm },
            false,
            ["encrypt"]
        );

        const ciphertext = await encryptAES(cryptoKey, iv, paddedData);
        
        const signedParts = new Uint8Array(iv.length + ciphertext.length);
        signedParts.set(iv, 0);
        signedParts.set(ciphertext, iv.length);

        const mac = await hmac(this.signingKey, signedParts);
        
        const token = new Uint8Array(signedParts.length + mac.length);
        token.set(signedParts, 0);
        token.set(mac, signedParts.length);
        
        return token;
    }

    /**
     * Decrypts the provided token.
     * @param {Uint8Array} token
     * @returns {Promise<Uint8Array>}
     */
    async decrypt(token) {
        if (!(token instanceof Uint8Array)) throw new TypeError("Token must be Uint8Array");
        if (!(await this.verifyHmac(token))) throw new Error("Token HMAC was invalid");

        const iv = token.slice(0, 16);
        const ciphertext = token.slice(16, -32);

        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            this.encryptionKey,
            { name: this.algorithm },
            false,
            ["decrypt"]
        );

        const decryptedPadded = await decryptAES(cryptoKey, iv, ciphertext);
        return pkcs7.unpad(decryptedPadded);
    }

    /**
     * Performs a constant-time comparison of two Uint8Arrays.
     * @param {Uint8Array} a
     * @param {Uint8Array} b
     * @returns {boolean}
     * @private
     */
    constantTimeCompare(a, b) {
        if (a.length !== b.length) return false;
        let result = 0;
        for (let i = 0; i < a.length; i++) {
            result |= a[i] ^ b[i];
        }
        return result === 0;
    }
}
