/**
 * @file link.js
 * @description Reticulum Link — an ephemeral encrypted channel between two
 * destinations, established via a LINKREQUEST/LRPROOF handshake (LINKS.md §6).
 *
 * This module is the single source of truth for the Link protocol. Both the
 * initiator and responder handshake paths live here; Destination only delegates.
 */

import {
  ContextType,
  DestType,
  getEnumName,
  HeaderType,
  Packet,
  PacketType,
} from "../core/packet.js";
import { hkdf } from "../crypto/ciphers.js";
import {
  exportPublicKey,
  generateEd25519KeyPair,
  generateX25519KeyPair,
} from "../crypto/keys.js";
import { Token } from "../crypto/token.js";
import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { MicroMsgPack } from "../utils/msgpack.js";

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

/**
 * Returns true if a packet on a Link must NOT be Token-encrypted.
 *
 * Mirrors `RNS/Packet.py` `pack()` for a HEADER_1 packet whose destination is a
 * Link (LINKS.md §6.7.1, §6.5). The not-encrypted branches are:
 *   - LINKREQUEST (handled separately, never reaches this predicate on a live link)
 *   - packet_type PROOF with context NONE         (regular link DATA proof)
 *   - packet_type PROOF with context RESOURCE_PRF (resource proof)
 *   - context RESOURCE    (resource parts encrypt themselves)
 *   - context KEEPALIVE
 *   - context CACHE_REQUEST
 * Everything else (LRRTT, LINKCLOSE, LINKIDENTIFY, RESOURCE_ADV/REQ/HMU/ICL/RCL,
 * CHANNEL, REQUEST, RESPONSE, NONE DATA) is Token-encrypted.
 *
 * @param {number} packetType
 * @param {number} contextByte
 * @returns {boolean}
 */
export function isLinkPacketUnencrypted(packetType, contextByte) {
  if (packetType === PacketType.PROOF) {
    return (
      contextByte === ContextType.NONE ||
      contextByte === ContextType.RESOURCE_PRF
    );
  }
  return (
    contextByte === ContextType.RESOURCE ||
    contextByte === ContextType.KEEPALIVE ||
    contextByte === ContextType.CACHE_REQUEST
  );
}

/**
 * Derives the 16-byte link_id from a serialized LINKREQUEST packet.
 *
 * `link_id = truncated_hash(low_flags || dest_hash || context || body)` with the
 * trailing MTU-discovery signalling bytes (if present) stripped before hashing,
 * so the id is invariant under signalling changes (`RNS/Link.py:341-348`).
 *
 * @param {Packet} packet - a LINKREQUEST packet with `raw` populated
 * @returns {Promise<Uint8Array>}
 */
export async function linkIdFromLrPacket(packet) {
  const { Identity } = await import("../core/identity.js");
  const lowFlags = packet.raw[0] & 0x0f;
  const offset = packet.headerType === HeaderType.HEADER_2 ? 18 : 2;
  let body = packet.raw.subarray(offset);
  // Strip trailing signalling if the LINKREQUEST body is longer than ECPUBSIZE.
  if (packet.payload.length > Link.ECPUBSIZE) {
    const diff = packet.payload.length - Link.ECPUBSIZE;
    body = body.subarray(0, body.length - diff);
  }
  const hashable = new Uint8Array(1 + body.length);
  hashable[0] = lowFlags;
  hashable.set(body, 1);
  return Identity.truncatedHash(hashable);
}

/**
 * An ephemeral encrypted channel between two destinations.
 *
 * A Link is established through a LINKREQUEST/LRPROOF handshake which derives
 * shared session keys; once ACTIVE, application packets are Token-encrypted
 * over the link. Provides inbound sequencing, keepalive/watchdog handling,
 * link identification, and resource advertisement transport.
 *
 * Construct via {@link Link.initiate} or {@link Link.accept}; do not call the
 * constructor directly.
 */
export class Link extends EventTarget {
  /** Combined size of the two initiator ephemeral public keys (X25519 + Ed25519). */
  static ECPUBSIZE = 64;

  /** Size of the optional MTU/mode signalling trailer on LINKREQUEST/LRPROOF. */
  static LINK_MTU_SIZE = 3;

  /** Default link mode (the only enabled mode in upstream RNS). */
  static MODE_AES256_CBC = 0x01;

  /** Default Reticulum MTU when MTU discovery is disabled or unavailable. */
  static DEFAULT_MTU = 500;

  // Keepalive cadence constants (RNS/Link.py:79-101)
  static KEEPALIVE_MAX = 360;
  static KEEPALIVE_MIN = 5;
  static KEEPALIVE_MAX_RTT = 1.75;
  static STALE_FACTOR = 2;

  /**
   * Multiplier on measured RTT used when computing the default REQUEST
   * response timeout (PROTOCOL-SPEC.md §11.5). Mirrors
   * `RNS.Link.TRAFFIC_TIMEOUT_FACTOR` — verify against upstream if precise
   * timeout parity matters.
   */
  static TRAFFIC_TIMEOUT_FACTOR = 6;

  /**
   * Response-side grace term for the default REQUEST timeout
   * (PROTOCOL-SPEC.md §11.5). Mirrors
   * `RNS.Resource.RESPONSE_MAX_GRACE_TIME` — the same caveat applies.
   */
  static RESPONSE_MAX_GRACE_TIME = 4.0;

  /** Fixed multiplier on the response grace term (PROTOCOL-SPEC.md §11.5). */
  static RESPONSE_GRACE_FACTOR = 1.125;

  /** @type {number} */
  mode = Link.MODE_AES256_CBC;

  /** @type {number} */
  rtt = 0;

  /** @type {number} */
  keepaliveInterval = Link.KEEPALIVE_MAX;

  /** @type {number} */
  staleTime = Link.STALE_FACTOR * Link.KEEPALIVE_MAX;

  /** @type {Token|null} */
  token = null;

  /** @type {Uint8Array|null} */
  derivedKey = null;

  /** @type {number} */
  mtu = Link.DEFAULT_MTU;

  /** @type {number} */
  teardownReason = 0;

  /**
   * Wall-clock time (ms) at which the LINKREQUEST was sent (initiator) or
   * received (responder). Used to measure RTT.
   * @type {number}
   */
  requestTimeMs = 0;

  /** @type {ReturnType<typeof setInterval> | null} */
  _watchdogTimer = null;

  /** @type {Promise<void>} */
  _rxQueue = Promise.resolve();

  /** Pending outgoing resource payloads keyed by hex hash (RESOURCE_ADV/REQ). */
  pendingResources = new Map();

  /**
   * Initiator-side pending REQUESTs keyed by hex(request_id)
   * (PROTOCOL-SPEC.md §11.5). Each entry resolves/rejects its returned Promise
   * when the matching RESPONSE arrives or the timeout fires.
   * @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>}
   */
  pendingRequests = new Map();

  /**
   * Outgoing Resources (this side is the sender) keyed by hex(resource.hash)
   * — PROTOCOL-SPEC.md §10. Driven by `Resource.advertise` and fulfilled by
   * inbound RESOURCE_REQ / RESOURCE_PRF / RESOURCE_RCL.
   * @type {Map<string, import("../core/resource.js").Resource>}
   */
  outgoingResources = new Map();

  /**
   * Incoming Resources (this side is the receiver) keyed by hex(resource.hash).
   * Populated from RESOURCE_ADV; parts are routed by map_hash matching.
   * @type {Map<string, import("../core/resource.js").Resource>}
   */
  incomingResources = new Map();

