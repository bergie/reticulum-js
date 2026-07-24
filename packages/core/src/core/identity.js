/**
 * @file identity.js
 * @description Identity creation, signing, and verification
 */

/* @ts-self-types="../../types/src/core/identity.d.ts" */

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
import { bytesEqual } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";

/**
 * Result of a successful announce validation (SPEC.md §4.5).
 *
 * @typedef {Object} AnnounceValidation
 * @property {Identity} identity - Identity reconstructed from the announced public key.
 * @property {Uint8Array} nameHash - 10-byte name_hash from the announce body.
 * @property {Uint8Array} randomHash - 10-byte random_hash (5 random || 5-byte BE uint40 timestamp).
 * @property {Uint8Array|null} ratchet - 32-byte ratchet X25519 pub if context_flag was set, else null.
 * @property {Uint8Array} signature - 64-byte Ed25519 signature.
 * @property {Uint8Array|null} appData - app_data bytes if present in the announce, else null.
 */

/**
 * Represents a Reticulum Identity.
 * @description Identity creation, signing, and verification
 */
export class Identity extends EventTarget {
  static TRUNCATED_HASHLENGTH = 128;

  appData = new Uint8Array();

  /**
   * Low-level constructor. Prefer the static factories (`Identity.generate`,
   * `Identity.fromPublicKey`, `Identity.fromBytes`).
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
   * Sets the application-specific metadata attached to announcements.
   * @param {string} data
   */
  setAppData(data) {
    this.appData = new TextEncoder().encode(data);
  }

  /**
   * Returns the application-specific metadata as a UTF-8 string.
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
      log(
        "Identity",
        "No storage adapter provided. Generating ephemeral identity.",
        LogLevel.WARNING,
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
      log(
        "Identity",
        `Failed to load identity from storage, generating new one: ${e}`,
        LogLevel.WARNING,
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
   * Returns 16 fresh random bytes (`TRUNCATED_HASHLENGTH//8`).
   *
   * Mirrors `RNS.Identity.get_random_hash()`. Despite the name this is plain
   * randomness, not a hash of anything. It is the source of the random half
   * of the announce `random_hash` (SPEC.md §4.1) and the Resource random-hash
   * prefix (§10.2 step 3).
   *
   * @returns {Uint8Array} 16 random bytes.
   */
  static getRandomHash() {
    return crypto.getRandomValues(
      new Uint8Array(Identity.TRUNCATED_HASHLENGTH / 8),
    );
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
      log(
        "Identity",
        `Failed to load identity from bytes: ${e}`,
        LogLevel.ERROR,
      );
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

    const result = new Uint8Array(ephemeralPubBytes.length + ciphertext.length);
    result.set(ephemeralPubBytes, 0);
    result.set(ciphertext, ephemeralPubBytes.length);

    return result;
  }

  /**
   * Decrypt information for the identity.
   * @param {Uint8Array} ciphertextToken
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

  /**
   * Validates an announce exactly like `RNS/Identity.py::validate_announce`
   * (SPEC.md §4.5 steps 1-3).
   *
   * Parses the announce body — branching on `contextFlag` so a ratchet-bearing
   * announce shifts the signature 32 bytes deeper (§4.5 step 1) — verifies the
   * Ed25519 signature over the §4.2 `signed_data` (step 2), and recomputes the
   * destination hash from `(name_hash, public_key)` to confirm it matches the
   * outer packet header (step 3).
   *
   * The caller is responsible for the §4.5 step 4 public-key collision check
   * and step 6 caching, since those touch `Destination.knownDestinations`.
   *
   * @param {Uint8Array} destinationHash - 16-byte dest_hash from the outer packet header.
   * @param {boolean} contextFlag - the packet header's context_flag bit (ratchet present).
   * @param {Uint8Array} data - the announce body (packet payload).
   * @returns {Promise<AnnounceValidation|null>} null on any validation failure.
   */
  static async validateAnnounce(destinationHash, contextFlag, data) {
    // §4.5 step 1 — body parse, branching on context_flag. Offsets per the
    // spec table; a ratchet-bearing announce places the signature at [116:180]
    // instead of [84:148].
    const sigOffset = contextFlag ? 116 : 84;
    const sigEnd = sigOffset + 64; // 180 (ratchet) or 148 (no ratchet)
    if (data.length < sigEnd) {
      log(
        "Identity",
        `Announce body too short (${data.length} bytes; need ${sigEnd} for context_flag=${contextFlag ? 1 : 0})`,
        LogLevel.WARNING,
      );
      return null;
    }
    const publicKey = data.subarray(0, 64);
    const nameHash = data.subarray(64, 74);
    const randomHash = data.subarray(74, 84);
    /** @type {Uint8Array|null} */
    let ratchet = null;
    if (contextFlag) {
      ratchet = data.subarray(84, 116);
    }
    const signature = data.subarray(sigOffset, sigEnd);
    const appData = data.length > sigEnd ? data.slice(sigEnd) : null;

    const identity = await Identity.fromPublicKey(publicKey);

    // §4.5 step 2 — signature verification over §4.2 signed_data:
    //   destination_hash || public_key || name_hash || random_hash || ratchet || app_data
    // `ratchet` is b"" (empty, NOT absent) when context_flag == 0 and `app_data`
    // is b"" when absent. Re-using the body's destination_hash here would let a
    // sender forge announces for arbitrary destinations (§4.5 step 2 callout).
    const ratchetForSig = ratchet ?? new Uint8Array(0);
    const appDataForSig = appData ?? new Uint8Array(0);
    const signedData = new Uint8Array(
      destinationHash.length +
        publicKey.length +
        nameHash.length +
        randomHash.length +
        ratchetForSig.length +
        appDataForSig.length,
    );
    let offset = 0;
    signedData.set(destinationHash, offset);
    offset += destinationHash.length;
    signedData.set(publicKey, offset);
    offset += publicKey.length;
    signedData.set(nameHash, offset);
    offset += nameHash.length;
    signedData.set(randomHash, offset);
    offset += randomHash.length;
    signedData.set(ratchetForSig, offset);
    offset += ratchetForSig.length;
    signedData.set(appDataForSig, offset);

    const signatureOk = await identity.validate(signature, signedData);
    if (!signatureOk) {
      log(
        "Identity",
        "Announce signature verification failed — rejecting",
        LogLevel.WARNING,
      );
      return null;
    }

    // §4.5 step 3 — destination_hash recomputation.
    //   identity_hash = SHA256(public_key)[:16]
    //   expected_hash = SHA256(name_hash || identity_hash)[:16]
    // Catches both random hash collisions and active spoofing that pairs a
    // valid signature with an unrelated destination_hash.
    const combined = new Uint8Array(
      nameHash.length + identity.identityHash.length,
    );
    combined.set(nameHash, 0);
    combined.set(identity.identityHash, nameHash.length);
    const expectedHash = await Identity.truncatedHash(combined);
    if (!bytesEqual(expectedHash, destinationHash)) {
      log(
        "Identity",
        "Announce destination_hash mismatch — rejecting",
        LogLevel.WARNING,
      );
      return null;
    }

    identity.appData = appData ?? new Uint8Array();
    return { identity, nameHash, randomHash, ratchet, signature, appData };
  }
}
