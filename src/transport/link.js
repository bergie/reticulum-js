// src/transport/link.js

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, Packet } from "../core/packet.js";
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
      raw: packet.payload,
    });

    // Route based on Reticulum Context Byte
    switch (decryptedPacket.contextByte) {
      case 0x00: // Packet.NONE (Standard Data)
        this.dispatchEvent(
          new CustomEvent("data", { detail: { packet: decryptedPacket } }),
        );
        break;
      case 0x01: // Packet.RESOURCE
      case 0x02: // Packet.RESOURCE_ADV
      case 0x03: // Packet.RESOURCE_REQ
      case 0x04: // Packet.RESOURCE_HMAC
      case 0x05: // Packet.RESOURCE_PRF
        // Dispatch to your future Resource handler
        this.dispatchEvent(
          new CustomEvent("resource", { detail: { packet: decryptedPacket } }),
        );
        break;
      case 0x06: // Packet.KEEPALIVE
        this.dispatchEvent(
          new CustomEvent("keepalive", { detail: { packet: decryptedPacket } }),
        );
        break;
      case 0x08: // Packet.LRPROOF
        this.dispatchEvent(
          new CustomEvent("lrproof", { detail: { packet: decryptedPacket } }),
        );
        break;
      case ContextType.IDENTIFY: {
        console.log(
          `[LINK] Received IDENTIFY packet. Caching peer identity...`,
        );

        // The decrypted payload contains the 64-byte public key
        const peerPublicKey = decryptedPacket.payload;

        try {
          // 1. Reconstruct the Identity from the raw public key bytes
          const peerIdentity = await Identity.fromPublicKey(peerPublicKey);

          // 2. Calculate the Identity Hash (this is what LXMF will use as the sourceHash)
          const identityHash = await Identity.truncatedHash(
            peerIdentity.publicKey,
          );

          // 3. We need a packet hash for the remember() signature.
          // If your packet object doesn't have its wire hash attached yet, we can
          // provide a fallback. In the Python reference, this is primarily used
          // to prevent replay attacks on public Announces, so a zeroed array
          // or a hash of the decrypted payload is fine for Link Identity caching.
          const packetHash = await Identity.truncatedHash(packet.raw);

          // 4. Cache it in your local known destinations!
          await Destination.remember(packetHash, identityHash, peerPublicKey);

          this.dispatchEvent(
            new CustomEvent("identify", {
              detail: { identity: peerIdentity },
            }),
          );
        } catch (err) {
          console.error("[LINK] Failed to process peer identity:", err);
        }
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
