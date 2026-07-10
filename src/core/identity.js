/**
 * @file identity.js
 * @description Identity creation, signing, and verification
 */

import { hkdf } from "../crypto/ciphers.js";
import {
  exportPublicKey,
  exportRawPrivateKey,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  importEd25519PublicKey,
  importRawEd25519PrivateKey,
  importRawX25519PrivateKey,
  importX25519PublicKey,
} from "../crypto/keys.js";
import { Token } from "../crypto/token.js";

/**
 * Represents a Reticulum Identity.
 */
export class Identity extends EventTarget {
  static TRUNCATED_HASHLENGTH = 128;

  appData = new Uint8Array();

  /**
   * @param {CryptoKey|null} x25519Priv
   * @param {CryptoKey|null} ed25519Priv
   * @param {CryptoKey} x25519Pub
   * @param {CryptoKey} ed25519Pub
   * @param {Uint8Array} publicKey
   * @param {Uint8Array} identityHash
   */
  constructor(
    x25519Priv,
    ed25519Priv,
    x25519Pub,
    ed25519Pub,
    publicKey,
    identityHash,
  ) {
    super();
    this.x25519Priv = x25519Priv;
    this.ed25519Priv = ed25519Priv;
    this.x25519Pub = x25519Pub;
    this.ed25519Pub = ed25519Pub;
    this.publicKey = publicKey;
    this.identityHash = identityHash;
  }

  /**
   * @param {string} data
   */
  setAppData(data) {
    this.appData = new TextEncoder().encode(data);
  }

  /**
   * @returns {string}
   */
  getAppData() {
    return new TextDecoder().decode(this.appData);
  }

  /**
   * Attempts to load an identity from a storage adapter, or generates and saves a new one.
   * @param {any} [storageAdapter] - Must implement async loadKey() and async saveKey(bytes)
   * @returns {Promise<Identity>}
   */
  static async loadOrGenerate(storageAdapter) {
    if (!storageAdapter) {
      console.warn(
        "No storage adapter provided. Generating ephemeral identity.",
      );
      return await Identity.generate();
    }

    try {
      const savedBytes = await storageAdapter.loadKey();
      // Reticulum private keys export to exactly 128 bytes
      if (savedBytes && savedBytes.length === 128) {
        const identity = await Identity.fromBytes(savedBytes);
        if (identity) {
          return identity;
        }
      }
    } catch (e) {
      console.warn(
        "Failed to load identity from storage, generating new one:",
        e,
      );
    }

    // Fallback to generation if the file is missing or corrupt
    const newIdentity = await Identity.generate();
    const privateBytes = await newIdentity.getPrivateKey();
    await storageAdapter.saveKey(privateBytes);

    return newIdentity;
  }

