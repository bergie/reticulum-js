// src/transport/link.js

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { hkdf } from "../crypto/ciphers.js";
import { Token } from "../crypto/token.js";
import { exportPublicKey } from "../crypto/keys.js";
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

    return await hkdf(hkdfMasterKey, salt, new Uint8Array(0), 64);
  }
}

export class Link extends EventTarget {
  /** @type {number} */
  mode = 0;

  /**
   * @param {Destination} destination
   * @param {Uint8Array} linkId
   * @param {import("../crypto/keys.js").KeyPair} ephemeralKeyPair
   * @param {Uint8Array} peerPubBytes
   * @param {CryptoKey} [sigPrv] - The Ed25519 private key for identity proofing.
   * @param {Uint8Array} [sigPubBytes] - The Ed25519 public key for identity proofing.
   * @param {import("../transport/transport.js").TransportCore} [transport=null]
   */
  constructor(
    destination,
    linkId,
    ephemeralKeyPair,
    peerPubBytes,
    sigPrv = null,
    sigPubBytes = null,
    transport = null,
  ) {
    super();
    this.destination = destination;
    this.linkId = linkId;
    this.ephemeralKeyPair = ephemeralKeyPair;
    this.peerPubBytes = peerPubBytes;
    this.sigPrv = sigPrv;
    this.sigPubBytes = sigPubBytes;
    this.transport = transport;
    this.mtu = 1024;
    this.token = null;
    this._rxQueue = Promise.resolve();

    // Store pending resources waiting for a RESOURCE_REQ from NomadNet
    this.pendingResources = new Map();
  }

  register_incoming_resource(resource) {
    this.addEventListener("resource", (event) => {
      const { packet } = /** @type {any} */ (event).detail;
      if (resource.link && toHex(packet.destinationHash) === toHex(resource.link.linkId)) {
        resource.receivePart(packet);
      }
    });
  }

  /**
   * Encrypts and sends a packet.
   * CRITICAL FIX: Forces link-layer routing.
   * @param {Packet} packet
   */
  async send(packet) {
    if (!this.token) {
      throw new Error("Link token not available. Did you call deriveKeys()?");
    }
    if (!this.transport) {
      throw new Error("Link transport not available.");
    }

    const encryptedPayload = await this.encrypt(packet.payload);

    // FIX: Regardless of what the application requested, if this packet
    // goes over a Link, the outer transport frame MUST be addressed to the Link.
    // This prevents the "Ratchet HMAC" error on the receiving end.
    const encryptedPacket = new Packet({
      headerType: packet.headerType,
      hops: packet.hops,
      transportType: packet.transportType,

      destinationType: DestType.LINK,
      destinationHash: this.linkId,

      packetType: packet.packetType,
      contextFlag: packet.contextFlag,
      contextByte: packet.contextByte,
      payload: encryptedPayload,
      transportId: packet.transportId,
    });

    await this.transport.sendPacket(encryptedPacket);
  }

  /**
   * Initiates a Resource transfer over the link.
   * LXMF strictly requires all link-based payloads to be wrapped as Resources.
   * @param {Uint8Array} msgpackData - The serialized LXMF message buffer
   * @returns {Promise<Uint8Array>} The 32-byte resource hash
   */
  async sendResourceAdvertisement(msgpackData) {
    // 1. Calculate SHA-256 hash of the payload
    const dataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", msgpackData));

    // 2. Pack the payload size as a 64-bit big-endian integer (8 bytes)
    const sizeBuffer = new ArrayBuffer(8);
    const sizeView = new DataView(sizeBuffer);
    sizeView.setBigUint64(0, BigInt(msgpackData.length), false);

    // 3. Construct Reticulum RESOURCE_ADV payload: [32-byte hash][8-byte size]
    const advPayload = new Uint8Array(40);
    advPayload.set(dataHash, 0);
    advPayload.set(new Uint8Array(sizeBuffer), 32);

    // 4. Save the payload in memory to respond when NomadNet requests it
    this.pendingResources.set(toHex(dataHash), msgpackData);

    // 5. Send the Advertisement packet over the link
    const advPacket = new Packet({
      packetType: PacketType.DATA,
      contextByte: ContextType.RESOURCE_ADV,
      payload: advPayload,
    });

    await this.send(advPacket);

    return dataHash;
  }