  /**
   * Injected bz2 module (PROTOCOL-SPEC.md §10.2 step 2). The library never
   * imports a compression dependency; the application assigns this if it wants
   * Resource compression. When unset, compressed advertisements cannot be
   * decompressed locally and sender-side compression is skipped.
   * @type {import("../core/resource.js").Bzip2 | undefined}
   */
  bz2 = undefined;

  /**
   * Cap on advertised Resource size accepted inbound (§10.4 bomb defense).
   * Applications may lower this; `null` keeps the {@link Resource} default.
   * @type {number | undefined}
   */
  maxResourceSize = undefined;

  /**
   * Low-level constructor. Prefer the `Link.initiate` / `Link.accept` factories.
   *
   * @param {object} opts
   * @param {import("../core/destination.js").Destination} opts.destination
   * @param {Uint8Array} opts.linkId
   * @param {import("../transport/transport.js").TransportCore} opts.transport
   * @param {boolean} opts.initiator
   * @param {CryptoKey} opts.ephemeralX25519Priv - This side's ephemeral X25519 private key.
   * @param {Uint8Array} [opts.ephemeralX25519Pub] - This side's ephemeral X25519 public key (raw 32 bytes).
   * @param {CryptoKey} [opts.ephemeralEd25519Priv] - Initiator's fresh ephemeral Ed25519 private key (link-proof signing).
   * @param {Uint8Array} [opts.peerX25519Pub] - Peer's ephemeral X25519 public key (raw 32 bytes).
   * @param {Uint8Array} [opts.peerEd25519Pub] - Peer's ephemeral Ed25519 public key (raw 32 bytes).
   *   Responder-only: the initiator's link-proof signing pub, captured from the
   *   LINKREQUEST body so the responder can verify initiator-signed link proofs (§6.5).
   * @param {number} [opts.mtu]
   * @param {number} [opts.mode]
   */
  constructor(opts) {
    super();
    this.destination = opts.destination;
    this.linkId = opts.linkId;
    this.transport = opts.transport;
    this.initiator = opts.initiator;
    this.ephemeralX25519Priv = opts.ephemeralX25519Priv;
    this.ephemeralX25519Pub = opts.ephemeralX25519Pub;
    this.ephemeralEd25519Priv = opts.ephemeralEd25519Priv ?? null;
    this.peerX25519Pub = opts.peerX25519Pub ?? null;
    this.peerEd25519Pub = opts.peerEd25519Pub ?? null;
    if (opts.mtu !== undefined) this.mtu = opts.mtu;
    if (opts.mode !== undefined) this.mode = opts.mode;
    this.lastInboundTime = Date.now();
    this._status = LinkStatus.PENDING;
    /** Cached verify-only CryptoKey imported from {@link peerEd25519Pub} (responder). */
    this._peerEd25519Key = null;
    /** Outbound CTX_NONE DATA packet hashes (hex → bytes) awaiting a link PROOF (§6.5). */
    this._pendingLinkProofs = new Map();
  }

  /**
   * The current link status.
   * @returns {LinkStatus}
   */
  get status() {
    return this._status;
  }

  /**
   * Maximum plaintext bytes that fit in a single link DATA packet after
   * Token encryption and the HEADER_1 framing are applied
   * (PROTOCOL-SPEC.md §11.1, §5.2).
   *
   * The on-wire form of a link DATA packet is:
   *
   * ```
   * flags(1) hops(1) dest_hash(16) context(1)   iv(16) aes_ct hmac(32)
   * \---------------------- 19 ----------------/  \------ 48 ------/
   * ```
   *
   * PKCS#7 padding always adds 1–16 bytes (a full block when the plaintext is
   * itself a block multiple), so the largest plaintext `P` whose ciphertext
   * fits the remaining budget is the largest block-multiple ciphertext ≤
   * `(mtu − 67)` minus one byte. At the default `mtu = 500` this yields the
   * spec-pinned `MDU = 431` (wire packet 499 B, verified against RNS).
   *
   * @returns {number}
   */
  get mdu() {
    const HEADER1_SIZE = 19; // flags + hops + dest_hash + context
    const TOKEN_OVERHEAD = 48; // iv(16) + hmac(32), link-derived key form
    const AES_BLOCK = 16;
    const ciphertextBudget = this.mtu - HEADER1_SIZE - TOKEN_OVERHEAD;
    return Math.max(
      0,
      Math.floor(ciphertextBudget / AES_BLOCK) * AES_BLOCK - 1,
    );
  }

  /**
   * Transitions the link to a new status, emitting `statuschange`.
   * @param {LinkStatus} newStatus
   */
  set status(newStatus) {
    const reason =
      newStatus === LinkStatus.CLOSED
        ? ` (${getEnumName(LinkTeardownReason, this.teardownReason)})`
        : "";
    log(
      "Link",
      `Link ${toHex(this.linkId)} status is now ${getEnumName(LinkStatus, newStatus)}${reason}`,
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
      if (newStatus === LinkStatus.ACTIVE) {
        this._startWatchdog();
      } else if (newStatus === LinkStatus.CLOSED) {
        this._stopWatchdog();
        if (this.transport) this.transport.removeLink(this.linkId);
        // §11.5: fail any in-flight REQUESTs so their Promises don't dangle.
        this._rejectPendingRequests("Link closed before RESPONSE arrived");
      }
    }
  }

