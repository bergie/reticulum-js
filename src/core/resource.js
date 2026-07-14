/**
 * @file resource.js
 * @description Resource fragmentation protocol (PROTOCOL-SPEC.md §10).
 *
 * Phase 1+2 scope: single-segment transfers over an ACTIVE link, with optional
 * bz2 compression (only when a bz2 module is injected by the caller — the
 * library never imports a compression dependency itself). Implements:
 *
 *   - sender preparation: random prefix, link-encrypt-whole-then-slice,
 *     hashmap construction with COLLISION_GUARD_SIZE collision avoidance.
 *   - RESOURCE_ADV advertisement with correct flags/context.
 *   - receiver accept with advertised-size cap (§10.4 bomb defense).
 *   - the receiver request loop (RESOURCE_REQ) with windowed pacing and
 *     RESOURCE_HMU hashmap continuation for resources with more parts than
 *     HASHMAP_MAX_LEN.
 *   - part matching by 4-byte map_hash (out-of-order tolerant).
 *   - assembly: link-decrypt, strip prefix, optional decompress, hash check.
 *   - RESOURCE_PRF proof handshake (receiver proves, sender validates).
 *   - RESOURCE_ICL / RESOURCE_RCL cancellation.
 *
 * Phase 3 (not yet implemented): sliding-window rate adaptation, watchdog /
 * advertisement retransmit, multi-segment splitting (> 1 MiB), and the full
 * decompression-bomb streaming bound (a receive-time `d` cap is enforced now).
 */

