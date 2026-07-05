/**
 * @file destination.js
 * @description Routing targets (EventTargets)
 */

import {
  exportPublicKey,
  generateEd25519KeyPair,
  generateX25519KeyPair,
} from "../crypto/keys.js";
import { Link, LinkEncryption } from "../transport/link.js";
import { toHex } from "../utils/encoding.js";
import { Identity } from "./identity.js";
import { DestType, HeaderType, Packet, PacketType } from "./packet.js";

/**
 * @enum {number}
 */
export const Direction = {
  IN: 0,
  OUT: 1,
};

/**
 * Types of destinations.
 * @enum {number}
 */
export const DestinationType = {
  SINGLE: 0x00,
  GROUP: 0x01,
  PLAIN: 0x02,
  LINK: 0x03,
};

/**
 * Helper functions for encoding/decoding buffers.
 */
/**
 * @param {Uint8Array} buf
 * @returns {string}
 */
function bufToHex(buf) {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBuf(hex) {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/**
 * Represents a Reticulum destination.
 */
export class Destination extends EventTarget {
  /**
   * Storage for known destinations.
   * @type {Map<string, any[]>}
   */
  static knownDestinations = new Map();

  /**
   * @param {string} name - The application name.
   * @param {Direction} direction - The direction of this destination.
   * @param {DestinationType} type - The type of this destination.
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

  async announce() {
    if (!this.interfaceLayer)
      throw new Error("Destination not bound to an RNS instance.");

    if (!this.identity) {
      throw new Error("Destination requires an identity to announce.");
    }

    if (!this.destinationHash || !this.nameHash) {
      throw new Error("Destination hashes not computed.");
    }

    // 1. Generate a 10-byte Random Hash (Required by RNS to prevent replay attacks)
    const randomHash = new Uint8Array(10);
    crypto.getRandomValues(randomHash);

    // 2. Fetch the 64-byte Public Key (32 bytes X25519 + 32 bytes Ed25519)
    const pubKey = await this.identity.getPublicKey();

    // 3. Prepare App Data (The human-readable name or metadata)
    const appData = this.identity.appData || new Uint8Array(0);

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
      payload: payload,
    });

    // DEBUG: Validate payload size
    console.log(`[DEBUG] Announce Payload Size: ${payload.length} bytes`);
    if (payload.length < 148) {
      console.error(
        "[!] Announce payload too small! Check your concatenation.",
      );
    }

    this.interfaceLayer.broadcast(announcePacket);
  }

  /**
   * Static factory for creating a destination.
   * @param {string} name
   * @param {Direction} direction
   * @param {DestinationType} type
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
    const nameHashBuffer = await crypto.subtle.digest("SHA-256", nameBytes);
    this.nameHash = new Uint8Array(nameHashBuffer.slice(0, 10));

    if (this.type === DestinationType.SINGLE && this.identity) {
      // destHash = SHA256(nameHash || identityHash)[:16]
      const combined = new Uint8Array(
        this.nameHash.length + this.identity.identityHash.length,
      );
      combined.set(this.nameHash, 0);
      combined.set(this.identity.identityHash, this.nameHash.length);

      const destHashBuffer = await crypto.subtle.digest("SHA-256", combined);
      this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
    } else if (this.type === DestinationType.GROUP && this.identity) {
      // Same as SINGLE for GROUP
      const combined = new Uint8Array(
        this.nameHash.length + this.identity.identityHash.length,
      );
      combined.set(this.nameHash, 0);
      combined.set(this.identity.identityHash, this.nameHash.length);

      const destHashBuffer = await crypto.subtle.digest("SHA-256", combined);
      this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
    } else if (this.type === DestinationType.PLAIN) {
      // destHash = SHA256(nameHash)[:16]
      const destHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        this.nameHash,
      );
      this.destinationHash = new Uint8Array(destHashBuffer.slice(0, 16));
    } else {
      this.destinationHash = null;
    }
  }

  /**
   * Creates an IN destination.
   * @param {string} name
   * @param {DestinationType} type
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
   * @param {DestinationType} type
   * @param {Identity|null} identity
   * @returns {Promise<Destination>}
   */
  static async OUT(name, type, identity = null) {
    return await Destination.create(name, Direction.OUT, type, identity);
  }

  /**
   * Creates a SINGLE destination.
   * @param {string} name
   * @param {Direction} direction
   * @param {Identity|null} identity
   * @returns {Promise<Destination>}
   */
  static async SINGLE(name, direction, identity = null) {
    return await Destination.create(
      name,
      direction,
      DestinationType.SINGLE,
      identity,
    );
  }

  /**
   * Creates a GROUP destination.
   * @param {string} name
   * @param {Direction} direction
   * @param {Identity|null} identity
   * @returns {Promise<Destination>}
   */
  static async GROUP(name, direction, identity = null) {
    return await Destination.create(
      name,
      direction,
      DestinationType.GROUP,
      identity,
    );
  }

  /**
   * Creates a PLAIN destination.
   * @param {string} name
   * @param {Direction} direction
   * @returns {Promise<Destination>}
   */
  static async PLAIN(name, direction) {
    return await Destination.create(
      name,
      direction,
      DestinationType.PLAIN,
      null,
    );
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
   * Requests an encrypted link to this remote destination.
   * @param {import('../interfaces/base.js').Interface} transport - The transport interface to use.
   * @param {Uint8Array} appData - Optional contextual data (e.g., Graph ID, Auth Token)
   * @param {number} timeoutMs - How long to wait for the remote node to accept
   * @returns {Promise<import('../transport/link.js').Link>} Resolves when the secure tunnel is established
   */
  async createLink(transport, appData = new Uint8Array(0), timeoutMs = 15000) {
    if (this.direction !== Direction.OUT) {
      throw new Error("Can only initiate links to OUT destinations.");
    }
    if (!this.interfaceLayer) {
      throw new Error("Destination not bound to an RNS instance.");
    }
    if (!this.destinationHash) {
      throw new Error("Destination hash not computed.");
    }

    return new Promise((resolve, reject) => {
      /** @type {CryptoKey | undefined} */
      let local_x25519_priv;
      const timer = setTimeout(() => {
        this.removeEventListener("link_established", onLinkEstablished);
        this.removeEventListener("link_response", onLinkResponse);
        reject(new Error("Link request timed out."));
      }, timeoutMs);

      /** @param {any} event */
      const onLinkEstablished = (event) => {
        clearTimeout(timer);
        this.removeEventListener("link_response", onLinkResponse);
        resolve(event.detail.link);
      };

      /** @param {any} event */
      const onLinkResponse = async (event) => {
        clearTimeout(timer);
        this.removeEventListener("link_established", onLinkEstablished);

        try {
          const { packet } = event.detail;
          if (packet.packetType !== PacketType.LINKRESPONSE) {
            throw new Error("Expected LINKRESPONSE packet");
          }

          const peer_x25519_pub_bytes = packet.payload.slice(0, 32);
          const peer_ed25519_pub_bytes = packet.payload.slice(32, 64);

          const peer_x25519_pub = await crypto.subtle.importKey(
            "raw",
            peer_x25519_pub_bytes,
            { name: "X25519" },
            true,
            [],
          );

          if (!local_x25519_priv) {
            throw new Error("Local private key not yet generated");
          }

          const link_key = await LinkEncryption.deriveLinkKey(
            local_x25519_priv,
            peer_x25519_pub,
            this.getSalt(),
          );

          const link = new Link(
            link_key,
            this.destinationHash,
            this.interfaceLayer.transport,
          );
          // this.interfaceLayer.transport.addLink(senderHash, link);
          this.dispatchEvent(
            new CustomEvent("link_established", {
              detail: { link },
            }),
          );

          resolve(link);
        } catch (e) {
          reject(e);
        }
      };

      this.addEventListener("link_established", onLinkEstablished, {
        once: true,
      });

      this.addEventListener("link_response", onLinkResponse, {
        once: true,
      });

      (async () => {
        try {
          const x25519 = await generateX25519KeyPair();
          local_x25519_priv = x25519.privateKey;
          const ed25519 = await generateEd25519KeyPair();
          const x25519PubBytes = await exportPublicKey(x25519.publicKey);
          const ed25519PubBytes = await exportPublicKey(ed25519.publicKey);

          const payload = new Uint8Array(64 + appData.length);
          payload.set(x25519PubBytes, 0);
          payload.set(ed25519PubBytes, 32);
          payload.set(appData, 64);

          const packet = new Packet({
            headerType: HeaderType.HEADER_1,
            hops: 0,
            transportType: 0,
            destinationType: this.type,
            packetType: PacketType.LINKREQUEST,
            contextFlag: false,
            /** @type {any} */
            destinationHash: this.destinationHash,
            contextByte: 0,
            payload: payload,
          });

          await this.interfaceLayer.transport.sendPacket(packet);
        } catch (e) {
          clearTimeout(timer);
          this.removeEventListener("link_established", onLinkEstablished);
          this.removeEventListener("link_response", onLinkResponse);
          reject(e);
        }
      })();
    });
  }

  /**
   * Handles incoming packets routed to this destination.
   * @param {import('./packet.js').Packet} packet
   * @param {Object} receivingInterface
   */
  async receive(packet, receivingInterface) {
    console.log(
      `[DEST] Destination ${this.name} received packet type ${packet.packetType}`,
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
   * @param {import('./packet.js').Packet} packet
   * @param {import('../interfaces/base.js').Interface} transport
   * @param {Uint8Array} appData
   */
  async acceptLink(packet, transport, appData = new Uint8Array(0)) {
    return await this.respondToLinkRequest(transport, packet, null, appData);
  }

  /**
   * @param {import('./packet.js').Packet} packet
   */
  async _handleData(packet) {
    let plaintext = null;
    if (this.type === DestinationType.SINGLE && this.identity) {
      plaintext = await this.identity.decrypt(packet.payload);
    } else {
      plaintext = packet.payload;
    }

    if (plaintext) {
      this.dispatchEvent(new CustomEvent("data", { detail: { plaintext } }));
    }
  }

  /**
   * Responds to a link request.
   * @param {import('../transport/transport.js').TransportCore} transport
   * @param {import('../core/packet.js').Packet} requestPacket
   * @param {Uint8Array} senderHash - The destination hash of the requester.
   * @param {Uint8Array} appData
   */
  async respondToLinkRequest(transport, requestPacket, senderHash, appData) {
    // ---------------------------------------------------------
    // 1. DERIVE THE LINK ID
    // Spec: link_id = SHA256(hashable_part_of_LINKREQUEST)[:16]
    // ---------------------------------------------------------
    const n = requestPacket.headerType === HeaderType.HEADER_1 ? 2 : 18;
    const maskedFlag = requestPacket.raw[0] & 0x0f;

    let hashableLength = 1 + requestPacket.raw.length - n;

    // Strip signalling bytes if payload > 64 bytes (Link.ECPUBSIZE)
    if (requestPacket.payload.length > 64) {
      const signallingLength = requestPacket.payload.length - 64;
      hashableLength -= signallingLength;
    }

    const hashablePart = new Uint8Array(hashableLength);
    hashablePart[0] = maskedFlag;
    hashablePart.set(requestPacket.raw.subarray(n, n + hashableLength - 1), 1);

    const linkId = await Identity.truncatedHash(hashablePart);

    // ---------------------------------------------------------
    // 2. GENERATE EPHEMERAL KEY
    // ---------------------------------------------------------
    const ephemeralKey = await generateX25519KeyPair();
    const ephemeralPubBytes = await exportPublicKey(ephemeralKey.publicKey); // 32 bytes

    // ---------------------------------------------------------
    // 3. CONSTRUCT SIGNED DATA
    // Spec: link_id || responder_X25519_pub || responder_long_term_Ed25519_pub
    // ---------------------------------------------------------
    // Exporting directly to avoid any previous byte-order slicing issues
    const ed25519PubBytes = await exportPublicKey(this.identity.ed25519Pub);

    const signedData = new Uint8Array(16 + 32 + 32);
    signedData.set(linkId, 0);
    signedData.set(ephemeralPubBytes, 16);
    signedData.set(ed25519PubBytes, 48);

    // ---------------------------------------------------------
    // 4. SIGN THE DATA
    // ---------------------------------------------------------
    const signature = await this.identity.sign(signedData); // 64 bytes

    // ---------------------------------------------------------
    // 5. CONSTRUCT LRPROOF PAYLOAD
    // Spec: signature(64) || responder_X25519_pub(32)
    // ---------------------------------------------------------
    const responsePayload = new Uint8Array(96);
    responsePayload.set(signature, 0); // Signature MUST be first
    responsePayload.set(ephemeralPubBytes, 64); // Ephemeral key MUST be second

    // ---------------------------------------------------------
    // 6. CREATE LRPROOF PACKET
    // ---------------------------------------------------------
    const responsePacket = new Packet({
      headerType: HeaderType.HEADER_1,
      hops: 0, // Outgoing packets start at 0
      transportType: 0,
      destinationType: DestType.LINK,
      packetType: PacketType.PROOF, // MUST be 3
      contextFlag: true,
      contextByte: 0xff, // MUST be LRPROOF context
      destinationHash: linkId, // MUST be addressed to the link_id
      payload: responsePayload,
    });

    // ---------------------------------------------------------
    // 7. REGISTER LINK & SEND
    // ---------------------------------------------------------
    // The initiator's X25519 pubkey is the first 32 bytes of the LINKREQUEST payload
    const initiatorPubBytes = requestPacket.payload.slice(0, 32);

    const link = new Link(
      this.destinationHash,
      linkId,
      ephemeralKey,
      initiatorPubBytes,
    );

    // Register the ephemeral link_id with the router so follow-up packets reach the Link instance
    // transport.localDestinations.set(toHex(linkId), link);
    this.interfaceLayer.transport.addLink(linkId, link);

    await this.interfaceLayer.transport.sendPacket(responsePacket);

    console.log(`[LINK] Handshake response sent to link_id: ${toHex(linkId)}`);

    return link;
  }

  /**
   * Remember a destination.
   * @param {Uint8Array} packet_hash
   * @param {Uint8Array} destination_hash
   * @param {Uint8Array} public_key
   * @param {any} appData
   */
  static async remember(
    packet_hash,
    destination_hash,
    public_key,
    appData = null,
  ) {
    const key = bufToHex(destination_hash);
    const entry = Destination.knownDestinations.get(key);
    if (entry) {
      entry[0] = Date.now() / 1000; // time.time() in seconds
      entry[1] = packet_hash;
      entry[2] = public_key;
      entry[3] = appData;
    } else {
      Destination.knownDestinations.set(key, [
        Date.now() / 1000,
        packet_hash,
        public_key,
        appData,
        0,
      ]);
    }
  }

  /**
   * Recall an identity for a destination or identity hash.
   * @param {Uint8Array} target_hash
   * @param {boolean} from_identity_hash
   * @returns {Promise<Identity|null>}
   */
  static async recall(target_hash, from_identity_hash = false) {
    if (from_identity_hash) {
      for (const [key, entry] of Destination.knownDestinations.entries()) {
        const public_key = entry[2];
        const identity = await Identity.fromPublicKey(public_key);
        const identity_hash = await Identity.truncatedHash(identity.publicKey);

        if (bufToHex(target_hash) === bufToHex(identity_hash)) {
          identity.appData = entry[3];
          return identity;
        }
      }
      return null;
    } else {
      const key = bufToHex(target_hash);
      const entry = Destination.knownDestinations.get(key);
      if (entry) {
        const identity = await Identity.fromPublicKey(entry[2]);
        identity.appData = entry[3];
        return identity;
      }
      return null;
    }
  }
}
