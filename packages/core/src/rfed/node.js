/**
 * @file node.js
 * @description rfed federation node (work doc #25, Phase 2).
 *
 * Brings up the modern split rfed destinations on a Reticulum instance and
 * implements the core ingest/serve loop:
 *
 *   - `rfed.channel.subscribe`   `/rfed/subscribe`   signed `[ch,pub,sig]` → `[ok, stamp_cost|nil]`
 *   - `rfed.channel.unsubscribe` `/rfed/unsubscribe` signed `[ch,pub,sig]` → `ok`
 *   - `rfed.channel.publish`     *(DATA SEND)*       `ch‖inner_blob‖[stamp]` → store + fanout + defer
 *   - `rfed.channel.pull`        `/rfed/pull`        `bin(16) ch` → `[[[ch,blob]…], more_pending]`
 *   - `rfed.node`                announce + (Phase 4) peer sync
 *
 * Wire-compatible with the Rust `rfed::destinations` handlers. The blob store
 * (sync-side), subscription table, and deferred queue are in-memory; a
 * filesystem-backed adapter + production runner live in `@reticulum/node`.
 *
 * Delivery model (SPEC §7/§8): on SEND the blob is fanned out live to every
 * subscriber whose `rfed.delivery` is currently present (announced within
 * `presenceTtlSec`); unreachable subscribers get the blob deferred and either
 * flushed when their `rfed.delivery` announces or retrieved via `/rfed/pull`.
 */

