/**
 * @file subscription.js
 * @description In-memory rfed subscription table (work doc #25, Phase 2).
 *
 * Maps `(subscriber, channel)` pairs. Mirrors the Rust
 * `rfed::subscription::SubscriptionTable` schema (subscriber_hash ‖
 * channel_hash), with two JS-side conveniences for fanout:
 *
 *   - the subscriber's full {@link Identity} is kept inline (the Rust node
 *     re-derives it via `Identity::recall_from_identity_hash`; we hold it so
 *     fanout always has the encryption key, including right after a restart),
 *   - the subscriber's `rfed.delivery` destination hash is precomputed at
 *     subscribe time (used for live-fanout addressing and presence matching).
 *
 * `owner_node_hash` tags backup-failover entries (SPEC §11, Phase 6): set by
 * `/rfed/backup/push`, suppressed at fanout while the owner is reachable, and
 * served via the deferred queue + `/rfed/pull` (no subscriber identity is held
 * for backup entries — the owner pushed only the hashes).
 */

import { DestType } from "../core/packet.js";
import { toHex } from "../utils/encoding.js";

/** rfed app name + delivery aspect, used to compute the subscriber's inbox hash. */
const APP_NAME = "rfed";
const DELIVERY_ASPECT = "delivery";

/**
 * @typedef {Object} SubscriptionEntry
 * @property {Uint8Array} subscriberHash - 16-byte subscriber identity hash.
 * @property {Uint8Array} channelHash - 16-byte channel identity hash.
 * @property {import("../core/identity.js").Identity|null} identity - Subscriber's
 *   full Identity (kept so fanout can build its `rfed.delivery` destination).
 *   `null` for backup entries (Phase 6) — no identity is available.
 * @property {Uint8Array|null} deliveryHash - Subscriber's `rfed.delivery`
 *   destination hash (precomputed). `null` for backup entries.
 * @property {number} added - Unix timestamp (seconds).
 * @property {Uint8Array|null} ownerNodeHash - Backup-failover owner (Phase 6).
 * @property {number} lastRefreshed - Unix timestamp (seconds).
 */

/**
 * In-memory subscription table.
 *
 * On-disk persistence (msgpack `subscriptions.rmp`, hashes only) is a
 * `@reticulum/node` concern; this in-memory form keeps the full identity so
 * fanout works without an `Identity::recall` round-trip.
 */
export class SubscriptionTable {
  constructor() {
    /** @type {SubscriptionEntry[]} */
    this._entries = [];
  }

  /** Number of subscriptions. */
  get length() {
    return this._entries.length;
  }

  /**
   * Registers `(subscriberIdentity, channelHash)`. Idempotent.
   *
   * @param {import("../core/identity.js").Identity} subscriberIdentity
   * @param {Uint8Array} channelHash
   * @returns {Promise<SubscriptionEntry>}
   */
  async subscribe(subscriberIdentity, channelHash) {
    const existing = this._find(subscriberIdentity.identityHash, channelHash);
    if (existing) return existing;

    const { Destination } = await import("../core/destination.js");
    const deliveryDest = await Destination.OUT(
      `${APP_NAME}.${DELIVERY_ASPECT}`,
      DestType.SINGLE,
      subscriberIdentity,
    );
    const now = Date.now() / 1000;
    /** @type {SubscriptionEntry} */
    const entry = {
      subscriberHash: new Uint8Array(subscriberIdentity.identityHash),
      channelHash: new Uint8Array(channelHash),
      identity: subscriberIdentity,
      deliveryHash: /** @type {Uint8Array} */ (deliveryDest.destinationHash),
      added: now,
      ownerNodeHash: null,
      lastRefreshed: now,
    };
    this._entries.push(entry);
    return entry;
  }

  /**
   * Removes `(subscriberIdentity, channelHash)`.
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @returns {boolean} true if a subscription was removed.
   */
  unsubscribe(subscriberHash, channelHash) {
    const before = this._entries.length;
    this._entries = this._entries.filter(
      (e) =>
        !(
          toHex(e.subscriberHash) === toHex(subscriberHash) &&
          toHex(e.channelHash) === toHex(channelHash)
        ),
    );
    return this._entries.length !== before;
  }

  /**
   * All subscription entries for a channel (each carries the subscriber
   * identity + delivery hash needed by fanout).
   * @param {Uint8Array} channelHash
   * @returns {SubscriptionEntry[]}
   */
  subscribersFor(channelHash) {
    const want = toHex(channelHash);
    return this._entries.filter((e) => toHex(e.channelHash) === want);
  }

  /**
   * Finds the subscription entry whose `rfed.delivery` hash matches, if any
   * (used to resolve an incoming announce to a subscriber).
   * @param {Uint8Array} deliveryHash
   * @returns {SubscriptionEntry|null}
   */
  entryForDeliveryHash(deliveryHash) {
    const want = toHex(deliveryHash);
    return (
      this._entries.find(
        (e) => e.deliveryHash != null && toHex(e.deliveryHash) === want,
      ) ?? null
    );
  }

  /**
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @returns {boolean}
   */
  isSubscribed(subscriberHash, channelHash) {
    return this._find(subscriberHash, channelHash) != null;
  }

  /**
   * @param {Uint8Array} subscriberHash
   * @returns {Uint8Array[]}
   */
  channelsFor(subscriberHash) {
    const want = toHex(subscriberHash);
    return this._entries
      .filter((e) => toHex(e.subscriberHash) === want)
      .map((e) => new Uint8Array(e.channelHash));
  }

  /** Distinct channel hashes with at least one subscriber. */
  subscribedChannelHashes() {
    /** @type {Map<string, Uint8Array>} */
    const seen = new Map();
    for (const e of this._entries)
      seen.set(toHex(e.channelHash), e.channelHash);
    return Array.from(seen.values());
  }