import { bytesEqual, concatBytes, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { MicroMsgPack } from "../utils/msgpack.js";
import { Identity } from "./identity.js";
import { ContextType, DestType, Packet, PacketType } from "./packet.js";
import {
  ResourceAdvertisement,
  ResourceFlag,
} from "./resource_advertisement.js";

/** @enum {number} */
export const ResourceStatus = {
  NONE: 0,
  QUEUED: 1,
  ADVERTISED: 2,
  TRANSFERRING: 3,
  ASSEMBLING: 4,
  AWAITING_PROOF: 5,
  COMPLETE: 6,
  FAILED: 7,
  CORRUPT: 8,
  REJECTED: 9,
};

/** Receiver-side RESOURCE_REQ hashmap-exhausted flag values (§10.5). */
const HASHMAP_IS_NOT_EXHAUSTED = 0x00;
const HASHMAP_IS_EXHAUSTED = 0xff;

/**
 * @typedef {object} Bzip2
 * @property {(data: Uint8Array) => Uint8Array} compress
 * @property {(data: Uint8Array, outputLen: number) => Uint8Array} decompress
 */

/**
 * A Reticulum Resource — a fragmented transfer riding on top of an ACTIVE Link.
 *
 * Construct with `data` for the sender side (then `await resource.advertise()`);
 * or via {@link Resource.accept} on the receiver side. Both sides emit
 * `progress` / `complete` / `failed` events, and expose `whenComplete()` for
 * promise-based consumers.
 */
export class Resource extends EventTarget {
  /**
   * Size of the throwaway random prefix prepended to the wire body (§10.2
   * step 3). Distinct from the advertisement `r` field.
   */
  static RANDOM_HASH_SIZE = 4;

  /** `RNS.Reticulum.IFAC_MIN_SIZE` — reserved IFAC bytes when computing SDU. */
  static IFAC_MIN_SIZE = 1;

  /**
   * `RNS.Packet.HEADER_MAXSIZE` — worst-case header after relay HEADER_1→HEADER_2
   * conversion: flags(1) + hops(1) + transport_id(16) + dest_hash(16) + context(1).
   */
  static HEADER_MAXSIZE = 35;

  /** Initial receiver request window (§10.10). */
  static WINDOW = 4;

  /** Default window cap used for the collision-guard span (§10.10 WINDOW_MAX_SLOW). */
  static WINDOW_MAX_SLOW = 10;

  /** Constants in the advertisement-size formula `HASHMAP_MAX_LEN = (MDU-134)/4`. */
  static HASHMAP_FIXED_OVERHEAD = 134;

  /** Cap on advertised transfer/logical size at accept time (§10.4 bomb defense). */
  static DEFAULT_MAX_SIZE = 32 * 1024 * 1024;

  /** Receiver request window during a transfer. */
  window = Resource.WINDOW;

  /**
   * @param {Object} options
   * @param {Uint8Array|undefined} [options.data] - Sender-side payload.
   * @param {import("../transport/link.js").Link|undefined} [options.link]
   * @param {boolean} [options.autoCompress=true]
   * @param {Uint8Array} [options.originalHash]
   * @param {Uint8Array} [options.requestId] - Associated REQUEST id (§11).
   * @param {boolean} [options.isRequest=false] - This Resource is a REQUEST body.
   * @param {boolean} [options.isResponse=false] - This Resource is a RESPONSE body.
   * @param {Bzip2} [options.bz2] - Injected bz2 module; never imported by the library.
   */
  constructor(options = {}) {
    super();
    this.data = options.data;
    /** @type {import("../transport/link.js").Link} */
    this.link = /** @type {import("../transport/link.js").Link} */ (
      options.link
    );
    this.autoCompress = options.autoCompress ?? true;
    this.originalHash = options.originalHash;
    this.requestId = options.requestId;
    this.isRequest = options.isRequest ?? false;
    this.isResponse = options.isResponse ?? false;
    /** @type {Bzip2|undefined} */
    this.bz2 = options.bz2;

    this.status = ResourceStatus.NONE;
    /** @type {(Uint8Array|null)[]} */
    this.parts = [];
    /** @type {Uint8Array[]} */ // expected 4-byte map_hashes per part
    this.hashmap = [];
    this.receivedCount = 0;
    this.totalParts = 0;
    this.totalSize = 0; // t: encrypted wire byte length
    this.size = 0;
    /** @type {Uint8Array|undefined} */ // h: SHA-256(plaintext ‖ r)
    this.hash = undefined;
    /** @type {Uint8Array|undefined} */ // r: 4-byte integrity/hashmap salt
    this.randomHash = undefined;
    /** @type {Uint8Array|undefined} */ // SHA-256(plaintext ‖ hash); receiver returns this
    this.expectedProof = undefined;
    this.compressed = false;
    this.encrypted = false;
    this.hasMetadata = false;
    this.split = false;
    this.segmentIndex = 1;
    this.totalSegments = 1;
    this.uncompressedSize = 0;
    /** Outstanding part requests in the current window (receiver). */
    this.outstanding = 0;
    /** Whether sender preparation is done. */
    this._prepared = false;
  }

  /**
   * Maximum part body size. Parts are raw slices of the already-encrypted
   * whole, sent as `context=RESOURCE` packets which are NOT token-encrypted
   * (§10.6 gotcha), so the full SDU is available for part data.
   * @returns {number}
   */
  get sdu() {
    if (!this.link) return 0;
    return this.link.mtu - Resource.HEADER_MAXSIZE - Resource.IFAC_MIN_SIZE;
  }

  /**
   * Number of 4-byte map_hashes that fit in one advertisement's `m` field
   * (§10.4): `floor((link.mdu - 134) / 4)`. At the default MDU 431 this is 74.
   * @returns {number}
   */
  get hashmapMaxLen() {
    if (!this.link) return 0;
    return Math.floor((this.link.mdu - Resource.HASHMAP_FIXED_OVERHEAD) / 4);
  }

  /**
   * Collision-guard span (§10.2 step 7): map_hashes must be unique within this
   * many parts of any position.
   * @returns {number}
   */
  get collisionGuardSize() {
    return 2 * Resource.WINDOW_MAX_SLOW + this.hashmapMaxLen;
  }

  // -----------------------------------------------------------------------
  // Sender side
  // -----------------------------------------------------------------------

  /**
   * Prepares the resource for sending (§10.2): optional compression, integrity
   * material over the uncompressed plaintext, link-encrypt the whole
   * `prefix ‖ body` blob, slice into SDU parts, and build the collision-guarded
   * hashmap. Idempotent.
   * @returns {Promise<void>}
   * @private
   */
  async _prepareSender() {
    if (this._prepared) return;
    if (!(this.data instanceof Uint8Array)) {
      throw new TypeError("Resource sender data must be a Uint8Array");
    }
    const plaintext = this.data;
    this.uncompressedSize = plaintext.length; // d: original uncompressed size

    // §10.2 step 2 — optional bz2 compression (only if a module was injected).
    let body = plaintext;
    if (this.autoCompress && this.bz2) {
      const compressed = this.bz2.compress(plaintext);
      if (compressed.length < plaintext.length) {
        body = compressed;
        this.compressed = true;
      }
    }

    await this._buildIntegrityAndParts(plaintext, body);
    this._prepared = true;
  }

  /**
   * Computes the integrity material (hash, expected_proof, random_hash salt),
   * link-encrypts `prefix ‖ body`, slices into parts, and builds the hashmap.
   *
   * Integrity is always over the uncompressed `plaintext` (§10.2 step 5), even
   * when `body` is the compressed form — the receiver decompresses before the
   * hash check.
   *
   * @param {Uint8Array} plaintext
   * @param {Uint8Array} body
   * @returns {Promise<void>}
   * @private
   */
  async _buildIntegrityAndParts(plaintext, body) {
    // Retry with a fresh salt if the collision guard trips (§10.2 step 7).
    for (let attempt = 0; attempt < 8; attempt++) {
      // r: 4-byte integrity/hashmap salt (advertisement `r` field).
      this.randomHash = Identity.getRandomHash().slice(
        0,
        Resource.RANDOM_HASH_SIZE,
      );

      // h = SHA-256(plaintext ‖ r); expected_proof = SHA-256(plaintext ‖ h).
      this.hash = await Identity.fullHash(
        concatBytes(plaintext, this.randomHash),
      );
      this.expectedProof = await Identity.fullHash(
        concatBytes(plaintext, this.hash),
      );

      // Encrypt the WHOLE `prefix ‖ body` once (§10.12), then slice.
      const prefix = Identity.getRandomHash().slice(
        0,
        Resource.RANDOM_HASH_SIZE,
      );
      if (!this.link.token) {
        throw new Error("Link token unavailable; handshake not complete.");
      }
      const encrypted = await this.link.token.encrypt(
        concatBytes(prefix, body),
      );
      this.encrypted = true;
      this.totalSize = encrypted.length; // t
      this.totalParts = Math.max(1, Math.ceil(encrypted.length / this.sdu));

      this.parts = [];
      for (let i = 0; i < this.totalParts; i++) {
        const start = i * this.sdu;
        this.parts.push(
          encrypted.subarray(
            start,
            Math.min(start + this.sdu, encrypted.length),
          ),
        );
      }

      // Build hashmap; bail & regenerate the salt if a collision is found.
      this.hashmap = await Promise.all(
        this.parts.map((p) => this._mapHash(/** @type {Uint8Array} */ (p))),
      );
      if (!this._hasCollision()) {
        return;
      }
      log(
        "Resource",
        `Hashmap collision on attempt ${attempt + 1}; regenerating salt`,
        LogLevel.DEBUG,
      );
    }
    throw new Error("Failed to construct a collision-free resource hashmap");
  }

  /**
   * 4-byte map_hash for a part: `SHA-256(part ‖ r)[:4]` (§10.6).
   * @param {Uint8Array} part
   * @returns {Promise<Uint8Array>}
   * @private
   */
  async _mapHash(part) {
    const full = await Identity.fullHash(
      concatBytes(part, /** @type {Uint8Array} */ (this.randomHash)),
    );
    return full.slice(0, 4);
  }

  /**
   * Returns true if any two map_hashes collide within COLLISION_GUARD_SIZE of
   * each other (§10.2 step 7).
   * @returns {boolean}
   * @private
   */
  _hasCollision() {
    const span = this.collisionGuardSize;
    for (let i = 0; i < this.hashmap.length; i++) {
      const lo = Math.max(0, i - span);
      for (let j = lo; j < i; j++) {
        if (bytesEqual(this.hashmap[i], this.hashmap[j])) return true;
      }
    }
    return false;
  }

  /**
   * The hashmap fragment carried in this advertisement's `m` field: the first
   * `hashmapMaxLen` 4-byte map_hashes concatenated (§10.4).
   * @returns {Uint8Array}
   * @private
   */
  _advHashmapFragment() {
    const count = Math.min(this.hashmap.length, this.hashmapMaxLen);
    return concatBytes(...this.hashmap.slice(0, count));
  }

  /**
   * Builds and sends the RESOURCE_ADV (§10.4). The link registers this
   * resource as an outgoing transfer keyed by `hash`.
   * @returns {Promise<void>}
   */
  async advertise() {
    if (!this.link) throw new Error("Resource.advertise requires a link");
    await this._prepareSender();
    if (this.status !== ResourceStatus.NONE) {
      throw new Error("Resource already advertised or in progress");
    }

    let f = 0;
    if (this.encrypted) f |= ResourceFlag.ENCRYPTED;
    if (this.compressed) f |= ResourceFlag.COMPRESSED;
    if (this.split) f |= ResourceFlag.SPLIT;
    if (this.isRequest) f |= ResourceFlag.IS_REQUEST;
    if (this.isResponse) f |= ResourceFlag.IS_RESPONSE;
    if (this.hasMetadata) f |= ResourceFlag.HAS_METADATA;

    const adv = new ResourceAdvertisement({
      t: this.totalSize,
      d: this.uncompressedSize,
      n: this.totalParts,
      h: /** @type {Uint8Array} */ (this.hash),
      r: /** @type {Uint8Array} */ (this.randomHash),
      o: this.originalHash || this.hash,
      i: this.segmentIndex,
      l: this.totalSegments,
      q: this.requestId,
      f,
      m: this._advHashmapFragment(),
    });

    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.link.linkId,
      contextByte: ContextType.RESOURCE_ADV,
      payload: adv.pack(),
    });

    this.status = ResourceStatus.QUEUED;
    this.link._registerOutgoingResource(this);
    await this.link.send(packet);
    this.status = ResourceStatus.ADVERTISED;
    log(
      "Resource",
      `Advertised ${this.totalParts} parts (${this.totalSize}B) h=${toHex(/** @type {Uint8Array} */ (this.hash).subarray(0, 8))}…`,
      LogLevel.DEBUG,
    );
  }

  /**
   * Sender: fulfils an inbound RESOURCE_REQ (§10.5/§10.7) — emits the
   * requested RESOURCE part packets, and a RESOURCE_HMU continuation when the
   * receiver signalled hashmap exhaustion.
   * @param {Uint8Array} body
   * @returns {Promise<void>}
   */
  async handleRequest(body) {
    const { requested, exhausted, lastMapHash } = this._parseRequest(body);
    // §10.7: fulfil parts for EVERY req, including exhausted ones.
    for (const mh of requested) {
      const idx = this._findPartByMapHash(mh);
      if (idx < 0) {
        log(
          "Resource",
          "Requested map_hash not found; skipping",
          LogLevel.DEBUG,
        );
        continue;
      }
      await this._sendPart(/** @type {Uint8Array} */ (this.parts[idx]));
    }
    if (exhausted) {
      await this._sendHashmapUpdate(/** @type {Uint8Array} */ (lastMapHash));
    }
  }

  /**
   * Sends one RESOURCE part packet. Parts are NOT token-encrypted — they are
   * raw slices of the already-encrypted whole (§10.6 gotcha); `Link.send`
   * honours that because `isLinkPacketUnencrypted(DATA, RESOURCE)` is true.
   * @param {Uint8Array} part
   * @returns {Promise<void>}
   * @private
   */
  async _sendPart(part) {
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.link.linkId,
      contextByte: ContextType.RESOURCE,
      payload: part,
    });
    await this.link.send(packet);
  }

  /**
   * Sender: validates a RESOURCE_PRF (§10.8). Body is `resource_hash(32) ||
   * full_proof(32)`; `full_proof` must equal the pre-computed `expected_proof`.
   * @param {Uint8Array} body
   * @returns {Promise<void>}
   */
  async validateProof(body) {
    if (body.length !== 64) {
      log("Resource", `Bad RESOURCE_PRF length ${body.length}`, LogLevel.WARN);
      return;
    }
    const fullProof = body.subarray(32, 64);
    if (
      !bytesEqual(fullProof, /** @type {Uint8Array} */ (this.expectedProof))
    ) {
      log("Resource", "RESOURCE_PRF full_proof mismatch", LogLevel.WARN);
      this.status = ResourceStatus.FAILED;
      this._setFailed("Resource proof mismatch");
      return;
    }
    this.status = ResourceStatus.COMPLETE;
    log(
      "Resource",
      "Outgoing resource COMPLETE (proof validated)",
      LogLevel.DEBUG,
    );
    this.dispatchEvent(
      new CustomEvent("complete", { detail: { resource: this } }),
    );
  }

  /**
   * Sender: sends a RESOURCE_HMU carrying the hashmap window after
   * `lastMapHash` (§10.7). Body = `resource_hash(32) ‖ msgpack([segment_index,
   * hashmap_bytes])`.
   * @param {Uint8Array} lastMapHash
   * @returns {Promise<void>}
   * @private
   */
  async _sendHashmapUpdate(lastMapHash) {
    const fromIdx = this.hashmap.findIndex((mh) => bytesEqual(mh, lastMapHash));
    if (fromIdx < 0 || (fromIdx + 1) % this.hashmapMaxLen !== 0) {
      // §10.7: a non-boundary index is a sequencing error → cancel.
      log("Resource", "HMU sequencing error; cancelling", LogLevel.WARN);
      await this.cancel();
      return;
    }
    const segIndex = Math.floor((fromIdx + 1) / this.hashmapMaxLen);
    const start = (fromIdx + 1) % this.hashmap.length;
    const end = Math.min(start + this.hashmapMaxLen, this.hashmap.length);
    const segment = concatBytes(...this.hashmap.slice(start, end));
    const inner = MicroMsgPack.encode([segIndex, segment]);
    const payload = concatBytes(/** @type {Uint8Array} */ (this.hash), inner);
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.link.linkId,
      contextByte: ContextType.RESOURCE_HMU,
      payload,
    });
    await this.link.send(packet);
  }

  /**
   * Finds the part index whose map_hash equals `mh`. The collision guard
   * guarantees uniqueness within the resource.
   * @param {Uint8Array} mh
   * @returns {number}
   * @private
   */
  _findPartByMapHash(mh) {
    for (let i = 0; i < this.hashmap.length; i++) {
      if (bytesEqual(this.hashmap[i], mh)) return i;
    }
    return -1;
  }

  /**
   * Parses a RESOURCE_REQ body (§10.5).
   * @param {Uint8Array} body
   * @returns {{requested: Uint8Array[], exhausted: boolean, lastMapHash: Uint8Array|null, resourceHash: Uint8Array}}
   * @private
   */
  _parseRequest(body) {
    const exhausted = body[0] === HASHMAP_IS_EXHAUSTED;
    let offset = 1;
    /** @type {Uint8Array|null} */
    let lastMapHash = null;
    if (exhausted) {
      lastMapHash = body.slice(1, 5);
      offset = 5;
    }
    const resourceHash = body.slice(offset, offset + 32);
    offset += 32;
    const requested = [];
    for (let i = offset; i + 4 <= body.length; i += 4) {
      requested.push(body.slice(i, i + 4));
    }
    return { requested, exhausted, lastMapHash, resourceHash };
  }

  // -----------------------------------------------------------------------
  // Receiver side
  // -----------------------------------------------------------------------

  /**
   * Accepts an inbound RESOURCE_ADV and prepares to receive parts (§10.4/§10.5).
   *
   * @param {import("../transport/link.js").Link} link
   * @param {import("./packet.js").Packet} advertisementPacket
   * @param {object} [options]
   * @param {Bzip2} [options.bz2]
   * @param {number} [options.maxSize] - Reject advertisements whose `t` or `d`
   *   exceeds this (§10.4 bomb defense). Defaults to 32 MiB.
   * @returns {Promise<Resource|null>} null if the advertisement was rejected.
   */
  static async accept(link, advertisementPacket, options = {}) {
    const adv = ResourceAdvertisement.unpack(advertisementPacket.payload);
    const maxSize = options.maxSize ?? Resource.DEFAULT_MAX_SIZE;
    if (adv.t > maxSize || adv.d > maxSize) {
      log(
        "Resource",
        `Rejecting advertisement: size t=${adv.t} d=${adv.d} over cap ${maxSize}`,
        LogLevel.WARN,
      );
      await Resource._sendReject(link, adv.h);
      return null;
    }

    const resource = new Resource({ link, bz2: options.bz2 });
    resource.status = ResourceStatus.TRANSFERRING;
    resource.totalSize = adv.t;
    resource.uncompressedSize = adv.d;
    resource.totalParts = adv.n;
    resource.hash = adv.h;
    resource.randomHash = adv.r;
    resource.originalHash = adv.o;
    resource.segmentIndex = adv.i;
    resource.totalSegments = adv.l;
    resource.requestId = adv.q;
    resource.compressed = adv.compressed;
    resource.encrypted = adv.encrypted;
    resource.isRequest = adv.isRequest;
    resource.isResponse = adv.isResponse;
    resource.hasMetadata = adv.hasMetadata;

    resource.parts = new Array(resource.totalParts).fill(null);
    resource.hashmap = Resource._splitHashmap(adv.m);
    resource.receivedCount = 0;
    resource.outstanding = 0;

    link._registerIncomingResource(resource);
    log(
      "Resource",
      `Accepted advertisement: ${resource.totalParts} parts, compressed=${resource.compressed}`,
      LogLevel.DEBUG,
    );
    return resource;
  }

  /**
   * Splits a concatenated hashmap fragment into its 4-byte map_hashes.
   * @param {Uint8Array} fragment
   * @returns {Uint8Array[]}
   * @private
   */
  static _splitHashmap(fragment) {
    /** @type {Uint8Array[]} */
    const out = [];
    for (let i = 0; i + 4 <= fragment.length; i += 4) {
      out.push(fragment.slice(i, i + 4));
    }
    return out;
  }

  /**
   * Receiver: builds and sends the next RESOURCE_REQ for missing parts
   * (§10.5). Windowed stop-and-wait for Phase 2 — requests up to `window`
   * outstanding missing parts, then waits for them before requesting more.
   * @returns {Promise<void>}
   */
  async requestNext() {
    if (this.status !== ResourceStatus.TRANSFERRING) return;
    if (this.receivedCount >= this.totalParts) return;

    /** @type {Uint8Array[]} */
    const requested = [];
    /** @type {Uint8Array|null} */
    let lastKnown = null;
    let exhausted = false;

    for (
      let i = 0;
      i < this.hashmap.length && requested.length < this.window;
      i++
    ) {
      if (this.parts[i] === null) {
        requested.push(this.hashmap[i]);
      }
      lastKnown = this.hashmap[i];
    }
    // Exhausted iff there are still-unfilled slots beyond the known hashmap.
    if (this.parts.some((p) => p === null) && requested.length === 0) {
      exhausted = true;
    }

    if (!exhausted && requested.length === 0) return;

    this.outstanding = requested.length;
    await this._sendRequest(requested, exhausted, exhausted ? lastKnown : null);
  }

  /**
   * Sends a RESOURCE_REQ (§10.5).
   * @param {Uint8Array[]} mapHashes
   * @param {boolean} exhausted
   * @param {Uint8Array|null} lastMapHash
   * @returns {Promise<void>}
   * @private
   */
  async _sendRequest(mapHashes, exhausted, lastMapHash) {
    /** @type {Uint8Array[]} */
    const parts = [
      new Uint8Array([
        exhausted ? HASHMAP_IS_EXHAUSTED : HASHMAP_IS_NOT_EXHAUSTED,
      ]),
    ];
    if (exhausted && lastMapHash) parts.push(lastMapHash);
    parts.push(/** @type {Uint8Array} */ (this.hash));
    for (const mh of mapHashes) parts.push(mh);
    const payload = concatBytes(...parts);

    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.link.linkId,
      contextByte: ContextType.RESOURCE_REQ,
      payload,
    });
    await this.link.send(packet);
  }

  /**
   * Receiver: places an incoming RESOURCE part by matching its 4-byte
   * map_hash against the hashmap (§10.6). Returns true if the part was placed.
   * @param {Uint8Array} chunk
   * @returns {Promise<boolean>}
   */
  async receivePart(chunk) {
    if (
      this.status !== ResourceStatus.TRANSFERRING &&
      this.status !== ResourceStatus.ASSEMBLING
    ) {
      return false;
    }
    const mh = await this._mapHash(chunk);
    for (let i = 0; i < this.hashmap.length; i++) {
      if (this.parts[i] === null && bytesEqual(this.hashmap[i], mh)) {
        this.parts[i] = chunk;
        this.receivedCount++;
        if (this.outstanding > 0) this.outstanding--;
        this.dispatchEvent(
          new CustomEvent("progress", {
            detail: {
              received: this.receivedCount,
              total: this.totalParts,
              progress: this.getProgress(),
            },
          }),
        );
        if (this.receivedCount >= this.totalParts) {
          await this.assemble();
        } else if (this.outstanding <= 0) {
          await this.requestNext();
        }
        return true;
      }
    }
    return false; // duplicate or unknown part
  }

  /**
   * Receiver: applies a RESOURCE_HMU hashmap continuation (§10.7).
   * @param {Uint8Array} body
   * @returns {Promise<void>}
   */
  async hashmapUpdate(body) {
    const resourceHash = body.slice(0, 32);
    const decoded = MicroMsgPack.decode(body.subarray(32));
    if (!Array.isArray(decoded) || decoded.length < 2) return;
    const segment = decoded[1];
    if (!(segment instanceof Uint8Array)) return;
    for (const mh of Resource._splitHashmap(segment)) this.hashmap.push(mh);
    log(
      "Resource",
      `Applied HMU (${this.hashmap.length} map_hashes known) for ${toHex(resourceHash.subarray(0, 8))}…`,
      LogLevel.DEBUG,
    );
    if (this.outstanding <= 0) await this.requestNext();
  }

  /**
   * Receiver: assembles all parts, link-decrypts, strips the prefix, optional
   * decompress, recomputes the integrity hash, and emits the RESOURCE_PRF
   * (§10.8).
   * @returns {Promise<void>}
   */
  async assemble() {
    this.status = ResourceStatus.ASSEMBLING;
    try {
      const encrypted = concatBytes(
        .../** @type {Uint8Array[]} */ (this.parts),
      );
      if (!this.link.token) {
        throw new Error("Link token unavailable; handshake not complete.");
      }
      const decrypted = await this.link.token.decrypt(encrypted);

      // §10.8 step 3: strip & DISCARD the 4-byte prefix (NOT advertisement.r).
      const body = decrypted.subarray(Resource.RANDOM_HASH_SIZE);

      let plaintext = body;
      if (this.compressed) {
        if (!this.bz2) {
          throw new Error(
            "Resource is compressed but no bz2 module was provided",
          );
        }
        // §10.4 bomb defense: bound the output to the advertised `d`.
        plaintext = this.bz2.decompress(body, this.uncompressedSize);
      }

      // §10.8 step 5: SHA-256(plaintext ‖ r) over the prefix-stripped body.
      const recomputed = await Identity.fullHash(
        concatBytes(plaintext, /** @type {Uint8Array} */ (this.randomHash)),
      );
      if (!bytesEqual(recomputed, /** @type {Uint8Array} */ (this.hash))) {
        this.status = ResourceStatus.CORRUPT;
        await this.cancel();
        this._setFailed("Resource integrity check failed");
        return;
      }

      this.data = plaintext;
      this.status = ResourceStatus.COMPLETE;
      await this._sendProof();
      log("Resource", "Incoming resource COMPLETE", LogLevel.DEBUG);
      this.dispatchEvent(
        new CustomEvent("complete", {
          detail: { resource: this, data: plaintext },
        }),
      );
    } catch (err) {
      log("Resource", `Assembly failed: ${err}`, LogLevel.ERROR);
      this.status = ResourceStatus.CORRUPT;
      this._setFailed(`Resource assembly failed: ${err}`);
    }
  }

  /**
   * Receiver: emits the RESOURCE_PRF (§10.8).
   * `proof_data = resource_hash(32) ‖ SHA-256(plaintext ‖ resource_hash)(32)`.
   * @returns {Promise<void>}
   * @private
   */
  async _sendProof() {
    const fullProof = await Identity.fullHash(
      concatBytes(
        /** @type {Uint8Array} */ (this.data),
        /** @type {Uint8Array} */ (this.hash),
      ),
    );
    const payload = concatBytes(
      /** @type {Uint8Array} */ (this.hash),
      fullProof,
    );
    const packet = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.LINK,
      destinationHash: this.link.linkId,
      contextByte: ContextType.RESOURCE_PRF,
      payload,
    });
    await this.link.send(packet);
  }

  // -----------------------------------------------------------------------
  // Cancellation (§10.9)
  // -----------------------------------------------------------------------

  /**
   * Cancels the resource. Sender emits RESOURCE_ICL; receiver cancels locally
   * (an ordinary receiver cancel does NOT emit RESOURCE_RCL per §10.9).
   * @returns {Promise<void>}
   */
  async cancel() {
    if (this.status === ResourceStatus.COMPLETE) return;
    const wasSending =
      this.parts.length > 0 && this._prepared && this.hashmap.length > 0;
    // Heuristic: the side that advertised (sender) emits ICL.
    if (wasSending && this.status !== ResourceStatus.NONE) {
      const payload = concatBytes(/** @type {Uint8Array} */ (this.hash));
      const packet = new Packet({
        packetType: PacketType.DATA,
        destinationType: DestType.LINK,
        destinationHash: this.link.linkId,
        contextByte: ContextType.RESOURCE_ICL,
        payload,
      });
      try {
        await this.link.send(packet);
      } catch (err) {
        log("Resource", `Failed to send RESOURCE_ICL: ${err}`, LogLevel.WARN);
      }
    }
    this.status = ResourceStatus.FAILED;
    this._setFailed("Resource cancelled");
  }

  /**
   * Receiver: peer (initiator) cancelled via RESOURCE_ICL.
   * @returns {Promise<void>}
   */
  async handleIncomingCancel() {
    this.status = ResourceStatus.FAILED;
    this._setFailed("Remote cancelled the resource (RESOURCE_ICL)");
  }

  /**
   * Sender: peer (receiver) rejected via RESOURCE_RCL.
   * @returns {Promise<void>}
   */
  async handleRejection() {
    this.status = ResourceStatus.REJECTED;
    this._setFailed("Resource rejected by receiver (RESOURCE_RCL)");
  }

  /**
   * @param {import("../transport/link.js").Link} link
   * @param {Uint8Array} resourceHash
   * @returns {Promise<void>}
   * @private
   */
  static async _sendReject(link, resourceHash) {
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: link.linkId,
      contextByte: ContextType.RESOURCE_RCL,
      payload: resourceHash,
    });
    await link.send(packet);
  }

  /**
   * Resolves when the transfer reaches a terminal state (COMPLETE/FAILED/etc).
   * Rejects if the resource fails rather than completing.
   * @returns {Promise<Resource>}
   */
  whenComplete() {
    return new Promise((resolve, reject) => {
      const onComplete = (/** @type {any} */ e) => {
        this.removeEventListener("complete", onComplete);
        this.removeEventListener("failed", onFailed);
        resolve(this);
      };
      const onFailed = (/** @type {any} */ e) => {
        this.removeEventListener("complete", onComplete);
        this.removeEventListener("failed", onFailed);
        reject(new Error(e?.detail?.reason ?? "resource failed"));
      };
      if (this.status === ResourceStatus.COMPLETE) return resolve(this);
      if (
        this.status === ResourceStatus.FAILED ||
        this.status === ResourceStatus.CORRUPT ||
        this.status === ResourceStatus.REJECTED
      ) {
        return reject(new Error(`resource already ${this.status}`));
      }
      this.addEventListener("complete", onComplete);
      this.addEventListener("failed", onFailed);
    });
  }

  /** @param {string} reason @private */
  _setFailed(reason) {
    this.dispatchEvent(
      new CustomEvent("failed", { detail: { resource: this, reason } }),
    );
  }

  /**
   * Current transfer progress as a float in [0.0, 1.0].
   * @returns {number}
   */
  getProgress() {
    if (this.totalParts === 0) return 0;
    return this.receivedCount / this.totalParts;
  }
}