import { Allow, Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../core/packet.js";
import { MicroMsgPack } from "../utils/msgpack.js";
import { concatBytes, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { parseSendPayload } from "./blob.js";
import { HASH_LENGTH, STAMP_SIZE } from "./constants.js";
import { validateChannelStamp } from "./stamp.js";
import { BlobStore } from "./blob_store.js";
import { DeferredQueue } from "./deferred_queue.js";
import { SubscriptionTable } from "./subscription.js";

/** rfed app namespace (shared by all rfed destinations). */
const APP_NAME = "rfed";
/** Modern split service destinations (SPEC §2). All share the node identity. */
const SUBSCRIBE_NAME = "rfed.channel.subscribe";
const UNSUBSCRIBE_NAME = "rfed.channel.unsubscribe";
const PUBLISH_NAME = "rfed.channel.publish";
const PULL_NAME = "rfed.channel.pull";
const NODE_NAME = "rfed.node";
/** Subscriber's inbound delivery destination name. */
const DELIVERY_NAME = "rfed.delivery";

/** `/rfed/*` request paths. */
const SUBSCRIBE_PATH = "/rfed/subscribe";
const UNSUBSCRIBE_PATH = "/rfed/unsubscribe";
const PULL_PATH = "/rfed/pull";

/** rfed protocol version advertised in the `rfed.node` announce app_data. */
const PROTOCOL_VERSION = 1;
/** Default `/rfed/pull` page size (SPEC §2: 25). */
const DEFAULT_PULL_PAGE_SIZE = 25;
/** Default per-subscriber deferred-queue cap (SPEC §7: 256). */
const DEFAULT_DEFERRED_QUEUE_LIMIT = 256;
/** Default subscriber presence TTL (seconds) — rfed.delivery announce freshness. */
const DEFAULT_PRESENCE_TTL_SEC = 3600;

/**
 * @typedef {Object} RFedNodeOptions
 * @property {Identity} identity - The node's identity; shared by all rfed.* destinations.
 * @property {any} rns - The Reticulum instance whose `.transport` routes packets
 *   and emits `"announce"` events.
 * @property {Object} [config]
 * @property {number|null} [config.stampCost] Required PoW leading-zero bits.
 *   `null` or `0` disables stamping (default).
 * @property {number} [config.stampFlexibility] Downward cost tolerance (default 3).
 * @property {number} [config.pullPageSize] `/rfed/pull` page size (default 25).
 * @property {number} [config.deferredQueueLimit] Per-subscriber deferred cap (default 256).
 * @property {number} [config.globalDeferredLimit] Global deferred cap (default 4096).
 * @property {number} [config.storageLimitBytes] Blob-store capacity (default 2 GiB).
 * @property {number} [config.presenceTtlSec] Subscriber presence TTL (default 3600).
 * @property {string} [config.name] Display name for the `rfed.node` announce.
 */

/**
 * A rfed federation node.
 *
 * After {@link start}, the node owns its destinations, validates and stores
 * inbound SENDs, fans out to present subscribers, defers for absent ones, and
 * serves `/rfed/pull`. Call {@link stop} to detach the announce listener.
 */
export class RFedNode {
  /**
   * @param {RFedNodeOptions} opts
   */
  constructor({ identity, rns, config = {} }) {
    this.identity = identity;
    this.rns = rns;

    const stampCost =
      config.stampCost && config.stampCost > 0 ? config.stampCost : null;
    /** @type {number|null} */
    this.stampCost = stampCost;
    /** @type {number} */
    this.stampFlexibility = config.stampFlexibility ?? 3;
    this.pullPageSize = config.pullPageSize ?? DEFAULT_PULL_PAGE_SIZE;
    this.deferredQueueLimit =
      config.deferredQueueLimit ?? DEFAULT_DEFERRED_QUEUE_LIMIT;
    this.name = config.name ?? "rfed";
    this.presenceTtlSec = config.presenceTtlSec ?? DEFAULT_PRESENCE_TTL_SEC;

    /** @type {BlobStore} */
    this.blobStore = new BlobStore({
      storageLimitBytes: config.storageLimitBytes,
    });
    /** @type {SubscriptionTable} */
    this.subscriptions = new SubscriptionTable();
    /** @type {DeferredQueue} */
    this.deferred = new DeferredQueue({
      globalLimit: config.globalDeferredLimit,
    });

    /**
     * Subscriber presence: hex(rfed.delivery hash) → Unix seconds of last
     * announce. Populated from the transport `"announce"` event.
     * @type {Map<string, number>}
     * @private
     */
    this._presence = new Map();

    /** @type {import("../core/destination.js").Destination|null} */
    this._nodeDest = null;
    /** @type {import("../core/destination.js").Destination|null} */
    this._subscribeDest = null;
    /** @type {import("../core/destination.js").Destination|null} */
    this._unsubscribeDest = null;
    /** @type {import("../core/destination.js").Destination|null} */
    this._publishDest = null;
    /** @type {import("../core/destination.js").Destination|null} */
    this._pullDest = null;

    /** Bound announce listener (so stop() can detach it). */
    this._announceListener = null;

    /** @type {boolean} */
    this._started = false;
  }

  /** The `rfed.node` destination hash (the canonical node identifier). */
  get nodeHash() {
    return this._nodeDest?.destinationHash ?? null;
  }

  /**
   * Brings up the five inbound destinations, registers the request/Send
   * handlers, binds the announce listener, and announces `rfed.node` + the
   * service destinations so clients can path-request them.
   */
  async start() {
    if (this._started) return;

    this._nodeDest = await Destination.IN(
      NODE_NAME,
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    this._subscribeDest = await this._bringUpRequestDest(SUBSCRIBE_NAME, {
      path: SUBSCRIBE_PATH,
      handler: async (
        /** @type {string} */ _path,
        /** @type {any} */ data,
      ) => this._handleSubscribe(data),
    });
    this._unsubscribeDest = await this._bringUpRequestDest(UNSUBSCRIBE_NAME, {
      path: UNSUBSCRIBE_PATH,
      handler: async (
        /** @type {string} */ _path,
        /** @type {any} */ data,
      ) => this._handleUnsubscribe(data),
    });
    this._pullDest = await this._bringUpRequestDest(PULL_NAME, {
      path: PULL_PATH,
      handler: async (
        /** @type {string} */ _path,
        /** @type {any} */ data,
        /** @type {Uint8Array} */ _requestId,
        /** @type {Identity|null} */ caller,
      ) => this._handlePull(data, caller),
    });

    // Publish destination — fire-and-forget DATA SEND (no link, no request).
    this._publishDest = await Destination.IN(
      PUBLISH_NAME,
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    this._publishDest.addEventListener("data", (/** @type {any} */ event) => {
      this._handleSend(event.detail.plaintext).catch((err) => {
        log(
          "RFedNode",
          `SEND ingest error: ${String(err).slice(0, 160)}`,
          LogLevel.WARNING,
        );
      });
    });
    this.rns.transport.bindLocalDestination(this._publishDest);
    this.rns.transport.bindLocalDestination(this._nodeDest);

    // Track subscriber presence from rfed.delivery announces (and drain
    // deferred queues for subscribers coming back online).
    this._announceListener = (/** @type {any} */ event) => {
      this._onAnnounce(event).catch(() => {});
    };
    this.rns.transport.addEventListener("announce", this._announceListener);

    this._started = true;
    await this.announce();
  }

  /** Detaches the announce listener. */
  stop() {
    if (!this._started) return;
    if (this._announceListener) {
      this.rns.transport.removeEventListener("announce", this._announceListener);
      this._announceListener = null;
    }
    this._started = false;
  }

  /**
   * Announces `rfed.node` (with stamp-cost app_data) and the four service
   * destinations so clients can discover and path-request them.
   */
  async announce() {
    const appData = this._encodeNodeAppData();
    // `Destination.announce()` reads `this.appData` (falls back to the
    // identity's), so we set it on the two destinations that must carry the
    // rfed stamp-cost/protocol-version metadata (SPEC §12).
    if (this._nodeDest) this._nodeDest.appData = appData;
    if (this._publishDest) this._publishDest.appData = appData;
    await Promise.all([
      this._nodeDest?.announce(),
      this._subscribeDest?.announce(),
      this._unsubscribeDest?.announce(),
      this._publishDest?.announce(),
      this._pullDest?.announce(),
    ]);
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  /**
   * `/rfed/subscribe` — verifies the signed `[channel_hash, pubkey, sig]`
   * payload, records the subscription, replies `[true, stamp_cost|nil]`.
   *
   * @param {any} data
   * @returns {Promise<[boolean, number|null]>}
   */
  async _handleSubscribe(data) {
    const parsed = await this._verifySignedChannel(data);
    if (!parsed) return [false, null];
    const { identity, channelHash } = parsed;
    if (channelHash.length !== HASH_LENGTH) return [false, null];

    await this.subscriptions.subscribe(identity, channelHash);
    log(
      "RFedNode",
      `subscribe ${toHex(channelHash)} ← ${toHex(identity.identityHash)}`,
      LogLevel.DEBUG,
    );
    return [true, this.stampCost];
  }

  /**
   * `/rfed/unsubscribe` — verifies the signed payload, drops the subscription.
   *
   * @param {any} data
   * @returns {Promise<boolean>}
   */
  async _handleUnsubscribe(data) {
    const parsed = await this._verifySignedChannel(data);
    if (!parsed) return false;
    const { identity, channelHash } = parsed;
    return this.subscriptions.unsubscribe(identity.identityHash, channelHash);
  }

  /**
   * `/rfed/pull` — drains one page of the caller's deferred queue for the
   * requested channel. Caller is authenticated by the identified link.
   *
   * @param {any} data - `bin(16)` channel hash.
   * @param {Identity|null} caller
   * @returns {Promise<[Array<[Uint8Array, Uint8Array]>, boolean]>}
   */
  async _handlePull(data, caller) {
    if (!caller) return [[], false];
    const channelHash = this._decodeChannelHash(data);
    if (!channelHash) return [[], false];

    const page = this.deferred.drainChannelBatch(
      caller.identityHash,
      channelHash,
      this.pullPageSize,
    );
    const morePending = this.deferred.hasPendingChannel(
      caller.identityHash,
      channelHash,
    );
    const pairs = page.map(
      /** @returns {[Uint8Array, Uint8Array]} */ (p) => [
        new Uint8Array(channelHash),
        p.blob,
      ],
    );
    return [pairs, morePending];
  }

  /**
   * SEND ingest (the publish destination's DATA callback): validate the stamp
   * (when configured), store the blob, and fan out / defer to subscribers.
   *
   * @param {Uint8Array} data - Decrypted SEND payload.
   */
  async _handleSend(data) {
    if (data.length < HASH_LENGTH + 1) {
      log("RFedNode", "SEND too short", LogLevel.WARNING);
      return;
    }

    let channelHash;
    let innerBlob;
    if (this.stampCost) {
      const minLen = HASH_LENGTH + STAMP_SIZE + 1;
      if (data.length < minLen) {
        log("RFedNode", "SEND rejected: too short for stamp", LogLevel.WARNING);
        return;
      }
      const parts = parseSendPayload(data);
      channelHash = parts.channelHash;
      innerBlob = parts.innerBlob;
      const minCost = Math.max(0, this.stampCost - this.stampFlexibility);
      const ok = await validateChannelStamp(
        channelHash,
        innerBlob,
        parts.stamp,
        minCost,
      );
      if (!ok) {
        log("RFedNode", "SEND rejected: stamp below required cost", LogLevel.WARNING);
        return;
      }
    } else {
      channelHash = data.subarray(0, HASH_LENGTH);
      innerBlob = data.subarray(HASH_LENGTH);
    }

    await this._ingest(channelHash, innerBlob);
  }

  // ── ingest / fanout / defer ───────────────────────────────────────────────

  /**
   * Stores the blob (sync-side) and dispatches it to subscribers: live fanout
   * for present subscribers, deferred queue for the rest.
   *
   * @param {Uint8Array} channelHash
   * @param {Uint8Array} innerBlob
   */
  async _ingest(channelHash, innerBlob) {
    this.blobStore.store(channelHash, innerBlob);
    await this._fanout(channelHash, innerBlob);
  }

  /**
   * Fans a blob out to every subscriber of `channelHash`. Present subscribers
   * (their `rfed.delivery` announced within the TTL) receive it immediately;
   * absent subscribers get it enqueued in the deferred queue.
   *
   * @param {Uint8Array} channelHash
   * @param {Uint8Array} innerBlob
   */
  async _fanout(channelHash, innerBlob) {
    const subs = this.subscriptions.subscribersFor(channelHash);
    if (subs.length === 0) return;
    const fanoutPayload = concatBytes(channelHash, innerBlob);

    for (const sub of subs) {
      // Backup subscriptions (Phase 6) suppress delivery while the owner is
      // reachable — not yet wired, so all entries deliver.
      if (this.isOnline(sub.deliveryHash)) {
        await this._sendDelivery(sub.identity, fanoutPayload);
      } else {
        this.deferred.enqueue(
          sub.subscriberHash,
          channelHash,
          innerBlob,
          this.deferredQueueLimit,
        );
      }
    }
  }

  /**
   * Builds and sends an outbound DATA packet to a subscriber's `rfed.delivery`.
   *
   * @param {Identity} subscriberIdentity
   * @param {Uint8Array} payload - `[ channel_hash ‖ inner_blob ]`.
   */
  async _sendDelivery(subscriberIdentity, payload) {
    const dest = await Destination.OUT(
      DELIVERY_NAME,
      DestType.SINGLE,
      subscriberIdentity,
      this.rns,
    );
    const packet = new Packet({
      packetType: PacketType.DATA,
      contextFlag: true,
      contextByte: ContextType.NONE,
      destinationType: DestType.SINGLE,
      destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
      payload,
    });
    await dest.send(packet);
  }

  // ── presence ──────────────────────────────────────────────────────────────

  /**
   * Transport `"announce"` handler: records the destination as present and, if
   * it is a subscriber's `rfed.delivery`, drains that subscriber's deferred
   * queue and live-delivers (SPEC §7 trigger 1).
   *
   * @param {any} event
   */
  async _onAnnounce(event) {
    const dh = event?.detail?.destinationHash;
    if (!dh || dh.length !== HASH_LENGTH) return;
    this._presence.set(toHex(dh), Date.now() / 1000);

    const sub = this.subscriptions.entryForDeliveryHash(dh);
    if (sub) await this._drainDeferredFor(sub);
  }

  /**
   * Live-delivers everything queued for a subscriber (FIFO), then the bucket is
   * empty for future `/rfed/pull` / fanout.
   *
   * @param {{ subscriberHash: Uint8Array, identity: Identity }} sub
   */
  async _drainDeferredFor(sub) {
    const pending = this.deferred.drain(sub.subscriberHash);
    for (const p of pending) {
      await this._sendDelivery(
        sub.identity,
        concatBytes(p.channelHash, p.blob),
      );
    }
  }

  /**
   * Whether a subscriber's `rfed.delivery` has been heard from within the TTL.
   * Exposed so callers (and tests) can inspect reachability before acting.
   *
   * @param {Uint8Array} deliveryHash
   * @returns {boolean}
   */
  isOnline(deliveryHash) {
    const last = this._presence.get(toHex(deliveryHash));
    if (!last) return false;
    return Date.now() / 1000 - last <= this.presenceTtlSec;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Creates an IN SINGLE destination, registers the request handler, wires the
   * link-accept listener, and binds it to the transport.
   *
   * @param {string} name
   * @param {Object} opts
   * @param {string} opts.path
   * @param {any} opts.handler
   * @returns {Promise<import("../core/destination.js").Destination>}
   * @private
   */
  async _bringUpRequestDest(name, { path, handler }) {
    const dest = await Destination.IN(
      name,
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    await dest.registerRequestHandler(path, {
      allow: Allow.ALL,
      responseGenerator: handler,
    });
    dest.addEventListener("link_request", async (/** @type {any} */ e) => {
      try {
        await dest.acceptLink(e.detail.packet);
      } catch (err) {
        log(
          "RFedNode",
          `${name} acceptLink error: ${String(err).slice(0, 120)}`,
          LogLevel.WARNING,
        );
      }
    });
    this.rns.transport.bindLocalDestination(dest);
    return dest;
  }

  /**
   * Verifies a `[channel_hash, pubkey, sig]` payload: derives the identity from
   * the pubkey and checks `sig(channel_hash)`. Matches Rust `verify_signed_payload`.
   *
   * @param {any} data
   * @returns {Promise<{ identity: Identity, channelHash: Uint8Array }|null>}
   * @private
   */
  async _verifySignedChannel(data) {
    if (!Array.isArray(data) || data.length !== 3) return null;
    const [channelHash, pubkey, sig] = data;
    if (
      !(channelHash instanceof Uint8Array) ||
      !(pubkey instanceof Uint8Array) ||
      !(sig instanceof Uint8Array)
    ) {
      return null;
    }
    if (pubkey.length !== 64 || sig.length !== 64) return null;
    const identity = await Identity.fromPublicKey(pubkey);
    const ok = await identity.validate(sig, channelHash);
    if (!ok) return null;
    return { identity, channelHash };
  }

  /**
   * Decodes a `/rfed/pull` request body to a 16-byte channel hash. Accepts a
   * raw `bin(16)` (the link already decodes msgpack bin → Uint8Array) or a bare
   * 16-byte buffer.
   *
   * @param {any} data
   * @returns {Uint8Array|null}
   * @private
   */
  _decodeChannelHash(data) {
    if (data instanceof Uint8Array && data.length === HASH_LENGTH) {
      return data;
    }
    return null;
  }

  /**
   * Encodes the `rfed.node` announce app_data: msgpack
   * `[bin(display_name), uint(stamp_cost)|nil, uint(1)]` (SPEC §12).
   *
   * @returns {Uint8Array}
   * @private
   */
  _encodeNodeAppData() {
    const nameBytes = new TextEncoder().encode(this.name);
    return MicroMsgPack.encode([
      nameBytes,
      this.stampCost ?? null,
      PROTOCOL_VERSION,
    ]);
  }
}