  /**
   * Registers or refreshes a **backup** subscription adopted from an owner
   * node (SPEC §11). Backup entries carry no subscriber identity (the owner
   * pushed only the hashes); they are served via the deferred queue +
   * `/rfed/pull`, never live fanout. If an identical `(sub, ch, owner)` entry
   * already exists, its `lastRefreshed` heartbeat is bumped (chain-of-custody
   * TTL). Mirrors Rust `subscribe_backup`.
   *
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @param {Uint8Array} ownerNodeHash - The owner's `rfed.node` destination hash.
   */
  subscribeBackup(subscriberHash, channelHash, ownerNodeHash) {
    const s = toHex(subscriberHash);
    const c = toHex(channelHash);
    const o = toHex(ownerNodeHash);
    const existing = this._entries.find(
      (e) =>
        toHex(e.subscriberHash) === s &&
        toHex(e.channelHash) === c &&
        e.ownerNodeHash != null &&
        toHex(e.ownerNodeHash) === o,
    );
    if (existing) {
      existing.lastRefreshed = Date.now() / 1000;
      return;
    }
    const now = Date.now() / 1000;
    this._entries.push({
      subscriberHash: new Uint8Array(subscriberHash),
      channelHash: new Uint8Array(channelHash),
      identity: null,
      deliveryHash: null,
      added: now,
      ownerNodeHash: new Uint8Array(ownerNodeHash),
      lastRefreshed: now,
    });
  }

  /**
   * Every backup entry held by this node, as
   * `{ subscriberHash, channelHash, ownerNodeHash }`. Used by the failover
   * tick to scan for offline owners. Mirrors Rust `backup_entries_for_tick`.
   *
   * @returns {Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array, ownerNodeHash: Uint8Array }>}
   */
  backupEntriesForTick() {
    /** @type {Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array, ownerNodeHash: Uint8Array }>} */
    const out = [];
    for (const e of this._entries) {
      if (e.ownerNodeHash) {
        out.push({
          subscriberHash: new Uint8Array(e.subscriberHash),
          channelHash: new Uint8Array(e.channelHash),
          ownerNodeHash: new Uint8Array(e.ownerNodeHash),
        });
      }
    }
    return out;
  }

  /**
   * Removes backup entries whose `lastRefreshed` is older than `maxAgeSecs`.
   * Primary entries (no owner) are always kept. This is the passive chain
   * unravel: when an upstream custodian stops re-pushing (owner recovered),
   * entries expire naturally. Mirrors Rust `prune_stale_backups`.
   *
   * @param {number} maxAgeSecs
   * @returns {number} pruned count
   */
  pruneStaleBackups(maxAgeSecs) {
    const cutoff = Date.now() / 1000 - maxAgeSecs;
    const before = this._entries.length;
    this._entries = this._entries.filter(
      (e) => e.ownerNodeHash == null || e.lastRefreshed >= cutoff,
    );
    return before - this._entries.length;
  }

  /**
   * Exports all subscriptions as serializable records (the subscriber identity
   * is serialized as its 64-byte public key; the `Identity` object is rebuilt
   * on import). Used by the `@reticulum/node` FS adapter.
   *
   * @returns {Promise<Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array, pubkey: Uint8Array, deliveryHash: Uint8Array, added: number, lastRefreshed: number }>>}
   */
  async exportRecords() {
    /** @type {any[]} */
    const out = [];
    for (const e of this._entries) {
      // Backup entries have no subscriber identity (owner pushed only hashes).
      const pubkey = e.identity ? await e.identity.getPublicKey() : null;
      out.push({
        subscriberHash: new Uint8Array(e.subscriberHash),
        channelHash: new Uint8Array(e.channelHash),
        pubkey: pubkey ? new Uint8Array(pubkey) : null,
        deliveryHash: e.deliveryHash ? new Uint8Array(e.deliveryHash) : null,
        added: e.added,
        lastRefreshed: e.lastRefreshed,
        ownerNodeHash: e.ownerNodeHash ? new Uint8Array(e.ownerNodeHash) : null,
      });
    }
    return out;
  }

  /**
   * Replaces the table with the given records (rebuilt identities from their
   * public keys). Used on load.
   *
   * @param {Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array, pubkey: Uint8Array|null, deliveryHash: Uint8Array|null, added: number, lastRefreshed: number, ownerNodeHash: Uint8Array|null }>} records
   */
  async importRecords(records) {
    const { Identity } = await import("../core/identity.js");
    this._entries = [];
    for (const r of records) {
      // Primary entries carry a pubkey (rebuild the identity); backup entries
      // (ownerNodeHash set, no pubkey) stay identity-less.
      let identity = null;
      let deliveryHash = null;
      if (r.pubkey) {
        identity = await Identity.fromPublicKey(r.pubkey);
        deliveryHash = r.deliveryHash ? new Uint8Array(r.deliveryHash) : null;
      }
      this._entries.push({
        subscriberHash: new Uint8Array(r.subscriberHash),
        channelHash: new Uint8Array(r.channelHash),
        identity,
        deliveryHash,
        added: r.added,
        ownerNodeHash: r.ownerNodeHash ? new Uint8Array(r.ownerNodeHash) : null,
        lastRefreshed: r.lastRefreshed,
      });
    }
  }

  /**
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @returns {SubscriptionEntry|undefined}
   * @private
   */
  _find(subscriberHash, channelHash) {
    const s = toHex(subscriberHash);
    const c = toHex(channelHash);
    return this._entries.find(
      (e) => toHex(e.subscriberHash) === s && toHex(e.channelHash) === c,
    );
  }
}
