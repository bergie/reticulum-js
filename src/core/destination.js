/**
 * @file destination.js
 * @description Routing targets (EventTargets)
 */

import { Link } from "../transport/link.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { Identity } from "./identity.js";
import { DestType, Packet, PacketType, TransportType } from "./packet.js";

/**
 * @enum {number}
 */
export const Direction = {
  IN: 0,
  OUT: 1,
};

/**
 * Represents a Reticulum destination — an addressable endpoint that can
 * announce, receive packets, encrypt/decrypt, and establish Links.
 * @extends EventTarget
 */
export class Destination extends EventTarget {
  /**
   * Storage for known destinations.
   * @type {Map<string, any[]>}
   */
  static knownDestinations = new Map();

  /**
   * Low-level constructor. Prefer the static factories (`Destination.IN`,
   * `Destination.OUT`, etc.) which also compute the destination hashes.
   * @param {string} name - The application name.
   * @param {Direction} direction - The direction of this destination.
   * @param {DestType} type - The type of this destination.
   * @param {Identity|null} identity - The identity associated with this destination.
   * @param {import("../core/reticulum.js").Reticulum|null} interfaceLayer - An object that manages destinations and dispatches link requests.
   */
  constructor(name, direction, type, identity = null, interfaceLayer = null) {
    super();
    this.name = name;
    this.direction = direction;
    this.type = type;
    this.identity = identity;
    this.interfaceLayer = interfaceLayer;
    /** @type {Uint8Array|null} */
    this.destinationHash = null;
    /** @type {Uint8Array|null} */
    this.nameHash = null;
  }

  /**
   * @type {Uint8Array|null}
   */
  destinationHash;

  /**
   * @type {Uint8Array|null}
   */
  nameHash;

  /**
   * Broadcasts an Announce packet advertising this destination's public key,
   * name hash and signed metadata so peers can learn and remember it.
   */
  async announce() {
    if (!this.interfaceLayer)
      throw new Error("Destination not bound to an RNS instance.");

    if (!this.identity) {
      throw new Error("Destination requires an identity to announce.");
    }

    if (!this.destinationHash || !this.nameHash) {
      throw new Error("Destination hashes not computed.");
    }

    // Verify this in your code:
    if (this.nameHash.length !== 10) {
      throw new Error("nameHash must be 10 bytes");
    }

    // 1. Generate a 10-byte Random Hash (Required by RNS to prevent replay attacks)
    const randomHash = new Uint8Array(10);
    crypto.getRandomValues(randomHash);

    // 2. Fetch the 64-byte Public Key (32 bytes X25519 + 32 bytes Ed25519)
    const pubKey = await this.identity.getPublicKey();

    // 3. Prepare App Data (The human-readable name or metadata)
    const appData = this.identity.appData;

    // 4. Construct the Data to be Signed
    // Reticulum requires the signature to cover these specific fields in order:
    // [DestHash (16)] + [PubKey (64)] + [NameHash (10)] + [RandomHash (10)] + [AppData]
    const signedData = new Uint8Array(16 + 64 + 10 + 10 + appData.length);
    signedData.set(this.destinationHash, 0);
    signedData.set(pubKey, 16);
    signedData.set(this.nameHash, 16 + 64);
    signedData.set(randomHash, 16 + 64 + 10);
    signedData.set(appData, 16 + 64 + 10 + 10);

    // 5. Generate the 64-byte Ed25519 Signature
    const signature = await this.identity.sign(signedData);

    // 6. Construct the final Announce Payload for the wire
    // Format: [PubKey (64)] + [NameHash (10)] + [RandomHash (10)] + [Signature (64)] + [AppData]
    const payload = new Uint8Array(64 + 10 + 10 + 64 + appData.length);
    payload.set(pubKey, 0);
    payload.set(this.nameHash, 64);
    payload.set(randomHash, 64 + 10);
    payload.set(signature, 64 + 10 + 10);
    payload.set(appData, 64 + 10 + 10 + 64);

    // 7. Broadcast the Packet
    const announcePacket = new Packet({
      packetType: PacketType.ANNOUNCE,
      destinationType: this.type,
      destinationHash: this.destinationHash,
      transportType: TransportType.BROADCAST,
      payload: payload,
    });

    // DEBUG: Validate payload size
    log(
      "Destination",
      `Announce Payload Size: ${payload.length} bytes`,
      LogLevel.DEBUG,
    );
    if (payload.length < 148) {
      log(
        "Destination",
        "[!] Announce payload too small! Check your concatenation.",
        LogLevel.ERROR,
      );
    }

    this.interfaceLayer.broadcast(announcePacket);
  }

