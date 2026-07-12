/** @enum {number} */
export const LinkStatus = {
  PENDING: 0,
  HANDSHAKE: 1,
  ACTIVE: 2,
  STALE: 3,
  CLOSED: 4,
};

/** @enum {number} */
export const LinkTeardownReason = {
  TIMEOUT: 0x01,
  INITIATOR_CLOSED: 0x02,
  DESTINATION_CLOSED: 0x03,
};

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
  mode = 0x01; // Default to AES_256_CBC

  /** @type {number} */
  rtt = 0;

  /** @type {Set<number>} */
  static UNENCRYPTED_CONTEXTS = new Set([
    ContextType.RESOURCE,
    ContextType.RESOURCE_ADV,
    ContextType.RESOURCE_HMU,
    ContextType.RESOURCE_ICL,
    ContextType.RESOURCE_RCL,
    ContextType.RESOURCE_PRF,
    ContextType.KEEPALIVE,
    ContextType.LINKIDENTIFY,
    ContextType.LINKCLOSE,
    ContextType.LRRTT,
    ContextType.LRPROOF,
  ]);

  /**
   * @param {Destination} destination
   * @param {Uint8Array} linkId
   * @param {import("../crypto/keys.js").KeyPair} ephemeralKeyPair - The ephemeral X25519 keypair.
   * @param {Uint8Array} peerPubBytes
   * @param {import("../crypto/keys.js").KeyPair} [ephemeralEd25519KeyPair] - The ephemeral Ed25519 keypair.
   * @param {CryptoKey} [sigPrv] - The Ed25519 private key for identity proofing.
   * @param {Uint8Array} [sigPubBytes] - The Ed25519 public key for identity proofing.
   * @param {import("../transport/transport.js").TransportCore} [transport=null]
   * @param {boolean} [initiator=false]
   */
  constructor(
    destination,
    linkId,
    ephemeralKeyPair,
    peerPubBytes,
    ephemeralEd25519KeyPair = null,
    sigPrv = null,
    sigPubBytes = null,
    transport = null,
    initiator = false,
  ) {
    super();
    this.destination = destination;
    this.linkId = linkId;
    this.ephemeralKeyPair = ephemeralKeyPair;
    this.peerPubBytes = peerPubBytes;
    this.ephemeralEd25519KeyPair = ephemeralEd25519KeyPair;
    this.sigPrv = sigPrv;
    this.sigPubBytes = sigPubBytes;
    this.transport = transport;
    this.initiator = initiator;
    this.mtu = 1024;
    this._status = LinkStatus.PENDING;
    this.teardownReason = null;
    this.token = null;
    this._rxQueue = Promise.resolve();

    // Store pending resources waiting for a RESOURCE_REQ from NomadNet
    this.pendingResources = new Map();
  }

  /**
   * @returns {LinkStatus}
   */
  get status() {
    return this._status;
  }

  /**
   * @param {LinkStatus} newStatus
   */
  set status(newStatus) {
    const oldStatus = this._status;
    this._status = newStatus;
    if (oldStatus !== newStatus) {
      this.dispatchEvent(
        new CustomEvent("statuschange", {
          detail: { status: newStatus, oldStatus },
        }),
      );

      if (newStatus === LinkStatus.CLOSED && this.transport) {
        this.transport.removeLink(this.linkId);
      }
    }
  }

  /**
   * Initiates the link handshake by sending a LINKREQUEST.
   * @returns {Promise<void>}
   */
  async startHandshake() {
    if (this.status !== LinkStatus.PENDING) {
      throw new Error("Handshake can only be started from PENDING state.");
    }

    this.status = LinkStatus.HANDSHAKE;

    const signallingBytes = this.signallingBytes(this.mtu, this.mode);
    const x25519Pub = await exportPublicKey(this.ephemeralKeyPair.publicKey);

    let ed25519Pub = new Uint8Array(0);
    if (this.ephemeralEd25519KeyPair) {
      ed25519Pub = await exportPublicKey(
        this.ephemeralEd25519KeyPair.publicKey,
      );
    }

    const body = new Uint8Array(32 + 32 + signallingBytes.length);
    body.set(x25519Pub, 0);
    body.set(ed25519Pub, 32);
    body.set(signallingBytes, 64);

    const request = new Packet({
      packetType: PacketType.LINKREQUEST,
      destinationType: DestType.SINGLE,
      destinationHash: this.destination.destinationHash,
      contextByte: ContextType.NONE,
      payload: body,
    });

    await this.transport.sendPacket(request);
  }

  /**
   * Responds to an incoming LINKREQUEST.
   * @param {Packet} packet - The LINKREQUEST packet.
   * @returns {Promise<void>}
   */
  async handleLinkRequest(packet) {
    // 1. Validate packet
    if (packet.packetType !== PacketType.LINKREQUEST) {
      throw new Error("Expected LINKREQUEST packet.");
    }
    if (packet.payload.length < 64) {
      throw new Error("LINKREQUEST payload too short.");
    }

    // 2. Extract initiator keys and signalling
    const initiatorX25519Pub = packet.payload.slice(0, 32);
    const initiatorEd25519Pub = packet.payload.slice(32, 64);
    const signallingBytes = packet.payload.slice(64);

    // 3. Parse signalling (MTU and mode)
    if (signallingBytes.length > 0) {
      const mode = (signallingBytes[0] & 0xe0) >> 5;
      const mtu =
        ((signallingBytes[0] << 16) +
          (signallingBytes[1] << 8) +
          signallingBytes[2]) &
        0x1fffff;
      this.mode = mode;
      this.mtu = mtu;
    }

    // 4. Prepare LRPROOF
    // Responder signs with its long-term Ed25519 private key.
    if (!this.sigPrv) {
      throw new Error(
        "Responder must have an Ed25519 signing key for LRPROOF.",
      );
    }

    const myX25519Pub = await exportPublicKey(this.ephemeralKeyPair.publicKey);
    const myEd25519Pub = await exportPublicKey(
      this.destination.identity.ed25519Pub,
    );

    // signature input: link_id || responder_X25519_pub || responder_long_term_Ed25519_pub || [signalling]
    const signedData = new Uint8Array(
      this.linkId.length +
        myX25519Pub.length +
        myEd25519Pub.length +
        signallingBytes.length,
    );
    signedData.set(this.linkId, 0);
    signedData.set(myX25519Pub, this.linkId.length);
    signedData.set(myEd25519Pub, this.linkId.length + myX25519Pub.length);
    signedData.set(
      signallingBytes,
      this.linkId.length + myX25519Pub.length + myEd25519Pub.length,
    );

    const signature = await this.destination.identity.sign(signedData);

    // body: signature(64) || responder_X25519_pub(32) || [signalling(3)]
    const proofBody = new Uint8Array(
      signature.length + myX25519Pub.length + signallingBytes.length,
    );
    proofBody.set(signature, 0);
    proofBody.set(myX25519Pub, signature.length);
    proofBody.set(signallingBytes, signature.length + myX25519Pub.length);

    const proof = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LRPROOF,
      payload: proofBody,
    });

    // 5. Send LRPROOF
    await this.transport.sendPacket(proof);

    this.status = LinkStatus.HANDSHAKE;
  }

  /**
   * Handles the LRPROOF response from the responder.
   * @param {Packet} packet - The LRPROOF packet.
   * @returns {Promise<void>}
   */
  async handleLRPROOF(packet) {
    // 1. Validate packet
    if (
      packet.packetType !== PacketType.PROOF ||
      packet.contextByte !== ContextType.LRPROOF
    ) {
      throw new Error("Expected LRPROOF packet.");
    }
    if (packet.payload.length < 96) {
      throw new Error("LRPROOF payload too short.");
    }

    // 2. Extract body
    const signature = packet.payload.slice(0, 64);
    const responderX25519Pub = packet.payload.slice(64, 96);
    const signallingBytes = packet.payload.slice(96);

    // 3. Parse signalling
    if (signallingBytes.length > 0) {
      const mode = (signallingBytes[0] & 0xe0) >> 5;
      const mtu =
        ((signallingBytes[0] << 16) +
          (signallingBytes[1] << 8) +
          signallingBytes[2]) &
        0x1fffff;
      this.mode = mode;
      this.mtu = mtu;
    }

    // 4. Verify signature
    const responderLongTermEd25519Pub = await exportPublicKey(
      this.destination.identity.ed25519Pub,
    );
    const signedData = new Uint8Array(
      this.linkId.length +
        responderX25519Pub.length +
        responderLongTermEd25519Pub.length +
        signallingBytes.length,
    );
    signedData.set(this.linkId, 0);
    signedData.set(responderX25519Pub, this.linkId.length);
    signedData.set(
      responderLongTermEd25519Pub,
      this.linkId.length + responderX25519Pub.length,
    );
    signedData.set(
      signallingBytes,
      this.linkId.length +
        responderX25519Pub.length +
        responderLongTermEd25519Pub.length,
    );

    const isValid = await this.destination.identity.validate(
      signature,
      signedData,
    );
    if (!isValid) {
      throw new Error("LRPROOF signature verification failed.");
    }

    // 5. Derive keys
    await this.deriveKeysFromEphemeral(responderX25519Pub);

    // 6. Transition to HANDSHAKE (waiting for LRRTT)
    this.status = LinkStatus.HANDSHAKE;

    // 7. Send LRRTT
    await this.sendLRRTT();
  }

  /**
   * Sends a Link Round-Trip Time (LRRTT) packet.
   * @returns {Promise<void>}
   */
  async sendLRRTT() {
    const rttData = new Uint8Array(8);
    const view = new DataView(rttData.buffer);
    view.setFloat64(0, this.rtt, false);

    const rttPacket = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LRRTT,
      payload: rttData,
    });

    await this.send(rttPacket);
  }

  /**
   * Handles the LRRTT packet from the initiator.
   * @param {Packet} packet - The LRRTT packet.
   * @returns {Promise<void>}
   */
  async handleLRRTT(packet) {
    if (this.initiator) {
      return; // Initiator sends LRRTT, doesn't handle it.
    }

    const view = new DataView(packet.payload.buffer, packet.payload.byteOffset);
    this.rtt = view.getFloat64(0, false);

    // Transition to ACTIVE
    this.status = LinkStatus.ACTIVE;
    this.dispatchEvent(
      new CustomEvent("established", { detail: { link: this.linkId } }),
    );
  }

  registerIncomingResource(resource) {
    this.addEventListener("resource", (event) => {
      const { packet } = /** @type {any} */ (event).detail;
      if (
        resource.link &&
        toHex(packet.destinationHash) === toHex(resource.link.linkId)
      ) {
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

    let payload = packet.payload;
    if (
      packet.packetType !== PacketType.PROOF &&
      !Link.UNENCRYPTED_CONTEXTS.has(packet.contextByte)
    ) {
      console.log("Encrypting packet");
      payload = await this.encrypt(packet.payload);
    }

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
      payload: payload,
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
    const dataHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", msgpackData),
    );

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
      throw new Error(
        "Link identity proof requires an identity's signing key.",
      );
    }

    const signallingBytes = this.signallingBytes(this.mtu, this.mode);
    const pubBytes = await exportPublicKey(this.ephemeralKeyPair.publicKey);

    const signedData = new Uint8Array(
      this.linkId.length +
        pubBytes.length +
        this.sigPubBytes.length +
        signallingBytes.length,
    );
    signedData.set(this.linkId, 0);
    signedData.set(pubBytes, this.linkId.length);
    signedData.set(this.sigPubBytes, this.linkId.length + pubBytes.length);
    signedData.set(
      signallingBytes,
      this.linkId.length + pubBytes.length + this.sigPubBytes.length,
    );

    const signature = await this.destination.identity.sign(signedData);

    const proofPayload = new Uint8Array(
      signature.length + pubBytes.length + signallingBytes.length,
    );
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
    const MTU_BYTEMASK = 0x1fffff;
    const MODE_BYTEMASK = 0xe0;
    const signallingValue =
      (mtu & MTU_BYTEMASK) + (((mode << 5) & MODE_BYTEMASK) << 16);
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

    const unencryptedContexts = new Set([
      ContextType.RESOURCE,
      ContextType.RESOURCE_ADV,
      ContextType.RESOURCE_HMU,
      ContextType.RESOURCE_ICL,
      ContextType.RESOURCE_RCL,
      ContextType.RESOURCE_PRF,
      ContextType.KEEPALIVE,
      ContextType.LINKIDENTIFY,
      ContextType.LINKCLOSE,
      ContextType.LRRTT,
      ContextType.LRPROOF,
    ]);

    let decryptedPayload;
    if (
      packet.packetType === PacketType.PROOF ||
      unencryptedContexts.has(packet.contextByte)
    ) {
      decryptedPayload = packet.payload;
    } else {
      decryptedPayload = await /** @type {any} */ (this.token).decrypt(
        packet.payload,
      );
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
      raw: packet.raw,
    });

    switch (decryptedPacket.contextByte) {
      case ContextType.NONE:
        if (decryptedPacket.packetType === PacketType.LINKREQUEST) {
          await this.handleLinkRequest(decryptedPacket);
          return;
        }
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
          console.log(
            `[LINK] Remote requested resource ${requestedHashHex}, starting transfer...`,
          );
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
        if (
          !this.initiator &&
          decryptedPacket.payload.length === 1 &&
          decryptedPacket.payload[0] === 0xff
        ) {
          const pongPacket = new Packet({
            packetType: PacketType.DATA,
            destinationType: DestType.LINK,
            destinationHash: this.linkId,
            contextByte: ContextType.KEEPALIVE,
            payload: new Uint8Array([0xfe]),
          });
          await this.send(pongPacket);
        }
        this.dispatchEvent(
          new CustomEvent("keepalive", { detail: { packet: decryptedPacket } }),
        );
        break;

      case ContextType.LRPROOF:
        await this.handleLRPROOF(decryptedPacket);
        break;

      case ContextType.LRRTT:
        await this.handleLRRTT(decryptedPacket);
        break;

      case ContextType.LINKIDENTIFY: {
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

  /**
   * Derives keys using the responder's ephemeral public key.
   * @param {Uint8Array} responderX25519Pub
   */
  async deriveKeysFromEphemeral(responderX25519Pub) {
    const peerPub = await crypto.subtle.importKey(
      "raw",
      responderX25519Pub,
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
