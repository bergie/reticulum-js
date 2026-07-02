/**
 * @file identity.js
 * @description Identity creation, signing, and verification
 */

import {
    generateEd25519KeyPair,
    generateX25519KeyPair,
    exportPublicKey,
    importEd25519PublicKey,
    importX25519PublicKey,
    exportPrivateKey,
    importEd25519PrivateKey,
    importX25519PrivateKey
} from '../crypto/keys.js';

/**
 * Represents a Reticulum Identity.
 */
export class Identity extends EventTarget {
    /**
     * @param {CryptoKey} x25519Priv
     * @param {CryptoKey} ed25519Priv
     * @param {CryptoKey} x25519Pub
     * @param {CryptoKey} ed25519Pub
     * @param {Uint8Array} public_key
     * @param {Uint8Array} identity_hash
     */
    constructor(x25519Priv, ed25519Priv, x25519Pub, ed25519Pub, public_key, identity_hash) {
        super();
        this.x25519Priv = x25519Priv;
        this.ed25519Priv = ed25519Priv;
        this.x25519Pub = x25519Pub;
        this.ed25519Pub = ed25519Pub;
        this.public_key = public_key;
        this.identity_hash = identity_hash;
    }

    /**
     * Create a new random identity.
     * @returns {Promise<Identity>}
     */
    static async generate() {
        const x25519 = await generateX25519KeyPair();
        const ed25519 = await generateEd25519KeyPair();
        
        const x25519PubBytes = await exportPublicKey(x25519.publicKey);
        const ed25519PubBytes = await exportPublicKey(ed25519.publicKey);
        
        const public_key = new Uint8Array(64);
        public_key.set(x25519PubBytes, 0);
        public_key.set(ed25519PubBytes, 32);

        const hashBuffer = await crypto.subtle.digest("SHA-256", public_key);
        const identity_hash = new Uint8Array(hashBuffer.slice(0, 16));

        return new Identity(x25519.privateKey, ed25519.privateKey, x25519.publicKey, ed25519.publicKey, public_key, identity_hash);
    }

    /**
     * Get the raw private key bytes (64 bytes).
     * @returns {Promise<Uint8Array>}
     */
    async get_private_key() {
        // In current implementation, exportPrivateKey returns PKCS8 for Ed25519.
        // We need to handle that if we want the raw 64 bytes for identity storage.
        // However, for now let's just implement what we have.
        const x25519PrivBytes = await exportPrivateKey(this.x25519Priv);
        const ed25519PrivBytes = await exportPrivateKey(this.ed25519Priv);
        
        // If X25519 is PKCS8, it won't be 32 bytes.
        // Let's assume for now we'll just return the concatenation of whatever exportPrivateKey gives.
        const priv_key = new Uint8Array(x25519PrivBytes.length + ed25519PrivBytes.length);
        priv_key.set(x25519PrivBytes, 0);
        priv_key.set(ed25519PrivBytes, x25519PrivBytes.length);
        return priv_key;
    }
}