  /**
   * Static factory for creating a destination.
   * @param {string} name
   * @param {Direction} direction
   * @param {DestType} type
   * @param {Identity|null} identity
   * @param {import("../core/reticulum.js").Reticulum|null} interfaceLayer - An object that manages destinations and dispatches link requests.
   * @returns {Promise<Destination>}
   */
  static async create(
    name,
    direction,
    type,
    identity = null,
    interfaceLayer = null,
  ) {
    const dest = new Destination(
      name,
      direction,
      type,
      identity,
      interfaceLayer,
    );
    await dest._computeHashes();
    return dest;
  }

  /**
   * Computes the nameHash and destinationHash.
   * @private
   */
  async _computeHashes() {
    const encoder = new TextEncoder();
    const nameBytes = encoder.encode(this.name);

    // nameHash = SHA256(full_app_name_string)[:10]
    const nameHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      /** @type {any} */ (nameBytes),
    );
    this.nameHash = new Uint8Array(nameHashBuffer.slice(0, 10));

    if (this.type === DestType.SINGLE && this.identity) {
      // destHash = SHA256(nameHash || identityHash)[:16]
      const combined = new Uint8Array(
        this.nameHash.length + this.identity.identityHash.length,
      );
      combined.set(this.nameHash, 0);
      combined.set(this.identity.identityHash, this.nameHash.length);

      const destHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        /** @type {any} */ (combined),
      );
      this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
    } else if (this.type === DestType.GROUP && this.identity) {
      // Same as SINGLE for GROUP
      const combined = new Uint8Array(
        this.nameHash.length + this.identity.identityHash.length,
      );
      combined.set(this.nameHash, 0);
      combined.set(this.identity.identityHash, this.nameHash.length);

      const destHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        /** @type {any} */ (combined),
      );
      this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
    } else if (this.type === DestType.PLAIN) {
      // destHash = SHA256(nameHash)[:16]
      const destHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        /** @type {any} */ (this.nameHash),
      );
      this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
    } else {
      this.destinationHash = null;
    }
  }

  /**
   * Creates an IN destination.
   * @param {string} name
   * @param {DestType} type
   * @param {Identity|null} identity
   * @param {import("../core/reticulum.js").Reticulum|null} interfaceLayer - An object that manages destinations and dispatches link requests.
   * @returns {Promise<Destination>}
   */
  static async IN(name, type, identity = null, interfaceLayer = null) {
    return await Destination.create(
      name,
      Direction.IN,
      type,
      identity,
      interfaceLayer,
    );
  }

  /**
   * Creates an OUT destination.
   * @param {string} name
   * @param {DestType} type
   * @param {Identity|null} identity
   * @param {import("../core/reticulum.js").Reticulum|null} interfaceLayer - An object that manages destinations and dispatches link requests.
   * @returns {Promise<Destination>}
   */
  static async OUT(name, type, identity = null, interfaceLayer = null) {
    return await Destination.create(
      name,
      Direction.OUT,
      type,
      identity,
      interfaceLayer,
    );
  }

  /**
   * Creates a SINGLE destination.
   * @param {string} name
   * @param {Direction} direction
   * @param {Identity|null} identity
   * @returns {Promise<Destination>}
   */
  static async SINGLE(name, direction, identity = null) {
    return await Destination.create(name, direction, DestType.SINGLE, identity);
  }

  /**
   * Creates a GROUP destination.
   * @param {string} name
   * @param {Direction} direction
   * @param {Identity|null} identity
   * @returns {Promise<Destination>}
   */
  static async GROUP(name, direction, identity = null) {
    return await Destination.create(name, direction, DestType.GROUP, identity);
  }

  /**
   * Creates a PLAIN destination.
   * @param {string} name
   * @param {Direction} direction
   * @returns {Promise<Destination>}
   */
  static async PLAIN(name, direction) {
    return await Destination.create(name, direction, DestType.PLAIN, null);
  }

  /**
   * Gets the salt for key derivation.
   * @returns {Uint8Array}
   */
  getSalt() {
    // Force conversion to a clean Uint8Array
    const salt = this.destinationHash ?? new Uint8Array(16);
    return new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength);
  }

  /**
   * Initiates an encrypted link to this remote (OUT) destination.
   *
   * Delegates to `Link.initiate`, which generates the ephemeral keypair, builds
   * and sends the LINKREQUEST, registers the link with the transport, and
   * transitions to HANDSHAKE. This method then awaits `Link.whenActive()` so
   * that the returned link is fully established (LRPROOF validated, session
   * keys derived) and ready to carry application DATA — e.g. it is safe to call
   * `link.identify(...)` immediately on the resolved value.
   *
   * @returns {Promise<import('../transport/link.js').Link>}
   */
  async createLink() {
    if (this.direction !== Direction.OUT) {
      throw new Error("Can only initiate links to OUT destinations.");
    }
    if (!this.interfaceLayer) {
      throw new Error("Destination not bound to an RNS instance.");
    }
    const link = await Link.initiate(this, this.interfaceLayer.transport);
    return await link.whenActive();
  }

  /**
   * Handles incoming packets routed to this destination.
   * @param {import('./packet.js').Packet} packet
   * @param {import("../interfaces/base.js").Interface} receivingInterface
   */
  async receive(packet, receivingInterface) {
    log(
      "Destination",
      `Destination ${this.name} received packet type ${packet.packetType}`,
      LogLevel.DEBUG,
    );

    // Dispatch to internal handlers based on packet type
    switch (packet.packetType) {
      case PacketType.DATA:
        await this._handleData(packet);
        break;
      case PacketType.LINKREQUEST:
        this.dispatchEvent(
          new CustomEvent("link_request", {
            detail: { packet, transport: receivingInterface },
          }),
        );
        break;
      // Add other types as needed
    }
  }

  /**
   * Accepts an incoming LINKREQUEST and returns the established {@link Link}.
   * @param {import('./packet.js').Packet} packet
   * @returns {Promise<import("../transport/link.js").Link>}
   */
  async acceptLink(packet) {
    return await this.respondToLinkRequest(packet);
  }

  /**
   * Decrypts (where applicable) and dispatches an inbound DATA packet
   * as a `data` event.
   * @param {import('./packet.js').Packet} packet
   * @private
   */
  async _handleData(packet) {
    let plaintext = null;
    if (this.type === DestType.SINGLE && this.identity) {
      plaintext = await this.identity.decrypt(packet.payload);
    } else {
      plaintext = packet.payload;
    }

    if (plaintext) {
      this.dispatchEvent(new CustomEvent("data", { detail: { plaintext } }));
    }
  }

  /**
   * Responds to an incoming LINKREQUEST by accepting the link.
   *
   * Delegates to `Link.accept`, which derives the link_id, generates the
   * responder ephemeral key, derives the session keys, builds and sends the
   * LRPROOF, and registers the link with the transport.
   *
   * @param {import('../core/packet.js').Packet} requestPacket
   * @returns {Promise<import('../transport/link.js').Link>}
   */
  async respondToLinkRequest(requestPacket) {
    if (!this.interfaceLayer || !this.interfaceLayer.transport) {
      throw new Error(
        "Destination not bound to an RNS instance with a transport.",
      );
    }
    const link = await Link.accept(
      this,
      this.interfaceLayer.transport,
      requestPacket,
    );
    log(
      "Destination",
      `[LINK] Handshake response sent to link_id: ${toHex(link.linkId)}`,
      LogLevel.DEBUG,
    );
    return link;
  }

  /**
   * Remember a destination.
   * @param {Uint8Array} packetHash
   * @param {Uint8Array} destinationHash
   * @param {Uint8Array} publicKey
   * @param {any} appData
   */
  static async remember(
    packetHash,
    destinationHash,
    publicKey,
    appData = null,
  ) {
    const key = toHex(destinationHash);
    const entry = Destination.knownDestinations.get(key);
    if (entry) {
      log("Destination", `Updating destination ${key}`);
      if (toHex(entry[1]) !== toHex(packetHash)) {
        log("Destination", `  - packetHash changed to ${toHex(packetHash)}`);
      }
      if (toHex(entry[2]) !== toHex(publicKey)) {
        log("Destination", `  - publicKey changed to ${toHex(publicKey)}`);
      }
      if (entry[3] !== appData) {
        log("Destination", `  - appData changed to ${appData}`);
      }
      entry[0] = Date.now() / 1000; // time.time() in seconds
      entry[1] = packetHash;
      entry[2] = publicKey;
      entry[3] = appData;
    } else {
      log("Destination", `Saving new destination ${key}`);
      Destination.knownDestinations.set(key, [
        Date.now() / 1000,
        packetHash,
        publicKey,
        appData,
        0,
      ]);
    }
  }

  /**
   * Recall an identity for a destination or identity hash.
   * @param {Uint8Array} targetHash
   * @param {boolean} fromIdentityHash
   * @returns {Promise<Identity|null>}
   */
  static async recall(targetHash, fromIdentityHash = false) {
    if (fromIdentityHash) {
      for (const [_key, entry] of Destination.knownDestinations.entries()) {
        const publicKey = entry[2];
        const identity = await Identity.fromPublicKey(publicKey);
        const identityHash = await Identity.truncatedHash(identity.publicKey);
        log(
          "Destination",
          `Comparing ${toHex(targetHash)} vs calculated ${toHex(identityHash)}`,
          LogLevel.DEBUG,
        );

        if (toHex(targetHash) === toHex(identityHash)) {
          identity.appData = entry[3];
          return identity;
        }
      }
      return null;
    } else {
      const key = toHex(targetHash);
      const entry = Destination.knownDestinations.get(key);
      if (entry) {
        const identity = await Identity.fromPublicKey(entry[2]);
        identity.appData = entry[3];
        return identity;
      }
      return null;
    }
  }

  /**
   * Encrypts data for this destination's identity.
   * @param {Uint8Array} data
   * @return {Promise<Uint8Array>}
   */
  async encrypt(data) {
    if (!this.identity) {
      throw new Error("Destination requires an identity to encrypt.");
    }
    return await this.identity.encrypt(data);
  }

  /**
   * Encrypts the packet payload for this destination and sends it via the
   * bound transport.
   * @param {Packet} packet
   * @returns {Promise<void>}
   */
  async send(packet) {
    if (!this.interfaceLayer) {
      throw new Error("Destination not bound to an RNS instance.");
    }
    const encryptedPayload = await this.encrypt(packet.payload);
    const encryptedPacket = new Packet({
      headerType: packet.headerType,
      hops: packet.hops,
      transportType: packet.transportType,
      destinationType: packet.destinationType,
      destinationHash: packet.destinationHash,
      packetType: packet.packetType,
      contextFlag: packet.contextFlag,
      contextByte: packet.contextByte,
      payload: encryptedPayload,
      transportId: packet.transportId,
    });

    await this.interfaceLayer.transport.sendPacket(encryptedPacket);
  }
}
