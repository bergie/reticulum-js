// src/transport/link.js
import { hkdf } from "../crypto/ciphers.js";
import { Token } from "../crypto/token.js";

/**
 * Handles the cryptographic derivation of link keys.
 */
export class LinkEncryption {
  /**
   * Derives a symmetric link key using ECIES (X25519 + HKDF).
   * @param {CryptoKey} localPrivateX25519 - Local ephemeral X25519 private key.
   * @param {CryptoKey} remotePublicX25519 - Remote ephemeral X25519 public key.
   * @param {Uint8Array} salt - Salt for HKDF (typically the identity hash).
   * @returns {Promise<Uint8Array>} A 64-byte key for Token (AES_256_CBC mode).
   */
  static async deriveLinkKey(localPrivateX25519, remotePublicX25519, salt) {
    // 1. ECDH Shared Secret
    const sharedSecretBits = await crypto.subtle.deriveBits(
      { name: "X25519", public: remotePublicX25519 },
      localPrivateX25519,
      256,
    );

    // 2. Import Master Key for HKDF
    const hkdfMasterKey = await crypto.subtle.importKey(
      "raw",
      sharedSecretBits,
      { name: "HKDF" },
      false,
      ["deriveKey"],
    );

    // 3. Derive 64-byte key for Token (AES_256_CBC mode)
    // We use HKDF to expand the shared secret into a 64-byte key.
    return await hkdf(hkdfMasterKey, salt, new Uint8Array(0), 64);
  }
}

export class Link extends EventTarget {
  constructor(destination, linkId, ephemeralKeyPair, peerPubBytes) {
    super();
    this.destination = destination;
    this.linkId = linkId;
    this.ephemeralKeyPair = ephemeralKeyPair;
    this.peerPubBytes = peerPubBytes;
    // Do NOT instantiate the Token here yet
    this.token = null;
  }

  // Call this immediately after instantiation
  async deriveKeys() {
    // 1. Import the peer's X25519 public key
    const peerPub = await crypto.subtle.importKey(
      "raw",
      this.peerPubBytes,
      { name: "X25519" },
      true,
      [],
    );

    // 2. Perform ECDH to get the 32-byte shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      {
        name: "X25519",
        public: peerPub,
      },
      this.ephemeralKeyPair.privateKey,
      256, // 32 bytes
    );
    const sharedSecret = new Uint8Array(sharedBits);

    // 3. Expand the 32-byte secret to 64 bytes using HKDF
    // In Reticulum links, the linkId is used as the salt.
    const derivedKey = await hkdf(
      sharedSecret,
      this.linkId, // Salt
      new Uint8Array(0), // Context (usually empty for Links unless specified)
      64, // We need 64 bytes for the Token
    );

    // 4. NOW instantiate the token
    this.token = new Token(derivedKey);
  }
}
