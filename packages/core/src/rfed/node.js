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
import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { concatBytes, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { MicroMsgPack } from "../utils/msgpack.js";
import { parseSendPayload } from "./blob.js";
import { BlobStore } from "./blob_store.js";
import { HASH_LENGTH, STAMP_SIZE } from "./constants.js";
import { DeferredQueue } from "./deferred_queue.js";
import {
  encodeWakePayload,
  fromHex,
  NOTIFY_CLEAR,
  NOTIFY_REGISTER,
  NOTIFY_UNREGISTER,
  NotifyRegistry,
  parseNotifyCommand,
  validateRelayHash,
} from "./notify.js";
import { validateChannelStamp } from "./stamp.js";
import { SubscriptionTable } from "./subscription.js";
import {
  decodeBlobStream,
  encodeBlobStream,
  fullManifest,
  gapFromPeer,
} from "./sync.js";

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
/** Notify registration destinations (SPEC §2/§9): legacy combined + split. */
const NOTIFY_NAME = "rfed.notify";
const NOTIFY_REGISTER_NAME = "rfed.notify.register";
const NOTIFY_UNREGISTER_NAME = "rfed.notify.unregister";

/** `/rfed/*` request paths. */
const SUBSCRIBE_PATH = "/rfed/subscribe";
const UNSUBSCRIBE_PATH = "/rfed/unsubscribe";
const PULL_PATH = "/rfed/pull";
/** `/rfed/*` peer-sync paths (SPEC §4). */
const OFFER_PATH = "/rfed/offer";
const MESSAGE_GET_PATH = "/rfed/get";
/** `/rfed/backup/push` (SPEC §11) — owner → backup subscription replication. */
const BACKUP_PUSH_PATH = "/rfed/backup/push";
/** `/rfed/notify/*` registration paths (SPEC §9.1). */
const NOTIFY_REGISTER_PATH = "/rfed/notify/register";
const NOTIFY_UNREGISTER_PATH = "/rfed/notify/unregister";
const NOTIFY_CLEAR_PATH = "/rfed/notify/clear";

/** rfed protocol version advertised in the `rfed.node` announce app_data. */
const PROTOCOL_VERSION = 1;
/** Default `/rfed/pull` page size (SPEC §2: 25). */
const DEFAULT_PULL_PAGE_SIZE = 25;
/** Default per-subscriber deferred-queue cap (SPEC §7: 256). */
const DEFAULT_DEFERRED_QUEUE_LIMIT = 256;
/** Default subscriber presence TTL (seconds) — rfed.delivery announce freshness. */
const DEFAULT_PRESENCE_TTL_SEC = 3600;
/** Blob-store TTL (SPEC §5: 30 days). */
const BLOB_TTL_SECS = 30 * 24 * 3600;
/** Deferred-queue entry TTL (SPEC §7: 7-day prune). */
const DEFERRED_TTL_SECS = 7 * 24 * 3600;
/** Seconds since an owner's `rfed.node` announce before a backup considers it
 * offline and starts delivering (SPEC §11; default 90). */
const DEFAULT_OWNER_OFFLINE_SECS = 90;
/** Backup-push tick cadence (Rust `BACKUP_TICK_SECS` = 30s) — a runner concern,
 * exposed for tests/default scheduling. */
const BACKUP_TICK_SECS = 30;
/** Cap on the pending-backup-push queue (Rust `PENDING_BACKUP_CAP` = 1024). */
const PENDING_BACKUP_CAP = 1024;

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
 * @property {number} [config.blobTtlSecs] Blob age TTL pruned by
 *   {@link RFedNode#tickMaintenance} (default 30 days; SPEC §5).
 * @property {number} [config.deferredTtlSecs] Deferred-queue entry age TTL
 *   pruned by {@link RFedNode#tickMaintenance} (default 7 days; SPEC §7).
 * @property {number} [config.presenceTtlSec] Subscriber presence TTL (default 3600).
 * @property {string} [config.name] Display name for the `rfed.node` announce.
 * @property {(subscriberHash: Uint8Array) => { deferredQueueLimit: number }} [config.policyFor]
 *   Per-subscriber policy lookup (default tier); a runner overrides this to
 *   drive VIP tiers from config. Used for the per-subscriber deferred cap.
 * @property {number|null} [config.transferLimitBytes] Per-`/rfed/get` session
 *   byte cap (SPEC §4). When set, the GET response stops emitting records once
 *   this would be exceeded (default `null` = unlimited for the in-memory node;
 *   a runner should bound it).
 * @property {Uint8Array|null} [config.primaryNode] Designated first-choice
 *   backup target for THIS node's subscribers (SPEC §11). Subscription pairs
 *   are pushed here via `/rfed/backup/push` on each backup tick.
 * @property {Uint8Array[]} [config.secondaryNodes] Ordered fallback backup
 *   targets; used when the primary is unreachable.
 * @property {number} [config.ownerOfflineSecs] Seconds since an owner's
 *   `rfed.node` announce before a backup considers it offline and starts
 *   delivering (default 90).
 * @property {Uint8Array[]} [config.trustedBackupPeers] If non-empty, only
 *   `/rfed/backup/push` requests whose owner `rfed.node` hash is in this list
 *   are accepted.
 * @property {{ blobStore?: BlobStore, subscriptions?: SubscriptionTable, deferred?: DeferredQueue, notify?: NotifyRegistry }} [stores]
 *   Pre-built stores to adopt instead of fresh in-memory ones. A runner passes
 *   stores loaded from disk (via `@reticulum/node`'s `loadRFedStores`) so state
 *   survives restarts; the node then owns and mutates them.
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
  constructor({ identity, rns, config = {}, stores = {} }) {
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
    /** @type {number} */
    this.blobTtlSecs = config.blobTtlSecs ?? BLOB_TTL_SECS;
    /** @type {number} */
    this.deferredTtlSecs = config.deferredTtlSecs ?? DEFERRED_TTL_SECS;
    /** @type {number|null} */
    this.transferLimitBytes = config.transferLimitBytes ?? null;

    // ── Backup failover (SPEC §11, Phase 6) ──────────────────────────────
    /** @type {Uint8Array|null} Designated primary backup target. */
    this.primaryNode = config.primaryNode ?? null;
    /** @type {Uint8Array[]} Ordered fallback backup targets. */
    this.secondaryNodes = config.secondaryNodes ?? [];
    /** @type {number} */
    this.ownerOfflineSecs =
      config.ownerOfflineSecs ?? DEFAULT_OWNER_OFFLINE_SECS;
    /**
     * If non-empty, only accept `/rfed/backup/push` from these owner hashes.
     * @type {Uint8Array[]}
     */
    this.trustedBackupPeers = config.trustedBackupPeers ?? [];
    /**
     * Pending `(subscriberHash, channelHash)` pairs awaiting push to the
     * backup node. Drained by {@link tickBackupDelivery}. Mirrors Rust
     * `pending_backup_pushes` (capped at `PENDING_BACKUP_CAP`).
     * @type {Array<[Uint8Array, Uint8Array]>}
     * @private
     */
    this._pendingBackupPushes = [];

    /**
     * Per-subscriber policy lookup (mirrors Rust `NodeConfig::policy_for`).
     * Defaults to the flat configured limits; a runner overrides this to drive
     * VIP tiers from real config. Used today for the per-subscriber deferred
     * queue cap.
     *
     * @type {(subscriberHash: Uint8Array) => { deferredQueueLimit: number }}
     */
    this.policyFor =
      config.policyFor ??
      (() => ({ deferredQueueLimit: this.deferredQueueLimit }));

    /** @type {BlobStore} */
    this.blobStore =
      stores.blobStore ??
      new BlobStore({ storageLimitBytes: config.storageLimitBytes });
    /** @type {SubscriptionTable} */
    this.subscriptions = stores.subscriptions ?? new SubscriptionTable();
    /** @type {DeferredQueue} */
    this.deferred =
      stores.deferred ??
      new DeferredQueue({ globalLimit: config.globalDeferredLimit });
    /** @type {NotifyRegistry} Per-node, never synced (SPEC §9). */
    this.notifyRegistry = stores.notify ?? new NotifyRegistry();

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
    /** @type {import("../core/destination.js").Destination|null} */
    this._notifyDest = null;
    /** @type {import("../core/destination.js").Destination|null} */
    this._notifyRegisterDest = null;
    /** @type {import("../core/destination.js").Destination|null} */
    this._notifyUnregisterDest = null;

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

    this._nodeDest = await this._bringUpDest(NODE_NAME);
    // `rfed.node` serves peer sync (SPEC §4): OFFER (manifest) + MESSAGE_GET
    // (blob stream). Both allow any caller (`ALLOW_ALL`) like Rust.
    await this._nodeDest.registerRequestHandler(OFFER_PATH, {
      allow: Allow.ALL,
      responseGenerator: async (
        /** @type {string} */ _p,
        /** @type {any} */ _data,
      ) => this._handleOffer(),
    });
    await this._nodeDest.registerRequestHandler(MESSAGE_GET_PATH, {
      allow: Allow.ALL,
      responseGenerator: async (
        /** @type {string} */ _p,
        /** @type {any} */ data,
      ) => this._handleGet(data),
    });
    // `/rfed/backup/push` (SPEC §11) — owner → backup subscription replication.
    await this._nodeDest.registerRequestHandler(BACKUP_PUSH_PATH, {
      allow: Allow.ALL,
      responseGenerator: async (
        /** @type {string} */ _p,
        /** @type {any} */ d,
      ) => this._handleBackupPush(d),
    });
    this._subscribeDest = await this._bringUpRequestDest(SUBSCRIBE_NAME, {
      path: SUBSCRIBE_PATH,
      handler: async (/** @type {string} */ _path, /** @type {any} */ data) =>
        this._handleSubscribe(data),
    });
    this._unsubscribeDest = await this._bringUpRequestDest(UNSUBSCRIBE_NAME, {
      path: UNSUBSCRIBE_PATH,
      handler: async (/** @type {string} */ _path, /** @type {any} */ data) =>
        this._handleUnsubscribe(data),
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

    // Notify registration destinations (SPEC §9). The legacy combined
    // `rfed.notify` serves register/unregister/clear; the split
    // `rfed.notify.register`/`rfed.notify.unregister` serve register/unregister.
    this._notifyDest = await this._bringUpDest(NOTIFY_NAME);
    await this._notifyDest.registerRequestHandler(NOTIFY_REGISTER_PATH, {
      allow: Allow.ALL,
      responseGenerator: async (
        /** @type {string} */ _p,
        /** @type {any} */ d,
      ) => this._handleNotifyRegister(d),
    });
    await this._notifyDest.registerRequestHandler(NOTIFY_UNREGISTER_PATH, {
      allow: Allow.ALL,
      responseGenerator: async (
        /** @type {string} */ _p,
        /** @type {any} */ d,
      ) => this._handleNotifyUnregister(d),
    });
    await this._notifyDest.registerRequestHandler(NOTIFY_CLEAR_PATH, {
      allow: Allow.ALL,
      responseGenerator: async (
        /** @type {string} */ _p,
        /** @type {any} */ d,
      ) => this._handleNotifyClear(d),
    });
    this._notifyRegisterDest = await this._bringUpRequestDest(
      NOTIFY_REGISTER_NAME,
      {
        path: NOTIFY_REGISTER_PATH,
        handler: async (/** @type {string} */ _p, /** @type {any} */ d) =>
          this._handleNotifyRegister(d),
      },
    );
    this._notifyUnregisterDest = await this._bringUpRequestDest(
      NOTIFY_UNREGISTER_NAME,
      {
        path: NOTIFY_UNREGISTER_PATH,
        handler: async (/** @type {string} */ _p, /** @type {any} */ d) =>
          this._handleNotifyUnregister(d),
      },
    );

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
      this.rns.transport.removeEventListener(
        "announce",
        this._announceListener,
      );
      this._announceListener = null;
    }
    this._started = false;
  }

  /**
   * Periodic maintenance — a runner calls this hourly (SPEC §5/§7). Prunes
   * expired blobs (30-day TTL) and deferred-queue entries (7-day TTL) and
   * evicts blob-store overflow to the capacity limit.
   *
   * @returns {{ blobsEvicted: number, deferredEvicted: number }}
   */
  tickMaintenance() {
    const blobsEvicted = this.blobStore.pruneOlderThan(this.blobTtlSecs);
    const deferredEvicted = this.deferred.evictExpired(this.deferredTtlSecs);
    return { blobsEvicted, deferredEvicted };
  }

  /**
   * Backup-failover tick (SPEC §11) — a runner calls this every
   * {@link BACKUP_TICK_SECS} seconds (30s). Three tasks:
   *
   *   1. **Push own subscriptions**: drain `{@link _pendingBackupPushes}` and
   *      forward to ONE resolved backup node.
   *   2. **Prune** stale backup entries (chain unravel; TTL =
   *      `max(ownerOfflineSecs × 2, 90)`).
   *   3. **Failover**: for each held backup whose owner has gone silent, dump
   *      the channel backlog into the deferred queue + fire notify wakes, and
   *      re-push adopted entries to our own backup (chain of custody).
   *
   * Mirrors Rust `tick_backup_delivery`. Auto-selection from federation peers
   * (Rust priority 5) is not implemented — only configured `primaryNode` /
   * `secondaryNodes` are used.
   *
   * @returns {Promise<{ pushed: number, pruned: number, adopted: number, repushed: number }>}
   */
  async tickBackupDelivery() {
    const backupHash = this._resolveBackup();

    // ── Part 1: push own pending registrations ──────────────────────
    let pushed = 0;
    if (this._pendingBackupPushes.length > 0) {
      const pending = this._pendingBackupPushes;
      this._pendingBackupPushes = [];
      if (backupHash) {
        const ok = await this._pushSubscriptionsToBackup(backupHash, pending);
        if (ok) {
          pushed = pending.length;
        } else {
          // Re-queue for the next tick (respecting the cap).
          this._requeueBackupPairs(pending);
        }
      } else {
        // No backup available — put them back.
        this._requeueBackupPairs(pending);
      }
    }

    // ── Part 2: prune stale backup entries (chain unravel) ──────────
    const ttl = Math.max(this.ownerOfflineSecs * 2, 90);
    const pruned = this.subscriptions.pruneStaleBackups(ttl);
    if (pruned > 0) {
      log(
        "RFedNode",
        `backup pruned ${pruned} stale entry(ies) (TTL ${ttl}s)`,
        LogLevel.DEBUG,
      );
    }

    // ── Part 3: failover delivery + chain-of-custody re-push ────────
    const adopted = this._backupDeliveryTick();
    let repushed = 0;
    if (adopted.length > 0 && backupHash) {
      const backupHex = toHex(backupHash);
      // Don't bounce adopted entries back to the current owner.
      /** @type {Array<[Uint8Array, Uint8Array]>} */
      const repush = [];
      for (const { subscriberHash, channelHash, ownerHash } of adopted) {
        if (toHex(ownerHash) === backupHex) continue;
        repush.push([subscriberHash, channelHash]);
      }
      if (repush.length > 0) {
        const ok = await this._pushSubscriptionsToBackup(backupHash, repush);
        if (ok) repushed = repush.length;
      }
    }

    return { pushed, pruned, adopted: adopted.length, repushed };
  }

  /**
   * Resolves the active backup target in priority order (SPEC §11):
   * primaryNode → first secondaryNode → null. (Rust also auto-selects from
   * alive federation peers; that requires a peer registry this node doesn't
   * keep, so it's omitted.)
   *
   * @returns {Uint8Array|null}
   * @private
   */
  _resolveBackup() {
    return this.primaryNode ?? this.secondaryNodes[0] ?? null;
  }

  /**
   * Re-queues pairs onto the pending backup-push list, respecting the cap.
   *
   * @param {Array<[Uint8Array, Uint8Array]>} pairs
   * @private
   */
  _requeueBackupPairs(pairs) {
    for (const p of pairs) {
      if (this._pendingBackupPushes.length >= PENDING_BACKUP_CAP) break;
      this._pendingBackupPushes.push(p);
    }
  }

  /**
   * Failover scan (Rust `backup_delivery_tick`): for each backup entry whose
   * owner has been silent past `ownerOfflineSecs`, copy the channel's blobs
   * into the subscriber's deferred queue (so they flush on the next
   * `/rfed/pull`) and fire notify wakes. Skips subscribers that already have
   * pending deferred entries (avoids re-dumping every tick). Returns the
   * adopted `(sub, ch, owner)` triples for chain-of-custody re-push.
   *
   * @returns {Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array, ownerHash: Uint8Array }>}
   * @private
   */
  _backupDeliveryTick() {
    const entries = this.subscriptions.backupEntriesForTick();
    if (entries.length === 0) return [];

    // Group by owner — one liveness check per owner.
    /** @type {Map<string, { ownerHash: Uint8Array, subs: Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array }> }>} */
    const byOwner = new Map();
    for (const e of entries) {
      const key = toHex(e.ownerNodeHash);
      let bucket = byOwner.get(key);
      if (!bucket) {
        bucket = { ownerHash: e.ownerNodeHash, subs: [] };
        byOwner.set(key, bucket);
      }
      bucket.subs.push({
        subscriberHash: e.subscriberHash,
        channelHash: e.channelHash,
      });
    }

    /** @type {Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array, ownerHash: Uint8Array }>} */
    const adopted = [];
    for (const { ownerHash, subs } of byOwner.values()) {
      if (this._ownerReachable(ownerHash)) continue;

      for (const { subscriberHash, channelHash } of subs) {
        // Already enqueued? Mark adopted but don't re-dump.
        if (this.deferred.hasPending(subscriberHash)) {
          adopted.push({ subscriberHash, channelHash, ownerHash });
          continue;
        }
        const ids = this.blobStore.messageIdsForChannel(channelHash);
        if (ids.length === 0) continue;
        const limit = this.policyFor(subscriberHash).deferredQueueLimit;
        let enqueued = 0;
        for (const id of ids) {
          const blob = this.blobStore.get(id);
          if (!blob) continue;
          this.deferred.enqueue(
            subscriberHash,
            channelHash,
            new Uint8Array(blob),
            limit,
          );
          enqueued++;
        }
        if (enqueued > 0) {
          adopted.push({ subscriberHash, channelHash, ownerHash });
          this._fireChannelNotify(subscriberHash, channelHash);
        }
      }
    }
    return adopted;
  }

  /**
   * Opens a link to a backup node's `rfed.node` and pushes a batch of
   * `(subscriber_hash, channel_hash)` pairs via `/rfed/backup/push`. The pairs
   * are signed with this node's identity (shared `[value, pubkey, sig]` form;
   * `value` is the pairs msgpack). Returns whether the peer accepted. On any
   * failure the pairs should be re-queued by the caller. Mirrors Rust
   * `push_subscriptions_to_backup`.
   *
   * @param {Uint8Array} backupHash - The backup's `rfed.node` destination hash.
   * @param {Array<[Uint8Array, Uint8Array]>} pairs
   * @returns {Promise<boolean>}
   * @private
   */
  async _pushSubscriptionsToBackup(backupHash, pairs) {
    const peerIdentity = await Destination.recall(backupHash);
    if (!peerIdentity) {
      this.rns.transport?.requestPath?.(backupHash);
      log("RFedNode", "backup push — no path to backup node", LogLevel.DEBUG);
      return false;
    }
    const dest = await Destination.OUT(
      NODE_NAME,
      DestType.SINGLE,
      peerIdentity,
      this.rns,
    );
    const link = await dest.createLink();
    await link.identify(this.identity);
    try {
      const pairsMsgpack = MicroMsgPack.encode(pairs);
      const pubkey = await this.identity.getPublicKey();
      const sig = await this.identity.sign(pairsMsgpack);
      // The link msgpack-encodes the request body, so pass the plain
      // `[value, pubkey, sig]` array (value = the pairs msgpack bytes).
      const resp = await link.request(BACKUP_PUSH_PATH, [
        pairsMsgpack,
        pubkey,
        sig,
      ]);
      const accepted = resp === true;
      if (!accepted) {
        log("RFedNode", "backup push rejected by peer", LogLevel.WARNING);
      }
      return accepted;
    } finally {
      await link.teardown();
    }
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
      this._notifyDest?.announce(),
      this._notifyRegisterDest?.announce(),
      this._notifyUnregisterDest?.announce(),
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
    // Queue for backup push (SPEC §11): the primary forwards its own
    // subscriptions to its designated backup so delivery can fail over.
    if (this._pendingBackupPushes.length < PENDING_BACKUP_CAP) {
      this._pendingBackupPushes.push([
        new Uint8Array(identity.identityHash),
        new Uint8Array(channelHash),
      ]);
    }
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
   * `/rfed/notify/register` (SPEC §9.1) — verifies the signed command, validates
   * the relay hash, remembers the relay identity (so we can later route a wake
   * to it), issues a path request, and records the registration.
   *
   * @param {any} data
   * @returns {Promise<boolean>}
   */
  async _handleNotifyRegister(data) {
    const parsed = await this._verifySignedPayload(data);
    if (!parsed) return false;
    const subscriberHash = parsed.identity.identityHash;
    let cmd;
    try {
      cmd = parseNotifyCommand(parsed.value, NOTIFY_REGISTER);
    } catch (err) {
      log(
        "RFedNode",
        `notify/register: ${String(err).slice(0, 120)}`,
        LogLevel.WARNING,
      );
      return false;
    }
    if (!cmd.relayHash) return false;
    const err = validateRelayHash(cmd.relayHash);
    if (err) {
      log("RFedNode", `notify registration rejected: ${err}`, LogLevel.WARNING);
      return false;
    }
    const relayBytes = fromHex(cmd.relayHash);
    if (!relayBytes || relayBytes.length !== 16) return false;
    // Request a path to the relay so future wakes can route. The relay's
    // identity is learned from its own `rfed.notify` announce (transport cache),
    // NOT from this registration — a registration carries only the relay hash.
    this.rns.transport?.requestPath?.(relayBytes);
    this.notifyRegistry.register(
      subscriberHash,
      cmd.channelHash,
      cmd.relayHash,
    );
    log(
      "RFedNode",
      `notify/register relay=${cmd.relayHash} ← ${toHex(subscriberHash)}`,
      LogLevel.DEBUG,
    );
    return true;
  }

  /**
   * `/rfed/notify/unregister` — removes one `(subscriber, channel, relay)`
   * registration.
   *
   * @param {any} data
   * @returns {Promise<boolean>}
   */
  async _handleNotifyUnregister(data) {
    const parsed = await this._verifySignedPayload(data);
    if (!parsed) return false;
    const subscriberHash = parsed.identity.identityHash;
    let cmd;
    try {
      cmd = parseNotifyCommand(parsed.value, NOTIFY_UNREGISTER);
    } catch {
      return false;
    }
    if (!cmd.relayHash) return false;
    this.notifyRegistry.unregister(
      subscriberHash,
      cmd.channelHash,
      cmd.relayHash,
    );
    return true;
  }

  /**
   * `/rfed/notify/clear` — removes ALL relay registrations for the caller
   * (every channel + LXMF). Served on legacy `rfed.notify` only.
   *
   * @param {any} data
   * @returns {Promise<boolean>}
   */
  async _handleNotifyClear(data) {
    const parsed = await this._verifySignedPayload(data);
    if (!parsed) return false;
    this.notifyRegistry.clear(parsed.identity.identityHash);
    return true;
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
   * `/rfed/backup/push` (SPEC §11) — an owner node replicates its
   * `(subscriber_hash, channel_hash)` pairs to this backup. The payload is the
   * shared signed `[value, pubkey, sig]` form where `value` is the msgpack of
   * `[[sub_hash, ch_hash], …]`; the owner identity is derived from `pubkey`
   * and its `rfed.node` hash tags the resulting backup subscriptions. Replies
   * `true` on success, `false` on any verification/trust failure. Mirrors Rust
   * `backup_push_cb`.
   *
   * @param {any} data
   * @returns {Promise<boolean>}
   */
  async _handleBackupPush(data) {
    const parsed = await this._verifySignedPayload(data);
    if (!parsed) return false;
    const { identity, value } = parsed;

    // Owner hash = their `rfed.node` destination hash.
    const ownerDest = await Destination.OUT(
      NODE_NAME,
      DestType.SINGLE,
      identity,
    );
    const ownerHash = /** @type {Uint8Array} */ (ownerDest.destinationHash);

    // Trust gate: if trusted_backup_peers is set, only accept listed owners.
    if (this.trustedBackupPeers.length > 0) {
      const trusted = this.trustedBackupPeers.some(
        (h) => toHex(h) === toHex(ownerHash),
      );
      if (!trusted) {
        log(
          "RFedNode",
          `backup/push rejected — untrusted owner ${toHex(ownerHash)}`,
          LogLevel.WARNING,
        );
        return false;
      }
    }

    /** @type {Array<[Uint8Array, Uint8Array]>} */
    let pairs;
    try {
      pairs = MicroMsgPack.decode(value);
    } catch {
      return false;
    }
    if (!Array.isArray(pairs)) return false;
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [subHash, chHash] = pair;
      if (
        !(subHash instanceof Uint8Array) ||
        subHash.length !== HASH_LENGTH ||
        !(chHash instanceof Uint8Array) ||
        chHash.length !== HASH_LENGTH
      ) {
        continue;
      }
      this.subscriptions.subscribeBackup(subHash, chHash, ownerHash);
    }
    log(
      "RFedNode",
      `backup/push registered ${pairs.length} backup sub(s) ← owner ${toHex(ownerHash)}`,
      LogLevel.DEBUG,
    );
    return true;
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
        log(
          "RFedNode",
          "SEND rejected: stamp below required cost",
          LogLevel.WARNING,
        );
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
   * `/rfed/offer` (SPEC §4) — returns the node's **full** store manifest as
   * `[[channelHash, messageId], …]` so the caller can compute its gap.
   * (Rust `handle_offer`; the caller's offered IDs are accepted but unused.)
   *
   * @returns {Array<[Uint8Array, Uint8Array]>}
   */
  _handleOffer() {
    return fullManifest(this.blobStore);
  }

  /**
   * `/rfed/get` (SPEC §3/§4) — encodes the requested blobs into the §3 stream
   * `ch(16)‖id(16)‖len(4 BE)‖blob`, stopping once `transferLimitBytes` would
   * be exceeded (per-session cap). Returns the raw stream bytes; the Link wraps
   * them in a msgpack Binary for transit (Rust `handle_message_get`).
   *
   * Blobs transit stamp-stripped; no stamp validation here.
   *
   * @param {any} data - Decoded `msgpack [id, …]`.
   * @returns {Uint8Array}
   */
  _handleGet(data) {
    /** @type {Uint8Array[]} */
    const ids = Array.isArray(data) ? data : [];
    /** @type {Array<{ channelHash: Uint8Array, messageId: Uint8Array, blob: Uint8Array }>} */
    const records = [];
    let total = 0;
    for (const id of ids) {
      const meta = this.blobStore.metaFor(id);
      if (!meta) continue;
      const blob = this.blobStore.get(id);
      if (!blob) continue;
      if (
        this.transferLimitBytes !== null &&
        total + blob.length > this.transferLimitBytes
      ) {
        break;
      }
      records.push({
        channelHash: meta.channelHash,
        messageId: meta.messageId,
        blob: new Uint8Array(blob),
      });
      total += blob.length;
    }
    return encodeBlobStream(records);
  }

  /**
   * Synchronises with a peer `rfed.node`: OFFER (our held IDs) → receive the
   * peer's manifest → compute the gap (channels we subscribe to, don't hold) →
   * MESSAGE_GET the missing blobs → ingest each (store under the upstream id,
   * then fan out to local subscribers). Mirrors Rust `run_sync_session`.
   *
   * Returns the number of newly-ingested blobs. Throws if the peer identity
   * cannot be recalled or the link fails.
   *
   * @param {Uint8Array} peerNodeHash - The peer's `rfed.node` destination hash.
   * @returns {Promise<number>}
   */
  async syncWithPeer(peerNodeHash) {
    const peerIdentity = await Destination.recall(peerNodeHash);
    const dest = await Destination.OUT(
      NODE_NAME,
      DestType.SINGLE,
      peerIdentity,
      this.rns,
    );
    const link = await dest.createLink();
    await link.identify(this.identity);
    try {
      // OFFER — send our held IDs (peer ignores them, but matches the protocol).
      const manifest = /** @type {Array<[Uint8Array, Uint8Array]>} */ (
        await link.request(OFFER_PATH, this.blobStore.allMessageIds())
      );
      const wanted = gapFromPeer(
        manifest,
        this.blobStore,
        this.subscriptions.subscribedChannelHashes(),
      );
      if (wanted.length === 0) return 0;
      // MESSAGE_GET — the §3 blob stream (decodes to a Uint8Array).
      const stream = /** @type {Uint8Array} */ (
        await link.request(MESSAGE_GET_PATH, wanted)
      );
      let ingested = 0;
      for (const { channelHash, messageId, blob } of decodeBlobStream(stream)) {
        if (this.blobStore.get(messageId)) continue; // already held
        this.blobStore.storeWithId(channelHash, messageId, blob);
        await this._fanout(channelHash, blob);
        ingested++;
      }
      return ingested;
    } finally {
      await link.teardown();
    }
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
      // Backup subscriptions (SPEC §11): suppress delivery while the owner is
      // reachable; when the owner has gone silent, defer only — the backup
      // holds no subscriber identity, so the subscriber is pull-served
      // (never live-fanout here).
      if (sub.ownerNodeHash) {
        if (this._ownerReachable(sub.ownerNodeHash)) continue;
        const policy = this.policyFor(sub.subscriberHash);
        this.deferred.enqueue(
          sub.subscriberHash,
          channelHash,
          innerBlob,
          policy.deferredQueueLimit,
        );
        this._fireChannelNotify(sub.subscriberHash, channelHash);
        continue;
      }

      // Primary subscription: live-deliver if present, else defer.
      if (sub.identity && sub.deliveryHash && this.isOnline(sub.deliveryHash)) {
        await this._sendDelivery(sub.identity, fanoutPayload);
      } else {
        const policy = this.policyFor(sub.subscriberHash);
        this.deferred.enqueue(
          sub.subscriberHash,
          channelHash,
          innerBlob,
          policy.deferredQueueLimit,
        );
        this._fireChannelNotify(sub.subscriberHash, channelHash);
      }
    }
  }

  /**
   * Fires a §9.3 notify wake to every relay registered for
   * `(subscriber, channel)`. Fire-and-forget. Shared by fanout and the backup
   * failover tick.
   *
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @private
   */
  _fireChannelNotify(subscriberHash, channelHash) {
    for (const reg of this.notifyRegistry.getForSubscriber(
      subscriberHash,
      channelHash,
    )) {
      this._dispatchNotify(reg, {
        receiver: subscriberHash,
        channel: channelHash,
      }).catch(() => {});
    }
  }

  /**
   * Whether an owner node's `rfed.node` has been heard from within
   * `ownerOfflineSecs` (SPEC §11). Reuses the announce-presence map (an
   * owner's `rfed.node` announce lands there like any other destination).
   *
   * @param {Uint8Array} ownerNodeHash
   * @returns {boolean}
   * @private
   */
  _ownerReachable(ownerNodeHash) {
    const last = this._presence.get(toHex(ownerNodeHash));
    if (!last) return false;
    return Date.now() / 1000 - last <= this.ownerOfflineSecs;
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

  /**
   * Sends a §9.3 notify wake packet to a registered relay's `rfed.notify`
   * destination. Fire-and-forget: failures are logged and swallowed (the
   * subscriber still gets the blob via deferred pull / live fanout later).
   * The relay identity must be recallable (it was remembered at registration).
   *
   * @param {{ relayHash: string }} reg
   * @param {{ receiver: Uint8Array, sender?: Uint8Array|null, channel?: Uint8Array|null }} parts
   */
  async _dispatchNotify(reg, parts) {
    const relayBytes = fromHex(reg.relayHash);
    if (!relayBytes || relayBytes.length !== HASH_LENGTH) return;
    let identity;
    try {
      identity = await Destination.recall(relayBytes);
    } catch {
      log(
        "RFedNode",
        `notify: relay identity not cached for ${reg.relayHash}`,
        LogLevel.DEBUG,
      );
      return;
    }
    const dest = await Destination.OUT(
      NOTIFY_NAME,
      DestType.SINGLE,
      identity,
      this.rns,
    );
    const payload = encodeWakePayload(parts);
    const packet = new Packet({
      packetType: PacketType.DATA,
      contextFlag: true,
      contextByte: ContextType.NONE,
      destinationType: DestType.SINGLE,
      destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
      payload,
    });
    try {
      await dest.send(packet);
      log("RFedNode", `notify wake → relay ${reg.relayHash}`, LogLevel.DEBUG);
    } catch (err) {
      log(
        "RFedNode",
        `notify send failed for relay ${reg.relayHash}: ${String(err).slice(0, 120)}`,
        LogLevel.WARNING,
      );
    }
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
  /**
   * Live-delivers everything queued for a subscriber (FIFO), then the bucket is
   * empty for future `/rfed/pull` / fanout. Backup entries have no identity and
   * are pull-served, so a null identity here is a no-op.
   *
   * @param {{ subscriberHash: Uint8Array, identity: Identity|null }} sub
   */
  async _drainDeferredFor(sub) {
    if (!sub.identity) return;
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
   * Creates an IN SINGLE destination, wires the link-accept listener, and
   * binds it to the transport. `rfed.node` uses this directly (it registers
   * multiple handlers); request destinations go through `_bringUpRequestDest`.
   *
   * @param {string} name
   * @returns {Promise<import("../core/destination.js").Destination>}
   * @private
   */
  async _bringUpDest(name) {
    const dest = await Destination.IN(
      name,
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
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
   * Brings up a destination and registers a single request handler on it.
   *
   * @param {string} name
   * @param {Object} opts
   * @param {string} opts.path
   * @param {any} opts.handler
   * @returns {Promise<import("../core/destination.js").Destination>}
   * @private
   */
  async _bringUpRequestDest(name, { path, handler }) {
    const dest = await this._bringUpDest(name);
    await dest.registerRequestHandler(path, {
      allow: Allow.ALL,
      responseGenerator: handler,
    });
    return dest;
  }

  /**
   * Verifies the shared `[value, pubkey, sig]` signed payload (Rust
   * `verify_signed_payload`): derives the identity from `pubkey` and checks
   * `sig(value)`. Returns the verified identity + the signed value bytes, or
   * `null`. Used by subscribe/unsubscribe (value = channel hash) and notify
   * register/unregister/clear (value = command msgpack).
   *
   * @param {any} data
   * @returns {Promise<{ identity: Identity, value: Uint8Array }|null>}
   * @private
   */
  async _verifySignedPayload(data) {
    if (!Array.isArray(data) || data.length !== 3) return null;
    const [value, pubkey, sig] = data;
    if (
      !(value instanceof Uint8Array) ||
      !(pubkey instanceof Uint8Array) ||
      !(sig instanceof Uint8Array)
    ) {
      return null;
    }
    if (pubkey.length !== 64 || sig.length !== 64) return null;
    const identity = await Identity.fromPublicKey(pubkey);
    const ok = await identity.validate(sig, value);
    if (!ok) return null;
    return { identity, value };
  }

  /**
   * Verifies a `[channel_hash, pubkey, sig]` subscribe/unsubscribe payload:
   * the signed value IS the channel hash.
   *
   * @param {any} data
   * @returns {Promise<{ identity: Identity, channelHash: Uint8Array }|null>}
   * @private
   */
  async _verifySignedChannel(data) {
    const parsed = await this._verifySignedPayload(data);
    if (!parsed) return null;
    if (parsed.value.length !== HASH_LENGTH) return null;
    return { identity: parsed.identity, channelHash: parsed.value };
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
