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

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { hkdf } from "../crypto/ciphers.js";
import { exportPublicKey } from "../crypto/keys.js";
import { Token } from "../crypto/token.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";

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

  /** @type {number} */
  keepaliveInterval = 360;

  /** @type {number} */
  staleTime = 720;

  /** @type {number} */
  lastInboundTime = Date.now();

  /**
   * @private
   * @type {ReturnType<typeof setInterval> | null}
   */
  _watchdogTimer = null;

  /**
   * @private
   * @type {number}
   */
  _status = LinkStatus.PENDING;

  /**
   * @private
   * @type {Promise<void>}
   */
  _rxQueue = Promise.resolve();

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
   * @param {import("../transport/transport.js").TransportCore} transport
   * @param {boolean} [initiator=false]
   */
  constructor(
    destination,
    linkId,
    ephemeralKeyPair,
    peerPubBytes,
    ephemeralEd25519KeyPair = undefined,
    sigPrv = undefined,
    sigPubBytes = undefined,
    transport = undefined,
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
    this.teardownReason = null;
    this.token = null;

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
    log(
      "Link",
      `Link ${toHex(this.linkId)} status is now ${newStatus}`,
      LogLevel.DEBUG,
    );
    const oldStatus = this._status;
    this._status = newStatus;
    if (oldStatus !== newStatus) {
      this.dispatchEvent(
        new CustomEvent("statuschange", {
          detail: { status: newStatus, oldStatus },
        }),
      );

      if (newStatus === LinkStatus.CLOSED) {
        this._stopWatchdog();
        if (this.transport) {
          this.transport.removeLink(this.linkId);
        }
      } else if (newStatus === LinkStatus.ACTIVE) {
        this._startWatchdog();
      }
    }
  }

  /**
   * Starts the watchdog timer.
   * @private
   */
  _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => this._watchdogJob(), 1000);
  }

  /**
   * Stops the watchdog timer.
   * @private
   */
  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * The watchdog job runs every second.
   * @private
   */
  _watchdogJob() {
    log(
      "Link",
      `Link ${toHex(this.linkId)} watchdog activated`,
      LogLevel.DEBUG,
    );
    const now = Date.now();

    // 1. Check for staleness
    if (now >= this.lastInboundTime + this.staleTime * 1000) {
      this.status = LinkStatus.CLOSED;
      this.teardownReason = LinkTeardownReason.TIMEOUT;
      return;
    }

    // 2. Send keepalive if initiator
    if (
      this.initiator &&
      now >= this.lastInboundTime + this.keepaliveInterval * 1000
    ) {
      this.sendKeepalive(true).catch(console.error);
      this.lastInboundTime = now; // Avoid spamming
    }
  }

  /**
   * Sends a KEEPALIVE packet.
   * @param {boolean} isPing - True if sending a ping (0xFF), false if pong (0xFE).
   * @returns {Promise<void>}
   */
  async sendKeepalive(isPing) {
    const payload = new Uint8Array([isPing ? 0xff : 0xfe]);
    const keepalivePacket = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.KEEPALIVE,
      payload: payload,
    });

    await this.send(keepalivePacket);
  }

  /**
   * Updates keepalive and staleness parameters based on RTT.
   * @private
   */
  _updateKeepalive() {
    const KEEPALIVE_MAX = 360;
    const KEEPALIVE_MAX_RTT = 1.75;
    const STALE_FACTOR = 2;
    const KEEPALIVE_MIN = 5;

    this.keepaliveInterval = Math.max(
      Math.min(this.rtt * (KEEPALIVE_MAX / KEEPALIVE_MAX_RTT), KEEPALIVE_MAX),
      KEEPALIVE_MIN,
    );
    this.staleTime = this.keepaliveInterval * STALE_FACTOR;
  }

  /**
   * @param {any} resource
   */
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
    const isUnencrypted =
      packet.packetType === PacketType.LINKREQUEST ||
      (packet.packetType === PacketType.PROOF &&
        packet.contextByte === ContextType.LRPROOF);

    if (!this.token && !isUnencrypted) {
      throw new Error("Link token not available. Did you call deriveKeys()?");
    }
    if (!this.transport) {
      throw new Error("Link transport not available.");
    }

    let payload = packet.payload;
    if (
      !isUnencrypted &&
      packet.packetType !== PacketType.PROOF &&
      !Link.UNENCRYPTED_CONTEXTS.has(packet.contextByte)
    ) {
      console.log("Encrypting packet");
      payload = await this.encrypt(/** @type {any} */ (packet.payload));
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
      await crypto.subtle.digest("SHA-256", /** @type {any} */ (msgpackData)),
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
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
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
    return await this.token.encrypt(/** @type {any} */ (data));
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
   * @private
   * @param {Packet} packet
   */
  async _processPacket(packet) {
    const isUnencrypted =
      packet.packetType === PacketType.LINKREQUEST ||
      (packet.packetType === PacketType.PROOF &&
        packet.contextByte === ContextType.LRPROOF);

    if (!this.token && !isUnencrypted) {
      throw new Error("Link token not available. Did you call deriveKeys()?");
    }
    log(
      "Link",
      `Processing ${packet.packetType} packet (ctx ${packet.contextByte}) for link ${toHex(this.linkId)}`,
      LogLevel.DEBUG,
    );

    this.lastInboundTime = Date.now();

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
    if (isUnencrypted || unencryptedContexts.has(packet.contextByte)) {
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

  /**
   * Initiates the handshake.
   */
  async startHandshake() {
    if (this.status !== LinkStatus.PENDING) {
      throw new Error("Handshake can only be started from PENDING status.");
    }

    this.status = LinkStatus.HANDSHAKE;

    const signalling = this.signallingBytes(this.mtu, this.mode);
    const x25519Pub = await exportPublicKey(this.ephemeralKeyPair.publicKey);
    const ed25519Pub = this.ephemeralEd25519KeyPair
      ? await exportPublicKey(this.ephemeralEd25519KeyPair.publicKey)
      : new Uint8Array(32);

    const payload = new Uint8Array(32 + 32 + 3);
    payload.set(x25519Pub, 0);
    payload.set(ed25519Pub, 32);
    payload.set(signalling, 64);

    const packet = new Packet({
      packetType: PacketType.LINKREQUEST,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.NONE,
      payload: payload,
    });

    await this.send(packet);
  }

  /**
   * Handles an incoming LINKREQUEST.
   * @param {Packet} packet
   */
  async handleLinkRequest(packet) {
    const payload = packet.payload;
    if (payload.length < 67) {
      throw new Error("Invalid LINKREQUEST payload length.");
    }

    const initiatorX25519Pub = payload.slice(0, 32);
    const initiatorEd25519Pub = payload.slice(32, 64);
    const signalling = payload.slice(64, 67);

    await this.deriveKeysFromEphemeral(initiatorX25519Pub);

    // Parse signalling
    const signallingValue =
      (signalling[0] << 16) | (signalling[1] << 8) | signalling[2];
    const mode = (signallingValue >> 21) & 0x07;
    const mtu = signallingValue & 0x1fffff;
    this.mode = mode;
    this.mtu = mtu;

    const responderX25519Pub = await exportPublicKey(
      this.ephemeralKeyPair.publicKey,
    );

    const signedData = new Uint8Array(
      this.linkId.length + 32 + 32 + signalling.length,
    );
    signedData.set(this.linkId, 0);
    signedData.set(responderX25519Pub, this.linkId.length);
    signedData.set(this.sigPubBytes, this.linkId.length + 32);
    signedData.set(signalling, this.linkId.length + 32 + 32);

    const signature = await this.destination.identity.sign(signedData);

    const proofPayload = new Uint8Array(64 + 32 + 3);
    proofPayload.set(signature, 0);
    proofPayload.set(responderX25519Pub, 64);
    proofPayload.set(signalling, 96);

    const proofPacket = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LRPROOF,
      payload: proofPayload,
    });

    await this.send(proofPacket);
    this.status = LinkStatus.HANDSHAKE;
  }

  /**
   * Handles an incoming LRPROOF.
   * @param {Packet} packet
   */
  async handleLRPROOF(packet) {
    const payload = packet.payload;
    if (payload.length < 99) {
      throw new Error("Invalid LRPROOF payload length.");
    }

    const signature = payload.slice(0, 64);
    const responderX25519Pub = payload.slice(64, 96);
    const signalling = payload.slice(96, 99);

    // Verify signature.
    const x25519Pub = await exportPublicKey(this.ephemeralKeyPair.publicKey);
    const signedData = new Uint8Array(32 + 32 + 3);
    signedData.set(x25519Pub, 0);
    signedData.set(responderX25519Pub, 32);
    signedData.set(signalling, 64);

    const isValid = await this.destination.identity.validate(
      signature,
      signedData,
    );
    if (!isValid) {
      throw new Error("LRPROOF signature verification failed.");
    }

    await this.deriveKeysFromEphemeral(responderX25519Pub);

    // Parse signalling
    const signallingValue =
      (signalling[0] << 16) | (signalling[1] << 8) | signalling[2];
    const mode = (signallingValue >> 21) & 0x07;
    const mtu = signallingValue & 0x1fffff;
    this.mode = mode;
    this.mtu = mtu;

    // Send LRRTT
    await this.sendLRRTT();

    this.status = LinkStatus.ACTIVE;
    this._updateKeepalive();
    this.dispatchEvent(
      new CustomEvent("established", { detail: { link: this.linkId } }),
    );
  }

  /**
   * Handles an incoming LRRTT.
   * @param {Packet} packet
   */
  async handleLRRTT(packet) {
    const payload = packet.payload;
    if (payload.length < 8) {
      throw new Error("Invalid LRRTT payload length.");
    }

    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    const remoteTimestamp = view.getBigUint64(0, false);
    const localTimestamp = BigInt(Date.now());
    this.rtt = Number(localTimestamp - remoteTimestamp);

    this.status = LinkStatus.ACTIVE;
    this._updateKeepalive();
    this.dispatchEvent(
      new CustomEvent("established", { detail: { link: this.linkId } }),
    );
  }

  /**
   * Sends an LRRTT packet.
   */
  async sendLRRTT() {
    const timestamp = BigInt(Date.now());
    const payload = new Uint8Array(8);
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    view.setBigUint64(0, timestamp, false);

    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LRRTT,
      payload: payload,
    });

    await this.send(packet);
  }
}
