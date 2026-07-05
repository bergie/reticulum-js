// src/transport/link.js

import { Packet } from "../core/packet.js";
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
  /**
   * @param {any} destination
   * @param {Uint8Array} linkId
   * @param {import("../crypto/keys.js").KeyPair} ephemeralKeyPair
   * @param {Uint8Array} peerPubBytes
   * @param {import("../transport/transport.js").TransportCore|null} [transport=null]
   */
  constructor(
    destination,
    linkId,
    ephemeralKeyPair,
    peerPubBytes,
    transport = null,
  ) {
    super();
    this.destination = destination;
    this.linkId = linkId;
    this.ephemeralKeyPair = ephemeralKeyPair;
    this.peerPubBytes = peerPubBytes;
    this.transport = transport;
    // Do NOT instantiate the Token here yet
    this.token = null;
  }

  /**
   * Encrypts and sends a packet.
   * @param {import("../core/packet.js").Packet} packet
   */
  async send(packet) {
    if (!this.token) {
      throw new Error("Link token not available. Did you call deriveKeys()?");
    }
    if (!this.transport) {
      throw new Error("Link transport not available.");
    }

    const encryptedPayload = await this.token.encrypt(packet.payload);

    const encryptedPacket = new Packet({
      headerType: packet.headerType,
      hops: packet.hops,
      transportType: packet.transportType,
      destinationType: packet.destinationType,
      packetType: packet.packetType,
      contextFlag: packet.contextFlag,
      destinationHash: packet.destinationHash,
      contextByte: packet.contextByte,
      payload: encryptedPayload,
      transportId: packet.transportId,
    });

    await this.transport.sendPacket(encryptedPacket);
  }

  /**
   * Decrypts an incoming packet and dispatches the plaintext.
   * @param {import("../core/packet.js").Packet} packet
   */
  async receive(packet) {
    if (!this.token) {
      throw new Error("Link token not available. Did you call deriveKeys()?");
    }

    const decryptedPayload = await this.token.decrypt(packet.payload);

    const decryptedPacket = new Packet({
      headerType: packet.headerType,
      hops: packet.hops,
      transportType: packet.transportType,
      destinationType: packet.destinationType,
      packetType: packet.packetType,
      contextFlag: packet.contextFlag,
      destinationHash: packet.destinationHash,
      contextByte: packet.contextByte,
      payload: decryptedPayload,
      transportId: packet.transportId,
    });

    this.dispatchEvent(
      new CustomEvent("data", { detail: { packet: decryptedPacket } }),
    );
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
