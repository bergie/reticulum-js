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
    exportRawPrivateKey,
    importRawEd25519PrivateKey,
    importRawX25519PrivateKey
} from '../crypto/keys.js';
import { hkdf } from '../crypto/ciphers.js';
import { Token } from '../crypto/token.js';

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
        const x25519PrivBytes = await exportRawPrivateKey(this.x25519Priv);
        const ed25519PrivBytes = await exportRawPrivateKey(this.ed25519Priv);
        const x25519PubBytes = await exportPublicKey(this.x25519Pub);
        const ed25519PubBytes = await exportPublicKey(this.ed25519Pub);
        
        const priv_key = new Uint8Array(128);
        priv_key.set(x25519PrivBytes, 0);
        priv_key.set(x25519PubBytes, 32);
        priv_key.set(ed25519PrivBytes, 64);
        priv_key.set(ed25519PubBytes, 96);
        return priv_key;
    }

    /**
     * Get the public key as bytes.
     * @returns {Promise<Uint8Array>}
     */
    async get_public_key() {
        const x25519PubBytes = await exportPublicKey(this.x25519Pub);
        const ed25519PubBytes = await exportPublicKey(this.ed25519Pub);
        
        const public_key = new Uint8Array(64);
        public_key.set(x25519PubBytes, 0);
        public_key.set(ed25519PubBytes, 32);
        return public_key;
    }

    /**
     * Load an identity from raw bytes.
     * @param {Uint8Array} bytes
     * @returns {Promise<Identity|null>}
     */
    static async from_bytes(bytes) {
        try {
            const x25519Priv = await importRawX25519PrivateKey(bytes.slice(0, 32));
            const x25519Pub = await importX25519PublicKey(bytes.slice(32, 64));
            const ed25519Priv = await importRawEd25519PrivateKey(bytes.slice(64, 96));
            const ed25519Pub = await importEd25519PublicKey(bytes.slice(96, 128));
            
            const public_key = new Uint8Array(64);
            public_key.set(bytes.slice(32, 64), 0);
            public_key.set(bytes.slice(96, 128), 32);

            const hashBuffer = await crypto.subtle.digest("SHA-256", public_key);
            const identity_hash = new Uint8Array(hashBuffer.slice(0, 16));

            return new Identity(x25519Priv, ed25519Priv, x25519Pub, ed25519Pub, public_key, identity_hash);
        } catch (e) {
            console.error("Failed to load identity from bytes:", e);
            return null;
        }
    }

    /**
     * Get the salt for HKDF.
     * @returns {Uint8Array}
     */
    get_salt() {
        return this.identity_hash;
    }

    /**
     * Get the context for HKDF.
     * @returns {Uint8Array|null}
     */
    get_context() {
        return null;
    }

    /**
     * Encrypt information for the identity.
     * @param {Uint8Array} plaintext
     * @param {Uint8Array|null} ratchet
     * @returns {Promise<Uint8Array>}
     */
    async encrypt(plaintext, ratchet = null) {
        if (!this.ed25519Pub) throw new Error("Encryption failed because identity does not hold a public key");

        const ephemeral_key = await generateX25519KeyPair();
        const ephemeral_pub_bytes = await exportPublicKey(ephemeral_key.publicKey);

        let target_public_key;
        if (ratchet) {
            target_public_key = await crypto.subtle.importKey("raw", ratchet, { name: "X25519" }, true, []);
        } else {
            target_public_key = this.x25519Pub;
        }

        const shared_key_buffer = await crypto.subtle.deriveBits(
            {
                name: "X25519",
                public: target_public_key
            },
            ephemeral_key.privateKey,
            256
        );
        const shared_key = new Uint8Array(shared_key_buffer);
        const derived_key = await hkdf(shared_key, this.get_salt(), this.get_context() || new Uint8Array(0), 64);

        const token = new Token(derived_key);
        const ciphertext = await token.encrypt(plaintext);

        const result = new Uint8Array(ephemeral_pub_bytes.length + ciphertext.length);
        result.set(ephemeral_pub_bytes, 0);
        result.set(ciphertext, ephemeral_pub_bytes.length);

        return result;
    }

    /**
     * Decrypt information for the identity.
     * @param {Uint8Array} ciphertext_token
     * @param {Array<Uint8Array>|null} ratchets
     * @returns {Promise<Uint8Array|null>}
     */
    async decrypt(ciphertext_token, ratchets = null) {
        if (!this.ed25519Priv) throw new Error("Decryption failed because identity does not hold a private key");

        if (ciphertext_token.length > 32) {
            const peer_pub_bytes = ciphertext_token.slice(0, 32);
            const ciphertext = ciphertext_token.slice(32);
            const peer_pub = await crypto.subtle.importKey("raw", peer_pub_bytes, { name: "X25519" }, true, []);

            let plaintext = null;

            if (ratchets) {
                for (const ratchet of ratchets) {
                    try {
                        const ratchet_prv = await importRawX25519PrivateKey(ratchet);
                        const shared_key_buffer = await crypto.subtle.deriveBits(
                            {
                                name: "X25519",
                                public: peer_pub
                            },
                            ratchet_prv,
                            256
                        );
                        const shared_key = new Uint8Array(shared_key_buffer);
                        const derived_key = await hkdf(shared_key, this.get_salt(), this.get_context() || new Uint8Array(0), 64);
                        const token = new Token(derived_key);
                        plaintext = await token.decrypt(ciphertext);
                        if (plaintext) break;
                    } catch (e) {
                        // continue to next ratchet
                    }
                }
            }

            if (!plaintext) {
                try {
                    const shared_key_buffer = await crypto.subtle.deriveBits(
                        {
                            name: "X25519",
                            public: peer_pub
                        },
                        this.x25519Priv,
                        256
                    );
                    const shared_key = new Uint8Array(shared_key_buffer);
                    const derived_key = await hkdf(shared_key, this.get_salt(), this.get_context() || new Uint8Array(0), 64);
                    const token = new Token(derived_key);
                    plaintext = await token.decrypt(ciphertext);
                } catch (e) {
                    plaintext = null;
                }
            }

            return plaintext;
        } else {
            return null;
        }
    }

    /**
     * Signs information by the identity.
     * @param {Uint8Array} message
     * @returns {Promise<Uint8Array>}
     */
    async sign(message) {
        if (!this.ed25519Priv) throw new Error("Signing failed because identity does not hold a private key");
        const signature = await crypto.subtle.sign(
            "Ed25519",
            this.ed25519Priv,
            message
        );
        return new Uint8Array(signature);
    }

    /**
     * Validates the signature of a signed message.
     * @param {Uint8Array} signature
     * @param {Uint8Array} message
     * @returns {Promise<boolean>}
     */
    async validate(signature, message) {
        if (!this.ed25519Pub) throw new Error("Signature validation failed because identity does not hold a public key");
        return await crypto.subtle.verify(
            "Ed25519",
            this.ed25519Pub,
            signature,
            message
        );
    }
}
