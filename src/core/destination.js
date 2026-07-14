/**
 * @file destination.js
 * @description Routing targets (EventTargets)
 */

import {
  exportPublicKey,
  exportRawPrivateKey,
  generateX25519KeyPair,
} from "../crypto/keys.js";
import { Link } from "../transport/link.js";
import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { Identity } from "./identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
  TransportType,
} from "./packet.js";

/**
 * @enum {number}
 */
export const Direction = {
  IN: 0,
  OUT: 1,
};

/**
 * Authorization modes for a registered REQUEST handler (PROTOCOL-SPEC.md §11.4).
 *
 * Mirrors `RNS.Destination.ALLOW_NONE/ALLOW_ALL/ALLOW_LIST`. The mode is
 * enforced server-side by `Link._authorizeRequest` against the requester's
 * long-term identity (established on the link via `link.identify()`).
 *
 * @enum {number}
 */
export const Allow = {
  /** Reject every request (handler is a stub for testing). */
  NONE: 0x00,
  /** Accept any request that arrives on this Link, regardless of caller. */
  ALL: 0x01,
  /** Accept iff the requester has identified AND their identity_hash is in `allowedList`. */
  LIST: 0x02,
};

/**
 * Server-side generator invoked to produce a RESPONSE value
 * (PROTOCOL-SPEC.md §11.2). The value it returns is msgpacked as element [1]
 * of `[request_id, response]`; returning `null`/`undefined` suppresses the
 * response.
 *
 * @callback RequestGenerator
 * @param {string} path - The registered path string.
 * @param {any} data - The application value from envelope element [2]
 *   (`null` for plain GETs, a `dict` for NomadNet form posts, a `list` for
 *   LXMF `/get` rounds, opaque `Uint8Array` blobs, …).
 * @param {Uint8Array} requestId - 16-byte truncated hash of the REQUEST packet.
 * @param {import("./identity.js").Identity|null} remoteIdentity - The
 *   requester's long-term identity, set iff they called `link.identify()`.
 * @param {number} requestTime - The requester's timestamp (envelope [0]).
 * @returns {Promise<any>|any}
 */

/**
 * A registered REQUEST handler (PROTOCOL-SPEC.md §11.3, §11.4).
 *
 * @typedef {object} RequestHandler
 * @property {string} path
 * @property {RequestGenerator} responseGenerator
 * @property {Allow} allow
 * @property {Uint8Array[]} allowedList
 * @property {boolean} autoCompress
 */

/**
 * Builds the 10-byte announce `random_hash` (SPEC.md §4.1):
 *
 * ```
 * random_hash = get_random_hash()[:5] + int(time.time()).to_bytes(5, "big")
 * ```
 *
 * The trailing 5 bytes are a big-endian uint40 of Unix seconds. Transit relays
 * read `random_hash[5:10]` via `timebase_from_random_blob` for path-table
 * replacement ordering (§4.5 step 6.3): only newer-emitted announces can
 * refresh a cached path. Emitting 10 fully-random bytes (the microReticulum
 * bug, §9.10) makes announces appear "far-future" and freezes the path table
 * against fresher entries from real-timestamped peers.
 *
 * @param {Uint8Array} randomBytes - Fresh random bytes; only the first 5 are used.
 * @param {number} timestampSec - Unix seconds to embed in the trailing 5 bytes.
 * @returns {Uint8Array} 10-byte announce `random_hash`.
 */
