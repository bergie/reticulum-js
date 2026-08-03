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
 * `owner_node_hash` is reserved for backup failover (Phase 6) — stored but not
 * yet acted on.
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
 * @property {import("../core/identity.js").Identity} identity - Subscriber's
 *   full Identity (kept so fanout can build its `rfed.delivery` destination).
 * @property {Uint8Array} deliveryHash - Subscriber's `rfed.delivery`
 *   destination hash (precomputed).
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
    const existing = this._find(
      subscriberIdentity.identityHash,
      channelHash,
    );
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
    return this._entries.find((e) => toHex(e.deliveryHash) === want) ?? null;
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
    for (const e of this._entries) seen.set(toHex(e.channelHash), e.channelHash);
    return Array.from(seen.values());
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
