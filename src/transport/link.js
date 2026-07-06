// src/transport/link.js

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, Packet } from "../core/packet.js";
import { hkdf } from "../crypto/ciphers.js";
import { Token } from "../crypto/token.js";
import { toHex } from "../utils/encoding.js";

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
    // Ensure received packets are processed in order
    this._rxQueue = Promise.resolve();
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
  /**
   * Queues an incoming packet for strict sequential processing.
   * @param {import("../core/packet.js").Packet} packet
   */
  async receive(packet) {
    // Chain the new packet onto the queue. It will not execute until
    // all previous packets have completely finished their async tasks.
    this._rxQueue = this._rxQueue
      .then(() => this._processPacket(packet))
      .catch((err) => {
        console.error("[LINK] Error processing packet in queue:", err);
      });

    await this._rxQueue;
  }

  /**
   * The actual decryption and multiplexing logic (your previous receive method).
   * @private
   */
  async _processPacket(packet) {
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
      raw: packet.payload,
    });

    // Route based on Reticulum Context Byte
    switch (decryptedPacket.contextByte) {
      case ContextType.NONE: // Standard Data
        this.dispatchEvent(
          new CustomEvent("data", {
            detail: { packet: decryptedPacket, link: this.linkId },
          }),
        );
        break;
      case ContextType.RESOURCE:
      case ContextType.RESOURCE_ADV:
      case ContextType.RESOURCE_REQ:
      case ContextType.RESOURCE_HMU:
      case ContextType.RESOURCE_HMU:
      case ContextType.RESOURCE_ICL:
      case ContextType.RESOURCE_RCL:
      case ContextType.RESOURCE_PRF:
        // Dispatch to your future Resource handler
        this.dispatchEvent(
          new CustomEvent("resource", { detail: { packet: decryptedPacket } }),
        );
        break;
      case ContextType.KEEPALIVE: // Packet.KEEPALIVE
        this.dispatchEvent(
          new CustomEvent("keepalive", { detail: { packet: decryptedPacket } }),
        );
        break;
      case ContextType.LPROOF: // Packet.LRPROOF
        this.dispatchEvent(
          new CustomEvent("lrproof", { detail: { packet: decryptedPacket } }),
        );
        break;
      case ContextType.IDENTIFY: {
        const peerPublicKey = decryptedPacket.payload; // 64 bytes
        const peerIdentity = await Identity.fromPublicKey(peerPublicKey);
        const identityHash = await Identity.truncatedHash(
          peerIdentity.publicKey,
        );
        const packetHash = await Identity.truncatedHash(packet.raw);

        // ONLY store by Identity Hash. Do not store by senderDestHash here.
        await Destination.remember(packetHash, identityHash, peerPublicKey);

        this.dispatchEvent(
          new CustomEvent("identify", {
            detail: {
              identity: peerIdentity,
              link: this.linkId,
            },
          }),
        );
        break;
      }
      default:
        console.warn(
          `[LINK] Ignored packet with unknown context: 0x${decryptedPacket.contextByte.toString(16)}`,
        );
    }
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