export function createAnnounceRandomHash(randomBytes, timestampSec) {
  if (!Number.isInteger(timestampSec) || timestampSec < 0) {
    throw new RangeError(
      `announce timestamp must be a non-negative integer, got ${timestampSec}`,
    );
  }
  if (timestampSec > 0xffffffffff) {
    throw new RangeError(
      `announce timestamp ${timestampSec} does not fit in a uint40`,
    );
  }
  const out = new Uint8Array(10);
  out.set(randomBytes.subarray(0, 5), 0);
  // Encode the timestamp as a 5-byte big-endian uint40 by writing it into the
  // low 5 bytes of an 8-byte big-endian uint64. The value always fits (validated
  // above), so the top 3 bytes are zero and subarray(3) yields exactly the 5
  // bytes a receiver reconstructs via int.from_bytes(blob[5:10], "big").
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, BigInt(timestampSec), false);
  out.set(new Uint8Array(buffer).subarray(3), 5);
  return out;
}

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
   * Known ratchet X25519 public keys per destination (SPEC.md §4.5 step 6.2,
   * §7.4). Maps hex destination hash → array of ratchet pubs (newest first).
   * Populated from validated announces; consumed by the inbound-decrypt
   * tolerance path once full ratchet support lands.
   * @type {Map<string, Uint8Array[]>}
   */
  static knownRatchets = new Map();

  /**
   * Default ratchet rotation interval (Destination.RATCHET_INTERVAL = 30 min).
   * A destination with ratchets enabled rotates its key at most this often.
   */
  static RATCHET_INTERVAL_MS = 30 * 60 * 1000;
  /** Maximum number of retained ratchet keys for decryption tolerance. */
  static MAX_RATCHETS = 128;

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
    /**
     * Registered REQUEST handlers keyed by hex(`SHA-256(path)[:16]`)
     * (PROTOCOL-SPEC.md §11.3). The path string itself is never sent on the
     * wire — only its 16-byte truncated hash — so a client must already know
     * the path to fetch the resource at it.
     * @type {Map<string, RequestHandler>}
     */
    this.requestHandlers = new Map();

    // §7.4 ratchet ownership (receiver side). When enabled this destination
    // generates and rotates X25519 ratchet keypairs, advertises the newest
    // public key in announces, and decrypts with the private ring. Disabled
    // by default — opt in via enableRatchets().
    this.ratchetsEnabled = false;
    /** @type {{privateKey: Uint8Array, publicKey: Uint8Array}[]|null} */
    this.ratchets = null;
    this.latestRatchetTime = 0;
    this.ratchetInterval = Destination.RATCHET_INTERVAL_MS;
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
   *
   * Emits with `context = NONE` (a regular periodic announce). Use
   * {@link announcePathResponse} to answer a `path?` request.
   */
  async announce() {
    await this._emitAnnounce(ContextType.NONE);
  }

  /**
   * Broadcasts a **path-response** announce — identical body to a regular
   * announce (§4.1) but with the outer packet's context byte set to
   * `PATH_RESPONSE = 0x0B` (§7.2.4). Emitted in answer to an inbound `path?`
   * request so the requester can learn a route back to us. The announce body
   * validates identically under §4.5; only the context byte distinguishes it.
   */
  async announcePathResponse() {
    await this._emitAnnounce(ContextType.PATH_RESPONSE);
  }

  /**
   * Builds and broadcasts an announce packet with the given context byte.
   * Shared by {@link announce} (NONE) and {@link announcePathResponse}
   * (PATH_RESPONSE).
   *
   * @param {number} contextByte
   * @private
   */
  async _emitAnnounce(contextByte) {
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

    // 1. Announce random_hash (SPEC.md §4.1):
    //    5 random bytes || big-endian uint40 Unix-seconds.
    //    Transit relays decode bytes [5:10] as the emission timestamp for
    //    path-table replacement ordering (§4.5 step 6.3). 10 fully-random
    //    bytes would be the microReticulum bug (§9.10).
    const randomHash = createAnnounceRandomHash(
      Identity.getRandomHash(),
      Math.floor(Date.now() / 1000),
    );

    // 2. Fetch the 64-byte Public Key (32 bytes X25519 + 32 bytes Ed25519)
    const pubKey = await this.identity.getPublicKey();

    // 3. Prepare App Data (The human-readable name or metadata)
    const appData = this.identity.appData;

    // §7.4 ratchet: when forward-secrecy ratchets are enabled on this
    // destination, rotate if due and embed the current ratchet public (32 B)
    // into both the signed data and the announce body, and set the packet
    // context_flag so receivers parse it (§4.5). Empty when disabled —
    // matching Python's ratchet = b"" slot.
    const ratchetBytes = await this._currentRatchetForAnnounce();
    const hasRatchet = ratchetBytes.length > 0;

    // 4. Construct the Data to be Signed
    // [DestHash (16)] + [PubKey (64)] + [NameHash (10)] + [RandomHash (10)] + [Ratchet (0|32)] + [AppData]
    const signedData = new Uint8Array(
      16 + 64 + 10 + 10 + ratchetBytes.length + appData.length,
    );
    signedData.set(this.destinationHash, 0);
    signedData.set(pubKey, 16);
    signedData.set(this.nameHash, 16 + 64);
    signedData.set(randomHash, 16 + 64 + 10);
    signedData.set(ratchetBytes, 16 + 64 + 10 + 10);
    signedData.set(appData, 16 + 64 + 10 + 10 + ratchetBytes.length);

    // 5. Generate the 64-byte Ed25519 Signature
    const signature = await this.identity.sign(signedData);

    // 6. Construct the final Announce Payload for the wire
    // [PubKey (64)] + [NameHash (10)] + [RandomHash (10)] + [Ratchet (0|32)] + [Signature (64)] + [AppData]
    const payload = new Uint8Array(
      64 + 10 + 10 + ratchetBytes.length + 64 + appData.length,
    );
    payload.set(pubKey, 0);
    payload.set(this.nameHash, 64);
    payload.set(randomHash, 64 + 10);
    payload.set(ratchetBytes, 64 + 10 + 10);
    payload.set(signature, 64 + 10 + 10 + ratchetBytes.length);
    payload.set(appData, 64 + 10 + 10 + ratchetBytes.length + 64);

    // 7. Broadcast the Packet
    const announcePacket = new Packet({
      packetType: PacketType.ANNOUNCE,
      destinationType: this.type,
      destinationHash: this.destinationHash,
      transportType: TransportType.BROADCAST,
      contextFlag: hasRatchet,
      contextByte,
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
   * Enables forward-secrecy ratchets on this destination (§7.4).
   *
   * Generates the initial ratchet keypair. The newest ratchet public key is
   * then embedded in subsequent announces, and inbound packets are decrypted
   * against the private ring before the long-term key. Ratchet private keys
   * are held in memory only for now (persistence lands with the storage
   * layer); a restart therefore rotates the ratchet.
   *
   * @returns {Promise<void>}
   */
  async enableRatchets() {
    if (this.ratchetsEnabled) return;
    if (!this.identity) {
      throw new Error("Ratchets require an identity.");
    }
    this.ratchets = [];
    this.ratchetsEnabled = true;
    await this.rotateRatchets(true);
  }

  /**
   * Rotates the ratchet ring when the interval has elapsed
   * (Destination.RATCHET_INTERVAL), inserting the newest key at index 0 and
   * capping the ring to {@link Destination.MAX_RATCHETS}. Pass `force` to
   * generate a key unconditionally (used for the initial key).
   *
   * No-op when ratchets are not enabled.
   *
   * @param {boolean} [force=false]
   * @returns {Promise<void>}
   */
  async rotateRatchets(force = false) {
    if (!this.ratchetsEnabled || !this.ratchets) return;
    const now = Date.now();
    if (!force && now <= this.latestRatchetTime + this.ratchetInterval) {
      return;
    }
    const kp = await generateX25519KeyPair();
    this.ratchets.unshift({
      privateKey: await exportRawPrivateKey(kp.privateKey),
      publicKey: await exportPublicKey(kp.publicKey),
    });
    while (this.ratchets.length > Destination.MAX_RATCHETS) {
      this.ratchets.pop();
    }
    this.latestRatchetTime = now;
    // TODO: persist the ratchet ring once a storage layer exists so a restart
    // can still decrypt in-flight messages encrypted to prior ratchets.
  }

  /**
   * The current (newest) ratchet public key for inclusion in announces, or an
   * empty array when ratchets are disabled. Rotates first if due.
   *
   * @returns {Promise<Uint8Array>}
   * @private
   */
  async _currentRatchetForAnnounce() {
    if (!this.ratchetsEnabled || !this.ratchets || this.ratchets.length === 0) {
      return new Uint8Array(0);
    }
    await this.rotateRatchets();
    return this.ratchets[0].publicKey.slice();
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
   * Registers a server-side REQUEST handler for a path string
   * (PROTOCOL-SPEC.md §11.3, §11.4).
   *
   * The path is hashed to `SHA-256(path)[:16]` and stored keyed by that hash;
   * the path string itself never appears on the wire. When a REQUEST arrives
   * on a Link whose responder destination is this one, `Link._handleRequest`
   * looks the handler up by the path hash, enforces the `allow` mode, and
   * invokes `responseGenerator` to produce the response value.
   *
   * @param {string} path - Opaque path token (e.g. `"/page/index.mu"`).
   * @param {object} options
   * @param {RequestGenerator} options.responseGenerator - Produces the response value.
   * @param {Allow} [options.allow=Allow.ALL] - Authorization mode.
   * @param {Uint8Array[]} [options.allowedList=[]] - Identity hashes permitted under `Allow.LIST`.
   * @param {boolean} [options.autoCompress=false] - Hint for the (future) Resource response path.
   * @returns {Promise<Uint8Array>} the 16-byte path hash the handler is keyed under.
   */
  async registerRequestHandler(path, options) {
    if (typeof options?.responseGenerator !== "function") {
      throw new TypeError("responseGenerator must be a function");
    }
    const encoder = new TextEncoder();
    const pathHash = await Identity.truncatedHash(encoder.encode(path));
    this.requestHandlers.set(toHex(pathHash), {
      path,
      responseGenerator: options.responseGenerator,
      allow: options.allow ?? Allow.ALL,
      allowedList: options.allowedList ?? [],
      autoCompress: options.autoCompress ?? false,
    });
    return pathHash;
  }

  /**
   * Removes a previously registered REQUEST handler.
   * @param {string} path
   * @returns {Promise<boolean>} true if a handler was removed.
   */
  async removeRequestHandler(path) {
    const encoder = new TextEncoder();
    const pathHash = await Identity.truncatedHash(encoder.encode(path));
    return this.requestHandlers.delete(toHex(pathHash));
  }

  /**
   * Decrypts (where applicable) and dispatches an inbound DATA packet
   * as a `data` event.
   *
   * For a CTX_NONE DATA packet addressed to a SINGLE destination we hold the
   * private key for, this also emits the regular PROOF receipt (§6.5) so the
   * sender's `PacketReceipt` resolves — without it the sender retransmits
   * indefinitely (and, on a link, the KEEPALIVE budget is exhausted).
   * @param {import('./packet.js').Packet} packet
   * @private
   */
  async _handleData(packet) {
    let plaintext = null;
    if (this.type === DestType.SINGLE && this.identity) {
      // §7.4: try each owned ratchet private key (newest first) before the
      // long-term key, so messages encrypted to a just-rotated ratchet still
      // decrypt. Identity.decrypt performs the long-term fallback itself.
      const privRing =
        this.ratchetsEnabled && this.ratchets
          ? this.ratchets.map((r) => r.privateKey)
          : null;
      plaintext = await this.identity.decrypt(packet.payload, privRing);
    } else {
      plaintext = packet.payload;
    }

    if (plaintext) {
      this.dispatchEvent(new CustomEvent("data", { detail: { plaintext } }));

      // §6.5: emit a regular PROOF for opportunistic CTX_NONE DATA once the
      // packet has been successfully received and processed.
      if (
        packet.packetType === PacketType.DATA &&
        packet.contextByte === ContextType.NONE &&
        this.type === DestType.SINGLE &&
        this.identity &&
        this.identity.ed25519Priv &&
        this.interfaceLayer
      ) {
        try {
          await this._provePacket(packet);
        } catch (err) {
          log("Destination", `Failed to emit PROOF: ${err}`, LogLevel.WARN);
        }
      }
    }
  }

  /**
   * Builds and sends the regular PROOF for a received DATA packet (§6.5).
   *
   *   packet_hash = SHA-256(get_hashable_part(packet))   (32 bytes)
   *   signature   = Ed25519_sign(packet_hash)            (64 bytes)
   *   proof_data  = implicit (signature) | explicit (packet_hash || signature)
   *
   * The PROOF is a `packet_type = PROOF (3)`, `context = NONE (0x00)` packet
   * addressed to `dest_hash = packet_hash[:16]` (the synthetic ProofDestination).
   * Upstream defaults to the 64-byte implicit form (`use_implicit_proof = True`).
   *
   * @param {import('./packet.js').Packet} packet
   * @private
   */
  async _provePacket(packet) {
    // _handleData guards these before calling, but narrow for the type checker
    // and defensive callers alike.
    if (!this.identity || !this.interfaceLayer) return;
    const packetHash = await packet.getHash();
    const signature = await this.identity.sign(packetHash);

    const useImplicit =
      /** @type {{ useImplicitProof?: boolean } | null} */ (this.interfaceLayer)
        ?.useImplicitProof ?? true;

    let proofData;
    if (useImplicit) {
      proofData = signature;
    } else {
      proofData = new Uint8Array(96);
      proofData.set(packetHash, 0);
      proofData.set(signature, 32);
    }

    const proofPacket = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.SINGLE,
      destinationHash: packetHash.slice(0, 16),
      contextByte: ContextType.NONE,
      payload: proofData,
    });

    this.interfaceLayer.broadcast(proofPacket);
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
   * Remembers a ratchet X25519 public key announced for a destination (SPEC.md
   * §4.5 step 6.2). Called only for validated announces where `context_flag`
   * was set and the ratchet is non-empty. Newest ratchets are prepended so the
   * ring is newest-first; duplicates are skipped.
   * @param {Uint8Array} destinationHash
   * @param {Uint8Array} ratchet - 32-byte ratchet X25519 public key.
   */
  static rememberRatchet(destinationHash, ratchet) {
    if (!ratchet || ratchet.length === 0) return;
    const key = toHex(destinationHash);
    /** @type {Uint8Array[]} */
    const ring = Destination.knownRatchets.get(key) ?? [];
    const copy = new Uint8Array(ratchet);
    if (!ring.some((r) => bytesEqual(r, copy))) {
      ring.unshift(copy);
      Destination.knownRatchets.set(key, ring);
    }
  }

  /**
   * Recalls the ratchet ring for a destination (newest first), or null.
   *
   * Consumed by the inbound-decrypt tolerance path (SPEC.md §7.4): a sender
   * may have encrypted to a just-rotated previous ratchet, so the receiver
   * tries each privkey in the ring before falling back to the long-term key.
   * @param {Uint8Array} destinationHash
   * @returns {Uint8Array[]|null}
   */
  static recallRatchets(destinationHash) {
    return Destination.knownRatchets.get(toHex(destinationHash)) ?? null;
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
    // §7.4: encrypt to the recipient's newest known ratchet public key for
    // forward secrecy when one was learned from an announce; otherwise fall
    // back to the long-term X25519 key (Identity.encrypt handles ratchet=null).
    const ring = this.destinationHash
      ? Destination.recallRatchets(this.destinationHash)
      : null;
    const ratchet = ring && ring.length > 0 ? ring[0] : null;
    return await this.identity.encrypt(data, ratchet);
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