  /**
   * Get a SHA-256 hash of passed data.
   * @param {Uint8Array} data
   * @returns {Promise<Uint8Array>}
   */
  static async fullHash(data) {
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      /** @type {any} */ (data),
    );
    return new Uint8Array(hashBuffer);
  }

  /**
   * Get a truncated SHA-256 hash of passed data.
   * @param {Uint8Array} data
   * @returns {Promise<Uint8Array>}
   */
  static async truncatedHash(data) {
    const fullHash = await Identity.fullHash(data);
    return fullHash.slice(0, Identity.TRUNCATED_HASHLENGTH / 8);
  }

  /**
   * Load an identity from a public key.
   * @param {Uint8Array} publicKey
   * @returns {Promise<Identity>}
   */
  static async fromPublicKey(publicKey) {
    // 1. Allocate pristine, strictly 32-byte buffers in memory
    const ed25519PubBytes = new Uint8Array(32);
    const x25519PubBytes = new Uint8Array(32);

    // 2. Perform a hard copy of the bytes, completely detaching
    // them from the underlying TCP packet ArrayBuffer.
    x25519PubBytes.set(publicKey.subarray(0, 32), 0);
    ed25519PubBytes.set(publicKey.subarray(32, 64), 0);

    const x25519Pub = await crypto.subtle.importKey(
      "raw",
      x25519PubBytes,
      { name: "X25519" },
      true,
      [],
    );

    const ed25519Pub = await crypto.subtle.importKey(
      "raw",
      ed25519PubBytes,
      { name: "Ed25519" },
      true,
      ["verify"],
    );

    // Re-slice safely for the identity hash
    const cleanPublicKey = new Uint8Array(64);
    cleanPublicKey.set(publicKey.subarray(0, 64), 0);

    const identityHash = await Identity.truncatedHash(cleanPublicKey);

    return new Identity(
      null,
      null,
      x25519Pub,
      ed25519Pub,
      cleanPublicKey,
      identityHash,
    );
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

    const publicKey = new Uint8Array(64);
    publicKey.set(x25519PubBytes, 0);
    publicKey.set(ed25519PubBytes, 32);

    const identityHash = await Identity.truncatedHash(publicKey);

    return new Identity(
      x25519.privateKey,
      ed25519.privateKey,
      x25519.publicKey,
      ed25519.publicKey,
      publicKey,
      identityHash,
    );
  }

  /**
   * Get the raw private key bytes (64 bytes).
   * @returns {Promise<Uint8Array>}
   */
  async getPrivateKey() {
    if (!this.x25519Priv || !this.ed25519Priv)
      throw new Error(
        "Cannot get private key because identity does not hold a private key",
      );
    const x25519PrivBytes = await exportRawPrivateKey(this.x25519Priv);
    const ed25519PrivBytes = await exportRawPrivateKey(this.ed25519Priv);
    const x25519PubBytes = await exportPublicKey(this.x25519Pub);
    const ed25519PubBytes = await exportPublicKey(this.ed25519Pub);

    const privKey = new Uint8Array(128);
    privKey.set(x25519PrivBytes, 0);
    privKey.set(x25519PubBytes, 32);
    privKey.set(ed25519PrivBytes, 64);
    privKey.set(ed25519PubBytes, 96);
    return privKey;
  }

  /**
   * Get the public key as bytes.
   * @returns {Promise<Uint8Array>}
   */
  async getPublicKey() {
    const x25519PubBytes = await exportPublicKey(this.x25519Pub);
    const ed25519PubBytes = await exportPublicKey(this.ed25519Pub);

    const publicKey = new Uint8Array(64);
    publicKey.set(x25519PubBytes, 0);
    publicKey.set(ed25519PubBytes, 32);
    return publicKey;
  }

  /**
   * Load an identity from raw bytes.
   * @param {Uint8Array} bytes
   * @returns {Promise<Identity|null>}
   */
  static async fromBytes(bytes) {
    try {
      const x25519Priv = await importRawX25519PrivateKey(bytes.slice(0, 32));
      const x25519Pub = await importX25519PublicKey(bytes.slice(32, 64));
      const ed25519Priv = await importRawEd25519PrivateKey(bytes.slice(64, 96));
      const ed25519Pub = await importEd25519PublicKey(bytes.slice(96, 128));

      const publicKey = new Uint8Array(64);
      publicKey.set(bytes.slice(32, 64), 0);
      publicKey.set(bytes.slice(96, 128), 32);

      const identityHash = await Identity.truncatedHash(publicKey);

      return new Identity(
        x25519Priv,
        ed25519Priv,
        x25519Pub,
        ed25519Pub,
        publicKey,
        identityHash,
      );
    } catch (e) {
      console.error("Failed to load identity from bytes:", e);
      return null;
    }
  }

  /**
   * Get the salt for HKDF.
   * @returns {Uint8Array}
   */
  getSalt() {
    return this.identityHash;
  }

  /**
   * Get the context for HKDF.
   * @returns {Uint8Array|null}
   */
  getContext() {
    return null;
  }

  /**
   * Encrypt information for the identity.
   * @param {Uint8Array} plaintext
   * @param {Uint8Array|null} ratchet
   * @returns {Promise<Uint8Array>}
   */
  async encrypt(plaintext, ratchet = null) {
    if (!this.ed25519Pub)
      throw new Error(
        "Encryption failed because identity does not hold a public key",
      );

    const ephemeralKey = await generateX25519KeyPair();
    const ephemeralPubBytes = await exportPublicKey(ephemeralKey.publicKey);

    let targetPublicKey;
    if (ratchet) {
      targetPublicKey = await crypto.subtle.importKey(
        "raw",
        /** @type {any} */ (ratchet),
        { name: "X25519" },
        true,
        [],
      );
    } else {
      targetPublicKey = this.x25519Pub;
    }

    const sharedKeyBuffer = await crypto.subtle.deriveBits(
      {
        name: "X25519",
        public: targetPublicKey,
      },
      /** @type {any} */ (ephemeralKey.privateKey),
      256,
    );
    const sharedKey = new Uint8Array(sharedKeyBuffer);
    const derivedKey = await hkdf(
      sharedKey,
      this.getSalt(),
      this.getContext() || new Uint8Array(0),
      64,
    );

    const token = new Token(derivedKey);
    const ciphertext = await token.encrypt(/** @type {any} */ (plaintext));

    const result = new Uint8Array(
      ephemeralPubBytes.length + ciphertext.length,
    );
    result.set(ephemeralPubBytes, 0);
    result.set(ciphertext, ephemeralPubBytes.length);

    return result;
  }

  /**
   * Decrypt information for the identity.
   * @param {Uint8Array} ciphertext_token
   * @param {Array<Uint8Array>|null} ratchets
   * @returns {Promise<Uint8Array|null>}
   */
  async decrypt(ciphertextToken, ratchets = null) {
    if (!this.ed25519Priv)
      throw new Error(
        "Decryption failed because identity does not hold a private key",
      );

    if (ciphertextToken.length > 32) {
      const peerPubBytes = ciphertextToken.slice(0, 32);
      const ciphertext = ciphertextToken.slice(32);
      const peerPub = await crypto.subtle.importKey(
        "raw",
        /** @type {any} */ (peerPubBytes),
        { name: "X25519" },
        true,
        [],
      );

      let plaintext = null;

      if (ratchets) {
        for (const ratchet of ratchets) {
          try {
            const ratchetPrv = await importRawX25519PrivateKey(ratchet);
            const sharedKeyBuffer = await crypto.subtle.deriveBits(
              {
                name: "X25519",
                public: peerPub,
              },
              /** @type {any} */ (ratchetPrv),
              256,
            );
            const sharedKey = new Uint8Array(sharedKeyBuffer);
            const derivedKey = await hkdf(
              sharedKey,
              this.getSalt(),
              this.getContext() || new Uint8Array(0),
              64,
            );
            const token = new Token(derivedKey);
            plaintext = await token.decrypt(ciphertext);
            if (plaintext) break;
          } catch (e) {
            // continue to next ratchet
          }
        }
      }

      if (!plaintext) {
        try {
          const sharedKeyBuffer = await crypto.subtle.deriveBits(
            {
              name: "X25519",
              public: peerPub,
            },
            /** @type {any} */ (this.x25519Priv),
            256,
          );
          const sharedKey = new Uint8Array(sharedKeyBuffer);
          const derivedKey = await hkdf(
            sharedKey,
            this.getSalt(),
            this.getContext() || new Uint8Array(0),
            64,
          );
          const token = new Token(derivedKey);
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
    if (!this.ed25519Priv)
      throw new Error(
        "Signing failed because identity does not hold a private key",
      );
    const signature = await crypto.subtle.sign(
      "Ed25519",
      this.ed25519Priv,
      /** @type {any} */ (message),
    );
    const sigArray = new Uint8Array(signature);

    if (sigArray.length !== 64) {
      throw new Error(
        `CRITICAL: Signature length is ${sigArray.length}, expected 64!`,
      );
    }
    return sigArray;
  }

  /**
   * Validates the signature of a signed message.
   * @param {Uint8Array} signature
   * @param {Uint8Array} messageId
   * @returns {Promise<boolean>}
   */
  async validate(signature, messageId) {
    const signatureView = new Uint8Array(
      signature.buffer,
      signature.byteOffset,
      64,
    );
    const dataView = new Uint8Array(
      messageId.buffer,
      messageId.byteOffset,
      messageId.byteLength,
    );
    const keyData = await crypto.subtle.exportKey("raw", this.ed25519Pub);

    return await crypto.subtle.verify(
      "Ed25519",
      this.ed25519Pub,
      /** @type {any} */ (signatureView),
      /** @type {any} */ (dataView),
    );
  }
}