  /**
   * Proves the identity of this link.
   */
  async prove() {
    if ((!this.sigPrv && !this.sigPubBytes) || !this.destination?.identity) {
      throw new Error("Link identity proof requires an identity's signing key.");
    }

    const signallingBytes = this.signallingBytes(this.mtu, this.mode);
    const pubBytes = await exportPublicKey(this.ephemeralKeyPair.publicKey);

    const signedData = new Uint8Array(this.linkId.length + pubBytes.length + this.sigPubBytes.length + signallingBytes.length);
    signedData.set(this.linkId, 0);
    signedData.set(pubBytes, this.linkId.length);
    signedData.set(this.sigPubBytes, this.linkId.length + pubBytes.length);
    signedData.set(signallingBytes, this.linkId.length + pubBytes.length + this.sigPubBytes.length);

    const signature = await this.destination.identity.sign(signedData);

    const proofPayload = new Uint8Array(signature.length + pubBytes.length + signallingBytes.length);
    proofPayload.set(signature, 0);
    proofPayload.set(pubBytes, signature.length);
    proofPayload.set(signallingBytes, signature.length + pubBytes.length);

    const proofPacket = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LRPROOF,
      payload: proofPayload,
    });

    // Proof packets are not encrypted
    await this.transport.sendPacket(proofPacket);
  }

  /**
   * @param {number} mtu
   * @param {number} mode
   * @returns {Uint8Array}
   */
  signallingBytes(mtu, mode) {
    const MTU_BYTEMASK = 0x1FFFFF;
    const MODE_BYTEMASK = 0xE0;
    const signallingValue = (mtu & MTU_BYTEMASK) + (((mode << 5) & MODE_BYTEMASK) << 16);
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setUint32(0, signallingValue, false);
    return new Uint8Array(buffer.slice(1));
  }

  /**
   * @param {Uint8Array} data
   * @return {Promise<Uint8Array>}
   */
  async encrypt(data) {
    return await this.token.encrypt(data);
  }

  /**
   * @param {Uint8Array} data
   * @return {Promise<Uint8Array>}
   */
  async sign(data) {
    if (!this.sigPrv || !this.sigPubBytes) {
      throw new Error("Link proof requires a signing key.");
    }
    if (this.sigPrv) {
      const signature = await crypto.subtle.sign(
        "Ed25519",
        this.sigPrv,
        /** @type {any} */ (data),
      );
      return new Uint8Array(signature);
    }
  }

  /**
   * @param {Packet} packet
   */
  async provePacket(packet) {
    const packetHash = await packet.getHash();
    const signature = await this.sign(packetHash);

    const proofPayload = new Uint8Array(96);
    proofPayload.set(packetHash, 0);
    proofPayload.set(signature, 32);
    const proofPacket = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      payload: proofPayload,
    });
    // Packet PROOFs are not encrypted
    await this.transport.sendPacket(proofPacket);
  }

  /**
   * @param {Packet} packet
   */
  async receive(packet) {
    this._rxQueue = this._rxQueue
      .then(() => this._processPacket(packet))
      .catch((err) => {
        console.error("[LINK] Error processing packet in queue:", err);
      });
    await this._rxQueue;
  }

  /**
   * @param {Packet} packet
   */
  async _processPacket(packet) {
    if (!this.token) {
      throw new Error("Link token not available. Did you call deriveKeys()?");
    }

    let decryptedPayload;
    if (packet.packetType === PacketType.PROOF) {
      decryptedPayload = packet.payload;
    } else {
      decryptedPayload = await /** @type {any} */ (this.token).decrypt(packet.payload);
    }

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

    switch (decryptedPacket.contextByte) {
      case ContextType.NONE:
        if (this.transport && decryptedPacket.packetType !== PacketType.PROOF) {
          await this.provePacket(packet);
        }
        if (decryptedPacket.packetType !== PacketType.PROOF) {
          this.dispatchEvent(
            new CustomEvent("data", {
              detail: { packet: decryptedPacket, link: this.linkId },
            }),
          );
        } else {
          this.dispatchEvent(
            new CustomEvent("proof", { detail: { packet: decryptedPacket } }),
          );
        }
        break;

      case ContextType.RESOURCE_REQ: {
        // When NomadNet receives your ADV, it responds here.
        // Extract the requested hash and begin sending MTU-sized chunks.
        const requestedHashHex = toHex(decryptedPacket.payload);
        const resourceData = this.pendingResources.get(requestedHashHex);
        if (resourceData) {
           console.log(`[LINK] Remote requested resource ${requestedHashHex}, starting transfer...`);
           // TODO: Implement the chunking loop using ContextType.RESOURCE
        }
        break;
      }

      case ContextType.RESOURCE:
      case ContextType.RESOURCE_ADV:
      case ContextType.RESOURCE_HMU:
      case ContextType.RESOURCE_ICL:
      case ContextType.RESOURCE_RCL:
      case ContextType.RESOURCE_PRF:
        this.dispatchEvent(
          new CustomEvent("resource", { detail: { packet: decryptedPacket } }),
        );
        break;

      case ContextType.KEEPALIVE:
        this.dispatchEvent(
          new CustomEvent("keepalive", { detail: { packet: decryptedPacket } }),
        );
        break;

      case ContextType.LRPROOF:
        this.dispatchEvent(
          new CustomEvent("lrproof", { detail: { packet: decryptedPacket } }),
        );
        break;

      case ContextType.IDENTIFY: {
        const peerPublicKey = decryptedPacket.payload;
        const peerIdentity = await Identity.fromPublicKey(peerPublicKey);
        const identityHash = await Identity.truncatedHash(
          peerIdentity.publicKey,
        );
        const packetHash = await Identity.truncatedHash(packet.raw);

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

      case ContextType.LINKCLOSE: {
        this.dispatchEvent(
          new CustomEvent("close", { detail: { packet: decryptedPacket } }),
        );
        break;
      }

      default:
        console.warn(
          `[LINK] Ignored packet with unknown context: 0x${decryptedPacket.contextByte.toString(16)}`,
        );
    }
  }

  async deriveKeys() {
    const peerPub = await crypto.subtle.importKey(
      "raw",
      this.peerPubBytes,
      { name: "X25519" },
      true,
      [],
    );

    const sharedBits = await crypto.subtle.deriveBits(
      {
        name: "X25519",
        public: peerPub,
      },
      this.ephemeralKeyPair.privateKey,
      256,
    );
    const sharedSecret = new Uint8Array(sharedBits);

    const derivedKey = await hkdf(
      sharedSecret,
      /** @type {any} */ (this.linkId),
      new Uint8Array(0),
      64,
    );

    this.derivedKey = derivedKey;
    this.token = new Token(derivedKey);
  }
}