  /**
   * Resolves once the Link reaches ACTIVE status (immediately if it already
   * is). Callers that obtain a Link reference before the handshake finishes —
   * e.g. right after `Destination.createLink()` resolves — should `await`
   * this before sending application data, since the session token is only
   * derived once the handshake completes.
   *
   * Mirrors the gating the Python LXMF router applies in `process_outbound`
   * before sending DIRECT messages.
   *
   * @param {number} [timeoutMs=15000] - How long to wait for the handshake.
   * @returns {Promise<Link>}
   */
  async whenActive(timeoutMs = 15000) {
    if (this._status === LinkStatus.ACTIVE) {
      return this;
    }
    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const onStatusChange = (/** @type {any} */ event) => {
        if (event.detail.status === LinkStatus.ACTIVE) {
          clearTimeout(timer);
          this.removeEventListener("statuschange", onStatusChange);
          resolve(this);
        } else if (event.detail.status === LinkStatus.CLOSED) {
          clearTimeout(timer);
          this.removeEventListener("statuschange", onStatusChange);
          reject(new Error("Link closed before it became active"));
        }
      };
      timer = setTimeout(() => {
        this.removeEventListener("statuschange", onStatusChange);
        reject(new Error("Link did not become active before timeout"));
      }, timeoutMs);
      this.addEventListener("statuschange", onStatusChange);
    });
  }

  // -----------------------------------------------------------------------
  // Factories
  // -----------------------------------------------------------------------

  /**
   * Initiator side: establish a new link to `destination`.
   *
   * Generates fresh ephemeral X25519 + Ed25519 keypairs, builds and sends the
   * LINKREQUEST (dest_type=SINGLE, addressed to the responder's destination
   * hash), derives the link_id from the serialized packet, registers the link
   * with the transport, and transitions to HANDSHAKE. The link becomes ACTIVE
   * once the responder's LRPROOF is validated (`RNS/Link.py:283-328`).
   *
   * @param {import("../core/destination.js").Destination} destination - OUT destination whose identity is the responder's.
   * @param {import("../transport/transport.js").TransportCore} transport
   * @returns {Promise<Link>}
   */
  static async initiate(destination, transport) {
    const ephemeralX25519 = await generateX25519KeyPair();
    const ephemeralEd25519 = await generateEd25519KeyPair();
    const x25519Pub = await exportPublicKey(ephemeralX25519.publicKey);
    const ed25519Pub = await exportPublicKey(ephemeralEd25519.publicKey);

    const signalling = Link.signallingBytes(
      Link.DEFAULT_MTU,
      Link.MODE_AES256_CBC,
    );

    // LINKREQUEST body: initiator_X25519(32) || initiator_Ed25519(32) || signalling(3)
    const body = new Uint8Array(Link.ECPUBSIZE + Link.LINK_MTU_SIZE);
    body.set(x25519Pub, 0);
    body.set(ed25519Pub, 32);
    body.set(signalling, Link.ECPUBSIZE);

    const packet = new Packet({
      headerType: HeaderType.HEADER_1,
      hops: 0,
      transportType: 0,
      destinationType: DestType.SINGLE,
      packetType: PacketType.LINKREQUEST,
      destinationHash: /** @type {Uint8Array} */ (destination.destinationHash),
      contextByte: ContextType.NONE,
      payload: body,
    });
    packet.raw = packet.serialize();
    const linkId = await linkIdFromLrPacket(packet);

    const link = new Link({
      destination,
      linkId,
      transport,
      initiator: true,
      ephemeralX25519Priv: ephemeralX25519.privateKey,
      ephemeralX25519Pub: x25519Pub,
      ephemeralEd25519Priv: ephemeralEd25519.privateKey,
      mtu: Link.DEFAULT_MTU,
      mode: Link.MODE_AES256_CBC,
    });
    transport.addLink(linkId, link);
    link.requestTimeMs = Date.now();
    link.status = LinkStatus.HANDSHAKE;
    await link._sendRaw(packet);
    return link;
  }

  /**
   * Responder side: accept an incoming LINKREQUEST and complete the handshake
   * up to LRPROOF.
   *
   * Derives the link_id, extracts the initiator's ephemeral keys, derives the
   * session keys, builds and sends the LRPROOF signed with the destination's
   * long-term identity key, registers the link with the transport, and
   * transitions to HANDSHAKE. The link becomes ACTIVE once the initiator's
   * LRRTT arrives (`RNS/Link.py:186-200, 353-394`).
   *
   * @param {import("../core/destination.js").Destination} destination - IN destination whose identity is this node's.
   * @param {import("../transport/transport.js").TransportCore} transport
   * @param {Packet} requestPacket - The incoming LINKREQUEST (with `raw` populated).
   * @returns {Promise<Link>}
   */
  static async accept(destination, transport, requestPacket) {
    const linkId = await linkIdFromLrPacket(requestPacket);
    const data = requestPacket.payload;

    const initiatorX25519Pub = data.subarray(0, 32);
    // §6.5: the initiator's ephemeral Ed25519 pub (data[32:64]) signs the link
    // DATA proofs the initiator emits, so the responder needs it to verify them.
    // Copy (.slice) so the key bytes own an ArrayBuffer (crypto.subtle.importKey
    // rejects a SharedArrayBuffer-capable view).
    const initiatorEd25519Pub = data.slice(32, 64);
    let mtu = Link.DEFAULT_MTU;
    let mode = Link.MODE_AES256_CBC;
    if (data.length === Link.ECPUBSIZE + Link.LINK_MTU_SIZE) {
      const signalling = data.subarray(Link.ECPUBSIZE);
      mode = (signalling[0] & 0xe0) >> 5;
      mtu =
        (((signalling[0] << 16) + (signalling[1] << 8) + signalling[2]) &
          0x1fffff) >>>
        0;
    }

    const ephemeral = await generateX25519KeyPair();
    const responderX25519Pub = await exportPublicKey(ephemeral.publicKey);

    const link = new Link({
      destination,
      linkId,
      transport,
      initiator: false,
      ephemeralX25519Priv: ephemeral.privateKey,
      ephemeralX25519Pub: responderX25519Pub,
      peerX25519Pub: initiatorX25519Pub,
      peerEd25519Pub: initiatorEd25519Pub,
      mtu,
      mode,
    });
    await link._deriveKeys(initiatorX25519Pub);
    link.requestTimeMs = Date.now();
    link.status = LinkStatus.HANDSHAKE;
    transport.addLink(linkId, link);

    await link._sendLRProof();
    return link;
  }

  // -----------------------------------------------------------------------
  // Signalling helpers (RNS/Link.py:148-152)
  // -----------------------------------------------------------------------

  /**
   * Packs the 3-byte MTU/mode signalling trailer.
   * @param {number} mtu
   * @param {number} mode
   * @returns {Uint8Array}
   */
  static signallingBytes(mtu, mode) {
    const MTU_BYTEMASK = 0x1fffff;
    const MODE_BYTEMASK = 0xe0;
    const signallingValue =
      (mtu & MTU_BYTEMASK) + (((mode << 5) & MODE_BYTEMASK) << 16);
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setUint32(0, signallingValue, false); // big-endian
    return new Uint8Array(buffer).subarray(1); // drop top byte -> 3 bytes
  }

  // -----------------------------------------------------------------------
  // Session key derivation (LINKS.md §6.4.1)
  // -----------------------------------------------------------------------

  /**
   * Derives the link session keys from the peer's ephemeral X25519 public key.
   *
   *   shared       = X25519(my_ephemeral_priv, peer_ephemeral_pub)
   *   session_key  = HKDF(shared, salt=link_id, info="", L=64)
   *
   * @param {Uint8Array} peerX25519PubBytes
   * @returns {Promise<void>}
   * @private
   */
  async _deriveKeys(peerX25519PubBytes) {
    log("Link", "Deriving session keys");
    const peerPub = await crypto.subtle.importKey(
      "raw",
      /** @type {any} */ (peerX25519PubBytes),
      { name: "X25519" },
      true,
      [],
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "X25519", public: peerPub },
      this.ephemeralX25519Priv,
      256,
    );
    this.derivedKey = await hkdf(
      new Uint8Array(sharedBits),
      this.linkId,
      new Uint8Array(0),
      64,
    );
    this.token = new Token(this.derivedKey);
  }

  // -----------------------------------------------------------------------
  // Sending
  // -----------------------------------------------------------------------

  /**
   * Builds the wire-ready outbound packet for a logical link packet: re-addresses
   * it to `link_id`, Token-encrypts the payload unless it's in the
   * not-encrypted set (§6.7.1), and populates `raw` so the packet hash is
   * computable before transmission.
   *
   * Factored out of {@link send} so the REQUEST path can derive `request_id`
   * from the encrypted packet bytes and register its pending entry BEFORE the
   * packet goes on the wire (avoiding a lost-response race).
   *
   * @param {Packet} packet
   * @returns {Promise<Packet>}
   * @private
   */
  async _prepareOutboundPacket(packet) {
    if (!this.transport) throw new Error("Link transport not available.");

    const unencryptedOnLink = isLinkPacketUnencrypted(
      packet.packetType,
      packet.contextByte,
    );
    const isHandshake =
      packet.packetType === PacketType.LINKREQUEST ||
      (packet.packetType === PacketType.PROOF &&
        packet.contextByte === ContextType.LRPROOF);

    let payload = packet.payload;
    if (!isHandshake && !unencryptedOnLink) {
      if (!this.token)
        throw new Error("Link token not available. Did handshake complete?");
      log(
        "Link",
        `Encrypting ${getEnumName(PacketType, packet.packetType)} (ctx ${getEnumName(ContextType, packet.contextByte)})`,
      );
      payload = await this.token.encrypt(
        /** @type {Uint8Array} */ (packet.payload),
      );
    }

    const outbound = new Packet({
      headerType: packet.headerType ?? HeaderType.HEADER_1,
      hops: packet.hops ?? 0,
      transportType: packet.transportType ?? 0,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      packetType: packet.packetType,
      contextFlag: packet.contextFlag ?? false,
      contextByte: packet.contextByte ?? ContextType.NONE,
      payload,
      transportId: packet.transportId,
    });
    outbound.raw = outbound.serialize();
    return outbound;
  }

  /**
   * Sends a packet on the link. The packet is re-addressed to `link_id` and
   * Token-encrypted unless it is in the not-encrypted set (§6.7.1). Returns the
   * wire-ready outbound packet.
   *
   * @param {Packet} packet
   * @returns {Promise<Packet>}
   */
  async send(packet) {
    const outbound = await this._prepareOutboundPacket(packet);
    // §6.5: track CTX_NONE DATA BEFORE sending so a proof that returns
    // immediately (loopback / synchronous mock transports) can resolve it —
    // computing the hash here also populates outbound.raw.
    if (
      outbound.packetType === PacketType.DATA &&
      outbound.contextByte === ContextType.NONE
    ) {
      const hash = await outbound.getHash();
      this._pendingLinkProofs.set(toHex(hash), hash);
    }

    await this.transport.sendPacket(outbound);
    return outbound;
  }

  /**
   * Sends an already-built packet without re-addressing/encrypting. Used for
   * the LINKREQUEST (addressed to the responder's destination hash, not link_id).
   * @param {Packet} packet
   * @private
   */
  async _sendRaw(packet) {
    await this.transport.sendPacket(packet);
  }

  // -----------------------------------------------------------------------
  // LRPROOF (responder → initiator), LINKS.md §6.2
  // -----------------------------------------------------------------------

  /**
   * Responder: builds and sends the LRPROOF.
   *
   *   signed_data = link_id || responder_X25519 || responder_Ed25519 || signalling
   *   proof_data  = signature(64) || responder_X25519(32) || signalling(3)
   *
   * Signed with the destination's long-term identity key.
   * @private
   */
  async _sendLRProof() {
    if (!this.destination?.identity) {
      throw new Error("Responder LRPROOF requires a destination identity.");
    }
    if (!this.ephemeralX25519Pub) {
      throw new Error(
        "Responder LRPROOF requires an ephemeral X25519 public key.",
      );
    }
    const signalling = Link.signallingBytes(this.mtu, this.mode);
    const responderX25519Pub = this.ephemeralX25519Pub;
    const responderEd25519Pub = (
      await this.destination.identity.getPublicKey()
    ).subarray(32, 64);

    const signedData = new Uint8Array(
      this.linkId.length +
        responderX25519Pub.length +
        responderEd25519Pub.length +
        signalling.length,
    );
    signedData.set(this.linkId, 0);
    signedData.set(responderX25519Pub, this.linkId.length);
    signedData.set(
      responderEd25519Pub,
      this.linkId.length + responderX25519Pub.length,
    );
    signedData.set(
      signalling,
      this.linkId.length +
        responderX25519Pub.length +
        responderEd25519Pub.length,
    );

    const signature = await this.destination.identity.sign(signedData);

    const proofPayload = new Uint8Array(
      signature.length + responderX25519Pub.length + signalling.length,
    );
    proofPayload.set(signature, 0);
    proofPayload.set(responderX25519Pub, signature.length);
    proofPayload.set(signalling, signature.length + responderX25519Pub.length);

    const proofPacket = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LRPROOF,
      payload: proofPayload,
    });
    // LRPROOF rides the wire unencrypted, addressed to link_id.
    await this.transport.sendPacket(proofPacket);
  }

  // -----------------------------------------------------------------------
  // LRPROOF validation (initiator side), LINKS.md §6.2
  // -----------------------------------------------------------------------

  /**
   * Initiator: validate the responder's LRPROOF, derive session keys, send
   * LRRTT, and transition to ACTIVE (`RNS/Link.py:401-442`).
   * @param {Packet} packet
   * @private
   */
  async _handleLRPROOF(packet) {
    if (!this.destination?.identity) {
      throw new Error(
        "Initiator LRPROOF validation requires the responder identity.",
      );
    }
    const data = packet.payload;

    /** @type {Uint8Array} */
    let signalling = new Uint8Array(0);
    let confirmedMtu = this.mtu;
    if (data.length === 64 + 32 + Link.LINK_MTU_SIZE) {
      signalling = data.subarray(64 + 32);
      confirmedMtu =
        (((signalling[0] << 16) + (signalling[1] << 8) + signalling[2]) &
          0x1fffff) >>>
        0;
      const mode = (signalling[0] & 0xe0) >> 5;
      if (mode !== this.mode) {
        throw new TypeError(
          `Invalid link mode ${mode} in LRPROOF (expected ${this.mode})`,
        );
      }
    } else if (data.length !== 64 + 32) {
      throw new Error(`Invalid LRPROOF body length ${data.length}`);
    }

    const signature = data.subarray(0, 64);
    const responderX25519Pub = data.subarray(64, 96);

    // signed_data = link_id || responder_X25519 || responder_Ed25519 || [signalling]
    // The responder's long-term Ed25519 pub is known from the prior announce
    // (destination.identity). RNS/Link.py:417.
    const responderEd25519Pub = (
      await this.destination.identity.getPublicKey()
    ).subarray(32, 64);

    const signedData = new Uint8Array(
      this.linkId.length +
        responderX25519Pub.length +
        responderEd25519Pub.length +
        signalling.length,
    );
    signedData.set(this.linkId, 0);
    signedData.set(responderX25519Pub, this.linkId.length);
    signedData.set(
      responderEd25519Pub,
      this.linkId.length + responderX25519Pub.length,
    );
    signedData.set(
      signalling,
      this.linkId.length +
        responderX25519Pub.length +
        responderEd25519Pub.length,
    );

    const valid = await this.destination.identity.validate(
      signature,
      signedData,
    );
    if (!valid) {
      throw new Error("LRPROOF signature verification failed.");
    }

    this.peerX25519Pub = responderX25519Pub;
    await this._deriveKeys(responderX25519Pub);
    this.mtu = confirmedMtu;
    this.rtt = (Date.now() - this.requestTimeMs) / 1000;
    this._updateKeepalive();

    await this._sendLRRTT();

    this.status = LinkStatus.ACTIVE;
    this.dispatchEvent(
      new CustomEvent("established", { detail: { link: this.linkId } }),
    );
  }

  // -----------------------------------------------------------------------
  // LRRTT (initiator → responder), LINKS.md §6.4.2
  // -----------------------------------------------------------------------

  /**
   * Initiator: send the RTT packet. Body is `umsgpack.packb(rtt_seconds)` (a
   * 9-byte msgpack float64), Token-encrypted with the link session key.
   * @private
   */
  async _sendLRRTT() {
    const body = MicroMsgPack.encode(this.rtt);
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LRRTT,
      payload: body,
    });
    await this.send(packet);
  }

  /**
   * Responder: process the initiator's LRRTT, settle RTT, transition to ACTIVE
   * (`RNS/Link.py:534-553`). This is the only path that fires `established` on
   * the responder side.
   * @param {Packet} packet
   * @private
   */
  async _handleLRRTT(packet) {
    // packet.payload is already decrypted by _processPacket.
    const reportedRtt = MicroMsgPack.decode(
      /** @type {Uint8Array} */ (packet.payload),
    );
    const measuredRtt = (Date.now() - this.requestTimeMs) / 1000;
    this.rtt = Math.max(measuredRtt, reportedRtt);
    this._updateKeepalive();

    this.status = LinkStatus.ACTIVE;
    this.dispatchEvent(
      new CustomEvent("established", { detail: { link: this.linkId } }),
    );
  }

  // -----------------------------------------------------------------------
  // Regular link DATA proofs (LINKS.md §6.5)
  // -----------------------------------------------------------------------

  /**
   * Returns the Ed25519 private key used to sign link DATA proofs.
   * Responder signs with its long-term identity key; initiator signs with its
   * fresh ephemeral Ed25519 key (LINKS.md §6.5.1).
   * @returns {Promise<CryptoKey>}
   * @private
   */
  async _linkSigningKey() {
    if (this.initiator) {
      if (!this.ephemeralEd25519Priv) {
        throw new Error("Initiator link has no ephemeral Ed25519 signing key.");
      }
      return this.ephemeralEd25519Priv;
    }
    if (!this.destination?.identity?.ed25519Priv) {
      throw new Error("Responder link has no identity signing key.");
    }
    return this.destination.identity.ed25519Priv;
  }

  /**
   * Emits the 96-byte explicit-form PROOF for a DATA packet we just received.
   *   proof_data = packet_hash(32) || signature(64)
   * Addressed to link_id, unencrypted. Always explicit on links (§6.5.2).
   * @param {Packet} packet
   * @private
   */
  async _provePacket(packet) {
    const packetHash = await packet.getHash();
    const signingKey = await this._linkSigningKey();
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        signingKey,
        /** @type {any} */ (packetHash),
      ),
    );

    const proofPayload = new Uint8Array(96);
    proofPayload.set(packetHash, 0);
    proofPayload.set(signature, 32);

    const proofPacket = new Packet({
      packetType: PacketType.PROOF,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.NONE,
      payload: proofPayload,
    });
    // Link PROOFs are unencrypted (RNS/Packet.py:200-201).
    await this.transport.sendPacket(proofPacket);
  }

  /**
   * Validates an inbound link DATA proof (§6.5) and resolves the matching
   * outbound packet.
   *
   * Link proofs are **always explicit** (96 B: `packet_hash(32) ||
   * signature(64)`), addressed to `link_id`, `context = NONE`. The signature is
   * verified with the peer's link-proof signing public key — the responder's
   * long-term identity key (initiator side) or the initiator's ephemeral
   * Ed25519 pub (responder side). On success the tracked packet is cleared and
   * a `proof` event dispatched; bad signatures / lengths are dropped.
   *
   * @param {import("../core/packet.js").Packet} packet
   * @private
   */
  async _handleLinkProof(packet) {
    if (packet.payload.length !== 96) {
      log(
        "Link",
        `Dropping link proof with bad length ${packet.payload.length} (expected 96)`,
        LogLevel.DEBUG,
      );
      return;
    }
    const packetHash = packet.payload.slice(0, 32);
    const signature = packet.payload.slice(32, 96);
    const hashHex = toHex(packetHash);

    const verified = await this._verifyLinkProof(signature, packetHash);
    if (!verified) {
      log("Link", `Link proof signature invalid for ${hashHex}`, LogLevel.WARN);
      return;
    }

    const wasPending = this._pendingLinkProofs.delete(hashHex);
    log(
      "Link",
      `Link proof validated for ${hashHex}${wasPending ? " — receipt resolved" : " (no tracked packet)"}`,
      LogLevel.DEBUG,
    );
    this.dispatchEvent(
      new CustomEvent("proof", {
        detail: { packetHash, verified: true, packet },
      }),
    );
  }

  /**
   * Verifies a link-proof Ed25519 signature over `packetHash` using the peer's
   * signing public key.
   *
   * - Initiator verifies with the responder's long-term identity key
   *   (`destination.identity`), which signed the proof.
   * - Responder verifies with the initiator's ephemeral Ed25519 pub, captured
   *   from the LINKREQUEST body (§6.5: "the link's ephemeral Ed25519 keypair
   *   on the initiator side").
   *
   * @param {Uint8Array} signature
   * @param {Uint8Array} packetHash
   * @returns {Promise<boolean>}
   * @private
   */
  async _verifyLinkProof(signature, packetHash) {
    if (this.initiator) {
      const identity = this.destination?.identity;
      if (!identity) return false;
      return identity.validate(signature, packetHash);
    }
    if (!this.peerEd25519Pub) return false;
    if (!this._peerEd25519Key) {
      this._peerEd25519Key = await crypto.subtle.importKey(
        "raw",
        /** @type {any} */ (this.peerEd25519Pub),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
    }
    return await crypto.subtle.verify(
      "Ed25519",
      this._peerEd25519Key,
      /** @type {any} */ (signature),
      /** @type {any} */ (packetHash),
    );
  }

  // -----------------------------------------------------------------------
  // KEEPALIVE (LINKS.md §6.7.1)
  // -----------------------------------------------------------------------

  /**
   * Sends a KEEPALIVE packet. Ping body is 0xFF, pong is 0xFE. KEEPALIVE bodies
   * are NOT Token-encrypted (§6.7.1).
   * @param {boolean} isPing
   * @private
   */
  async _sendKeepalive(isPing) {
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.KEEPALIVE,
      payload: new Uint8Array([isPing ? 0xff : 0xfe]),
    });
    // KEEPALIVE is unencrypted — bypass Link.send's token requirement.
    await this.transport.sendPacket(packet);
  }

  // -----------------------------------------------------------------------
  // Teardown (LINKS.md §6.7.3)
  // -----------------------------------------------------------------------

  /**
   * Cleanly tears down the link by sending a LINKCLOSE whose encrypted body is
   * the link_id, then transitioning to CLOSED locally.
   */
  async teardown() {
    if (this.status === LinkStatus.CLOSED) return;
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LINKCLOSE,
      payload: this.linkId,
    });
    await this.send(packet);
    this.teardownReason = this.initiator
      ? LinkTeardownReason.INITIATOR_CLOSED
      : LinkTeardownReason.DESTINATION_CLOSED;
    this.status = LinkStatus.CLOSED;
    this.dispatchEvent(
      new CustomEvent("close", { detail: { link: this.linkId } }),
    );
  }

  /**
   * Receiver side of LINKCLOSE: decrypt, verify body equals link_id, close.
   * @param {Packet} packet
   * @private
   */
  async _handleLinkClose(packet) {
    // packet.payload is already decrypted by _processPacket; the sole auth
    // check is plaintext == link_id (RNS/Link.py:713).
    const plaintext = /** @type {Uint8Array} */ (packet.payload);
    if (plaintext.length !== this.linkId.length) return;
    let diff = 0;
    for (let i = 0; i < plaintext.length; i++)
      diff |= plaintext[i] ^ this.linkId[i];
    if (diff !== 0) return; // auth check failed; ignore
    this.teardownReason = this.initiator
      ? LinkTeardownReason.DESTINATION_CLOSED
      : LinkTeardownReason.INITIATOR_CLOSED;
    this.status = LinkStatus.CLOSED;
    this.dispatchEvent(
      new CustomEvent("close", { detail: { link: this.linkId } }),
    );
  }

  // -----------------------------------------------------------------------
  // LINKIDENTIFY (LINKS.md §6.7.6)
  // -----------------------------------------------------------------------

  /**
   * Initiator: prove which long-term identity owns this link to the responder.
   *
   * Must be called AFTER the link is ACTIVE and BEFORE sending any application
   * DATA. This is load-bearing for Python-LXMF interop: Python's LXMRouter does
   * not install its link-data listener until it has processed LINKIDENTIFY, so a
   * DATA/RESOURCE sent before LINKIDENTIFY is silently dropped on the Python
   * side. Wire body (link-encrypted):
   *
   *   public_key(64) || signature(64)
   *
   * where `signature = identity.sign(link_id || public_key)` (`RNS/Link.py:459-475`).
   *
   * @param {import("../core/identity.js").Identity} identity - The initiator's long-term identity.
   */
  async identify(identity) {
    if (!this.initiator || this.status !== LinkStatus.ACTIVE) {
      throw new Error(
        "identify() can only be called by an ACTIVE initiator link.",
      );
    }
    const publicKey = await identity.getPublicKey();
    const signedData = new Uint8Array(this.linkId.length + publicKey.length);
    signedData.set(this.linkId, 0);
    signedData.set(publicKey, this.linkId.length);
    const signature = await identity.sign(signedData);

    const payload = new Uint8Array(publicKey.length + signature.length);
    payload.set(publicKey, 0);
    payload.set(signature, publicKey.length);

    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.LINKIDENTIFY,
      payload,
    });
    await this.send(packet);
  }

  /**
   * Responder: verify an initiator's LINKIDENTIFY and record the remote identity.
   *
   * Body = public_key(64) || signature(64), where signature is over
   * `link_id || public_key`. The whole packet is link-encrypted.
   * @param {Packet} packet
   * @private
   */
  async _handleIdentify(packet) {
    const { Identity } = await import("../core/identity.js");
    // packet.payload is already decrypted by _processPacket.
    const plaintext = /** @type {Uint8Array} */ (packet.payload);
    if (plaintext.length !== 128) return;
    const publicKey = plaintext.subarray(0, 64);
    const signature = plaintext.subarray(64, 128);

    const signedData = new Uint8Array(this.linkId.length + publicKey.length);
    signedData.set(this.linkId, 0);
    signedData.set(publicKey, this.linkId.length);

    const peerIdentity = await Identity.fromPublicKey(publicKey);
    const valid = await peerIdentity.validate(signature, signedData);
    if (!valid) return;

    this.remoteIdentity = peerIdentity;
    this.dispatchEvent(
      new CustomEvent("identify", {
        detail: { identity: peerIdentity, link: this.linkId },
      }),
    );
  }

  // -----------------------------------------------------------------------
  // REQUEST / RESPONSE (PROTOCOL-SPEC.md §11)
  // -----------------------------------------------------------------------

  /**
   * Initiator: send a REQUEST over the link and await the RESPONSE
   * (PROTOCOL-SPEC.md §11.1, §11.5).
   *
   * Packs the msgpack envelope `[timestamp, path_hash, data]` (single pack —
   * `data` is encoded directly, NOT pre-msgpacked), dispatches by size, and
   * returns a Promise that resolves with the response value when the server's
   * matching RESPONSE arrives.
   *
   * For a single-packet REQUEST the `request_id` the server echoes back is
   * `SHA-256(packet.get_hashable_part())[:16]` — the truncated hash of the
   * *encrypted wire packet*, computed identically on both sides. It is NOT
   * random and NOT a hash of the plaintext envelope.
   *
   * @param {string} path - Opaque path token (e.g. `"/page/index.mu"`).
   * @param {any} [data=null] - Application value for envelope element [2]
   *   (`null` for plain GETs, an object for NomadNet form posts, an array for
   *   LXMF `/get` rounds, a `Uint8Array` for opaque blobs …). Passed to msgpack
   *   directly — do NOT pre-pack it.
   * @param {object} [options]
   * @param {number} [options.timeout] - Response timeout in ms (defaults to
   *   `rtt * TRAFFIC_TIMEOUT_FACTOR + RESPONSE_MAX_GRACE_TIME * 1.125`).
   * @returns {Promise<any>} The decoded RESPONSE value.
   */
  async request(path, data = null, options = {}) {
    if (this.status !== LinkStatus.ACTIVE) {
      throw new Error("Link must be ACTIVE to issue a REQUEST.");
    }
    const { Identity } = await import("../core/identity.js");

    const pathHash = await Identity.truncatedHash(
      new TextEncoder().encode(path),
    );
    const envelope = [Date.now() / 1000, pathHash, data];
    const packedRequest = MicroMsgPack.encode(envelope);

    if (packedRequest.length > this.mdu) {
      // §11.1: oversized requests must go through the §10 Resource transfer.
      // That pipeline isn't wired into the Link yet; fail loudly rather than
      // emitting a packet the peer can't decrypt/assemble.
      throw new Error(
        `Request payload ${packedRequest.length}B exceeds link MDU ${this.mdu}B; ` +
          "Resource-backed REQUEST path not yet implemented (§10/§11.1)",
      );
    }

    const reqPacket = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.REQUEST,
      payload: packedRequest,
    });
    const outbound = await this._prepareOutboundPacket(reqPacket);
    // §11.1: request_id is the truncated hash of the REQUEST packet's
    // hashable wire bytes (`(raw[0] & 0x0F) || raw[2:]` for HEADER_1). Computed
    // on the encrypted form because that's what the server receives & hashes.
    const requestId = await Identity.truncatedHash(outbound.getHashablePart());
    const requestIdHex = toHex(requestId);

    const timeout = options.timeout ?? this._defaultRequestTimeoutMs();

    const responsePromise = new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingRequests.delete(requestIdHex);
          reject(new Error(`REQUEST to ${path} timed out after ${timeout}ms`));
        }, timeout),
      };
      // Register BEFORE transmitting so a same-tick (loopback) response still
      // finds its entry, and so the entry exists before any await can yield.
      this.pendingRequests.set(requestIdHex, entry);
    });

    await this.transport.sendPacket(outbound);
    return responsePromise;
  }

  /**
   * Default REQUEST response timeout (PROTOCOL-SPEC.md §11.5):
   * `rtt * traffic_timeout_factor + RESPONSE_MAX_GRACE_TIME * 1.125`.
   * @returns {number} milliseconds.
   * @private
   */
  _defaultRequestTimeoutMs() {
    return (
      (this.rtt * Link.TRAFFIC_TIMEOUT_FACTOR +
        Link.RESPONSE_MAX_GRACE_TIME * Link.RESPONSE_GRACE_FACTOR) *
      1000
    );
  }

  /**
   * Responder: dispatch an inbound REQUEST to the registered handler and send
   * the RESPONSE (PROTOCOL-SPEC.md §11.2).
   *
   * `originalPacket` is the as-received (still-encrypted-raw) packet used to
   * compute the request_id; `decrypted` carries the decoded plaintext payload.
   *
   * @param {Packet} originalPacket
   * @param {Packet} decrypted
   * @private
   */
  async _handleRequest(originalPacket, decrypted) {
    const { Identity } = await import("../core/identity.js");
    const requestId = await Identity.truncatedHash(
      originalPacket.getHashablePart(),
    );

    let decoded;
    try {
      decoded = MicroMsgPack.decode(
        /** @type {Uint8Array} */ (decrypted.payload),
      );
    } catch (err) {
      log("Link", `Dropping malformed REQUEST: ${err}`, LogLevel.WARN);
      return;
    }
    if (!Array.isArray(decoded) || decoded.length < 3) {
      log("Link", `Dropping REQUEST with bad envelope shape`, LogLevel.WARN);
      return;
    }
    const [requestTime, pathHash, data] = decoded;
    if (!(pathHash instanceof Uint8Array) || pathHash.length !== 16) {
      log("Link", `Dropping REQUEST with bad path_hash`, LogLevel.WARN);
      return;
    }

    const handler = this.destination?.requestHandlers?.get(toHex(pathHash));
    if (!handler) {
      log(
        "Link",
        `No handler for REQUEST path hash ${toHex(pathHash)}`,
        LogLevel.DEBUG,
      );
      return;
    }
    if (!this._authorizeRequest(handler)) {
      log(
        "Link",
        `Rejecting REQUEST to ${handler.path} (allow mode ${handler.allow})`,
        LogLevel.DEBUG,
      );
      return;
    }

    let response;
    try {
      response = await handler.responseGenerator(
        handler.path,
        data,
        requestId,
        this.remoteIdentity ?? null,
        requestTime,
      );
    } catch (err) {
      log(
        "Link",
        `REQUEST handler for ${handler.path} threw: ${err}`,
        LogLevel.ERROR,
      );
      return;
    }
    // A generator returning null/undefined suppresses the response.
    if (response === null || response === undefined) return;

    await this._sendResponse(response, requestId, handler.autoCompress);
  }

  /**
   * Sends a RESPONSE packet (§11.2). Single-packet form only for now; oversized
   * responses require the §10 Resource path (advertisement flag `p`,
   * `is_response = True`).
   * @param {any} response
   * @param {Uint8Array} requestId
   * @param {boolean} autoCompress
   * @private
   */
  async _sendResponse(response, requestId, autoCompress) {
    const packed = MicroMsgPack.encode([requestId, response]);
    if (packed.length > this.mdu) {
      throw new Error(
        `RESPONSE ${packed.length}B exceeds link MDU ${this.mdu}B; ` +
          "Resource-backed RESPONSE path not yet implemented (§10/§11.2)",
      );
    }
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.linkId,
      contextByte: ContextType.RESPONSE,
      payload: packed,
    });
    void autoCompress; // honoured once the Resource response path lands.
    await this.send(packet);
  }

  /**
   * Initiator: correlate an inbound RESPONSE with a pending REQUEST (§11.2).
   *
   * Decodes the msgpack `[request_id, response]` envelope, verifies element [0]
   * matches a tracked outbound REQUEST, and resolves that request's Promise.
   * Mismatched / spurious responses are dropped — the security note in §11.2
   * makes the id check mandatory.
   * @param {Packet} decrypted
   * @private
   */
  async _handleResponse(decrypted) {
    let decoded;
    try {
      decoded = MicroMsgPack.decode(
        /** @type {Uint8Array} */ (decrypted.payload),
      );
    } catch (err) {
      log("Link", `Dropping malformed RESPONSE: ${err}`, LogLevel.WARN);
      return;
    }
    if (!Array.isArray(decoded) || decoded.length < 2) {
      log("Link", `Dropping RESPONSE with bad envelope shape`, LogLevel.WARN);
      return;
    }
    const [requestId, response] = decoded;
    if (!(requestId instanceof Uint8Array) || requestId.length !== 16) {
      log("Link", `Dropping RESPONSE with bad request_id`, LogLevel.WARN);
      return;
    }

    const entry = this.pendingRequests.get(toHex(requestId));
    if (!entry) {
      log(
        "Link",
        `RESPONSE for unknown REQUEST ${toHex(requestId)}; dropping`,
        LogLevel.DEBUG,
      );
      return;
    }
    clearTimeout(entry.timer);
    this.pendingRequests.delete(toHex(requestId));
    entry.resolve(response);
  }

  /**
   * Enforces a handler's `allow` mode against the link's remote identity (§11.4).
   *
   * Uses the raw `Allow` enum values from `Destination` (0x00/0x01/0x02) rather
   * than importing the enum, to avoid a link.js ↔ destination.js import cycle.
   *
   * @param {{allow: number, allowedList: Uint8Array[]}} handler
   * @returns {boolean}
   * @private
   */
  _authorizeRequest(handler) {
    const ALLOW_ALL = 0x01; // Destination.Allow.ALL
    const ALLOW_LIST = 0x02; // Destination.Allow.LIST
    if (handler.allow === ALLOW_ALL) return true;
    if (handler.allow === ALLOW_LIST) {
      const remoteHash = this.remoteIdentity?.identityHash;
      if (!remoteHash) return false;
      return handler.allowedList.some(
        (h) => h.length === remoteHash.length && bytesEqual(h, remoteHash),
      );
    }
    return false; // ALLOW_NONE (0x00) and any unknown mode.
  }

  /**
   * Rejects every pending REQUEST with `reason`. Called from the CLOSED status
   * transition so callers awaiting `link.request()` don't hang.
   * @param {string} reason
   * @private
   */
  _rejectPendingRequests(reason) {
    for (const [id, entry] of this.pendingRequests) {
      clearTimeout(entry.timer);
      this.pendingRequests.delete(id);
      entry.reject(new Error(reason));
    }
  }

  // -----------------------------------------------------------------------
  // Resources ( PROTOCOL-SPEC.md §10 )
  // -----------------------------------------------------------------------

  /**
   * Registers an outgoing Resource (sender side) keyed by hex(resource.hash).
   * @param {import("../core/resource.js").Resource} resource
   * @internal
   */
  _registerOutgoingResource(resource) {
    if (resource.hash) {
      this.outgoingResources.set(toHex(resource.hash), resource);
    }
  }

  /**
   * Registers an incoming Resource (receiver side) keyed by hex(resource.hash).
   * @param {import("../core/resource.js").Resource} resource
   * @internal
   */
  _registerIncomingResource(resource) {
    if (resource.hash) {
      this.incomingResources.set(toHex(resource.hash), resource);
    }
  }

  /**
   * Routes an inbound RESOURCE part to the incoming resource whose hashmap
   * claims it (§10.6). Parts carry no resource id, so matching is by map_hash.
   * @param {Uint8Array} chunk
   * @returns {Promise<void>}
   * @private
   */
  async _routeResourcePart(chunk) {
    for (const resource of this.incomingResources.values()) {
      const placed = await resource.receivePart(chunk);
      if (placed) return;
    }
    log(
      "Link",
      "RESOURCE part matched no incoming resource; dropping",
      LogLevel.DEBUG,
    );
  }

  /**
   * Extracts the 32-byte resource_hash from a RESOURCE_REQ body for routing.
   * Body shape (§10.5): `exhausted(1) ‖ [last_map_hash(4) if exhausted] ‖ resource_hash(32) ‖ …`.
   * @param {Uint8Array} body
   * @returns {Uint8Array}
   * @private
   */
  static _resourceHashFromRequest(body) {
    const offset = body[0] === 0xff ? 5 : 1;
    return body.subarray(offset, offset + 32);
  }

  // -----------------------------------------------------------------------
  // Inbound dispatch
  // -----------------------------------------------------------------------

  /**
   * Queues and processes an inbound packet addressed to this link.
   * @param {Packet} packet
   */
  async receive(packet) {
    this._rxQueue = this._rxQueue
      .then(() => this._processPacket(packet))
      .catch((err) => {
        log("Link", `Error processing packet: ${err}`, LogLevel.ERROR);
      });
    await this._rxQueue;
  }

  /**
   * Handles a single inbound packet after handshake completion: verifies
   * proofs, decrypts Token-encrypted packets, and dispatches by context.
   * @param {Packet} packet
   * @private
   */
  async _processPacket(packet) {
    log(
      "Link",
      `Processing ${getEnumName(PacketType, packet.packetType)} packet (ctx ${getEnumName(ContextType, packet.contextByte)}) for link ${toHex(this.linkId)}`,
      LogLevel.DEBUG,
    );
    this.lastInboundTime = Date.now();

    // LRPROOF is processed before keys exist (it's the handshake step that
    // triggers key derivation on the initiator side).
    if (
      packet.packetType === PacketType.PROOF &&
      packet.contextByte === ContextType.LRPROOF
    ) {
      if (this.initiator) await this._handleLRPROOF(packet);
      return;
    }

    const unencrypted = isLinkPacketUnencrypted(
      packet.packetType,
      packet.contextByte,
    );
    let payload = packet.payload;
    if (!unencrypted) {
      if (!this.token) {
        throw new Error("Encrypted link packet received before handshake.");
      }
      payload = await this.token.decrypt(
        /** @type {Uint8Array} */ (packet.payload),
      );
    }

    const decrypted = new Packet({
      headerType: packet.headerType,
      hops: packet.hops,
      transportType: packet.transportType,
      destinationType: packet.destinationType,
      packetType: packet.packetType,
      contextFlag: packet.contextFlag,
      destinationHash: packet.destinationHash,
      contextByte: packet.contextByte,
      payload,
      transportId: packet.transportId,
      raw: packet.raw,
    });

    switch (decrypted.contextByte) {
      case ContextType.NONE:
        if (decrypted.packetType === PacketType.DATA) {
          // Emit the explicit-form PROOF receipt for this DATA packet.
          if (this.transport) await this._provePacket(packet);
          this.dispatchEvent(
            new CustomEvent("data", {
              detail: { packet: decrypted, link: this.linkId },
            }),
          );
        } else if (decrypted.packetType === PacketType.PROOF) {
          await this._handleLinkProof(decrypted);
        }
        break;

      case ContextType.RESOURCE_REQ: {
        // §10.5: receiver → sender. Route to the outgoing resource by hash.
        const reqHash = Link._resourceHashFromRequest(decrypted.payload);
        const outgoing = this.outgoingResources.get(toHex(reqHash));
        if (outgoing) {
          await outgoing.handleRequest(decrypted.payload);
        } else {
          log(
            "Link",
            "RESOURCE_REQ for unknown resource; dropping",
            LogLevel.DEBUG,
          );
        }
        break;
      }

      case ContextType.RESOURCE:
        // §10.6: a raw encrypted slice — route by map_hash matching.
        await this._routeResourcePart(decrypted.payload);
        break;

      case ContextType.RESOURCE_ADV: {
        // §10.4: receiver accepts an incoming transfer and starts requesting.
        const { Resource } = await import("../core/resource.js");
        const incoming = await Resource.accept(this, decrypted, {
          bz2: this.bz2,
          maxSize: this.maxResourceSize,
        });
        if (incoming) {
          this.dispatchEvent(
            new CustomEvent("resource", {
              detail: { packet: decrypted, resource: incoming },
            }),
          );
          await incoming.requestNext();
        }
        break;
      }

      case ContextType.RESOURCE_HMU: {
        // §10.7: hashmap continuation for the receiver.
        const hmuHash = decrypted.payload.subarray(0, 32);
        const incomingHmu = this.incomingResources.get(toHex(hmuHash));
        if (incomingHmu) await incomingHmu.hashmapUpdate(decrypted.payload);
        break;
      }

      case ContextType.RESOURCE_PRF: {
        // §10.8: receiver → sender proof. Route by resource_hash = body[0:32].
        const prfHash = decrypted.payload.subarray(0, 32);
        const outgoingPrf = this.outgoingResources.get(toHex(prfHash));
        if (outgoingPrf) {
          await outgoingPrf.validateProof(decrypted.payload);
        }
        break;
      }

      case ContextType.RESOURCE_ICL: {
        // §10.9: initiator cancel → cancel the matching incoming resource.
        const iclHash = decrypted.payload.subarray(0, 32);
        const incomingIcl = this.incomingResources.get(toHex(iclHash));
        if (incomingIcl) await incomingIcl.handleIncomingCancel();
        break;
      }

      case ContextType.RESOURCE_RCL: {
        // §10.9: receiver reject → mark the matching outgoing resource rejected.
        const rclHash = decrypted.payload.subarray(0, 32);
        const outgoingRcl = this.outgoingResources.get(toHex(rclHash));
        if (outgoingRcl) await outgoingRcl.handleRejection();
        break;
      }

      case ContextType.KEEPALIVE:
        // Responder answers a 0xFF ping with a 0xFE pong.
        if (
          !this.initiator &&
          decrypted.payload.length === 1 &&
          decrypted.payload[0] === 0xff
        ) {
          await this._sendKeepalive(false);
        }
        this.dispatchEvent(
          new CustomEvent("keepalive", { detail: { packet: decrypted } }),
        );
        break;

      case ContextType.LRRTT:
        if (!this.initiator) await this._handleLRRTT(decrypted);
        break;

      case ContextType.REQUEST:
        // Server side: dispatch to the responder destination's handlers.
        // request_id is derived from the ORIGINAL (encrypted-raw) packet.
        await this._handleRequest(packet, decrypted);
        break;

      case ContextType.RESPONSE:
        // Initiator side: correlate with a pending REQUEST.
        await this._handleResponse(decrypted);
        break;

      case ContextType.LINKCLOSE:
        await this._handleLinkClose(decrypted);
        break;

      case ContextType.LINKIDENTIFY:
        await this._handleIdentify(decrypted);
        break;

      default:
        log(
          "Link",
          `Ignored packet with unknown context: 0x${decrypted.contextByte.toString(16)}`,
          LogLevel.WARN,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Watchdog (LINKS.md §6.7)
  // -----------------------------------------------------------------------

  /**
   * Starts the 1-second watchdog timer that monitors link liveness.
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
   * Periodic watchdog tick: tears down stale links and sends initiator keepalives.
   * @private
   */
  _watchdogJob() {
    log("Link", `Watchdog tick for ${toHex(this.linkId)}`, LogLevel.EXTREME);
    const now = Date.now();
    if (now >= this.lastInboundTime + this.staleTime * 1000) {
      this.teardownReason = LinkTeardownReason.TIMEOUT;
      this.status = LinkStatus.CLOSED;
      this.dispatchEvent(
        new CustomEvent("close", { detail: { link: this.linkId } }),
      );
      return;
    }
    if (
      this.initiator &&
      now >= this.lastInboundTime + this.keepaliveInterval * 1000
    ) {
      this._sendKeepalive(true).catch((e) =>
        log("Link", `Keepalive failed: ${e}`, LogLevel.ERROR),
      );
      this.lastInboundTime = now;
    }
  }

  /**
   * Recomputes the keepalive and stale intervals from the measured RTT.
   * @private
   */
  _updateKeepalive() {
    const interval = this.rtt * (Link.KEEPALIVE_MAX / Link.KEEPALIVE_MAX_RTT);
    this.keepaliveInterval = Math.max(
      Math.min(interval, Link.KEEPALIVE_MAX),
      Link.KEEPALIVE_MIN,
    );
    this.staleTime = this.keepaliveInterval * Link.STALE_FACTOR;
  }
}
