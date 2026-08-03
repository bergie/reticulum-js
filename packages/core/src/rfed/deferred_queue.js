/**
 * @file deferred_queue.js
 * @description In-memory rfed deferred delivery queue (work doc #25, Phase 2).
 *
 * When a subscriber is unreachable during fanout, its inner blob is held here,
 * keyed by subscriber hash, and flushed when the subscriber announces its
 * `rfed.delivery` (SPEC §7 trigger 1) or via an explicit `/rfed/pull`
 * (trigger 2).
 *
 * Mirrors the Rust `rfed::deferred_queue::DeferredQueue` paging contract:
 *   - `drainChannelBatch(sub, chan, max)` removes at most `max` channel-matching
 *     blobs, FIFO, leaving non-matching blobs in order;
 *   - `hasPendingChannel(sub, chan)` is the `more_pending` flag the pull handler
 *     returns;
 *   - per-subscriber overflow drops the oldest; the global cap back-pressures.
 *
 * On-disk persistence (msgpack `deferred_delivery.rmp`) is a `@reticulum/node`
 * concern; this in-memory form satisfies Phase 2.
 */

import { toHex } from "../utils/encoding.js";

/**
 * @typedef {Object} PendingBlob
 * @property {Uint8Array} channelHash - 16-byte channel hash (for re-addressing).
 * @property {Uint8Array} blob - Raw inner blob (stamp already stripped).
 * @property {number} enqueuedAt - Unix timestamp (seconds).
 */

/** Hard cap on total entries across all subscribers (SPEC §7: 4096). */
const DEFAULT_GLOBAL_LIMIT = 4096;

/**
 * In-memory deferred delivery queue.
 */
export class DeferredQueue {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.globalLimit] Total entry cap across all subscribers.
   */
  constructor({ globalLimit = DEFAULT_GLOBAL_LIMIT } = {}) {
    /** @type {Map<string, PendingBlob[]>} hex(subscriberHash) → FIFO bucket. */
    this._buckets = new Map();
    this.globalLimit = globalLimit;
  }

  /** Total entries across all subscribers. */
  totalLen() {
    let n = 0;
    for (const bucket of this._buckets.values()) n += bucket.length;
    return n;
  }

  /**
   * Enqueues a blob for an unreachable subscriber.
   *
   * Per-subscriber overflow drops the oldest; the global cap back-pressures
   * (the enqueue is silently skipped).
   *
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @param {Uint8Array} blob
   * @param {number} perSubscriberLimit
   */
  enqueue(subscriberHash, channelHash, blob, perSubscriberLimit) {
    if (this.totalLen() >= this.globalLimit) return;

    const key = toHex(subscriberHash);
    const bucket = this._buckets.get(key) ?? [];
    if (bucket.length >= perSubscriberLimit) bucket.shift();
    bucket.push({
      channelHash: new Uint8Array(channelHash),
      blob: new Uint8Array(blob),
      enqueuedAt: Date.now() / 1000,
    });
    this._buckets.set(key, bucket);
  }

  /**
   * Drains and returns all pending blobs for a subscriber (FIFO).
   * @param {Uint8Array} subscriberHash
   * @returns {PendingBlob[]}
   */
  drain(subscriberHash) {
    const key = toHex(subscriberHash);
    const bucket = this._buckets.get(key);
    if (!bucket) return [];
    this._buckets.delete(key);
    return bucket;
  }

  /**
   * Drains at most `max` blobs for a subscriber (FIFO), leaving any remainder.
   * @param {Uint8Array} subscriberHash
   * @param {number} max
   * @returns {PendingBlob[]}
   */
  drainBatch(subscriberHash, max) {
    if (max <= 0) return [];
    const key = toHex(subscriberHash);
    const bucket = this._buckets.get(key);
    if (!bucket) return [];
    const page = bucket.splice(0, max);
    if (bucket.length === 0) this._buckets.delete(key);
    return page;
  }

  /**
   * Drains at most `max` blobs for `(subscriber, channel)` (FIFO). Non-matching
   * blobs stay queued in their original relative order. This is the
   * `/rfed/pull` paging primitive.
   *
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @param {number} max
   * @returns {PendingBlob[]}
   */
  drainChannelBatch(subscriberHash, channelHash, max) {
    const key = toHex(subscriberHash);
    const bucket = this._buckets.get(key);
    if (!bucket) return [];
    const want = toHex(channelHash);
    /** @type {PendingBlob[]} */
    const removed = [];
    /** @type {PendingBlob[]} */
    const kept = [];
    for (const entry of bucket) {
      if (removed.length < max && toHex(entry.channelHash) === want) {
        removed.push(entry);
      } else {
        kept.push(entry);
      }
    }
    if (kept.length === 0) this._buckets.delete(key);
    else this._buckets.set(key, kept);
    return removed;
  }

  /**
   * @param {Uint8Array} subscriberHash
   * @returns {boolean}
   */
  hasPending(subscriberHash) {
    const bucket = this._buckets.get(toHex(subscriberHash));
    return !!bucket && bucket.length > 0;
  }

  /**
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array} channelHash
   * @returns {boolean}
   */
  hasPendingChannel(subscriberHash, channelHash) {
    const bucket = this._buckets.get(toHex(subscriberHash));
    if (!bucket) return false;
    const want = toHex(channelHash);
    return bucket.some((e) => toHex(e.channelHash) === want);
  }

  /**
   * Drops entries older than `maxAgeSec` (SPEC §7: 7-day periodic prune).
   * @param {number} maxAgeSec
   * @returns {number} count evicted.
   */
  evictExpired(maxAgeSec) {
    const threshold = Date.now() / 1000 - maxAgeSec;
    let count = 0;
    for (const [key, bucket] of this._buckets) {
      /** @type {PendingBlob[]} */
      const kept = [];
      for (const e of bucket) {
        if (e.enqueuedAt >= threshold) kept.push(e);
        else count++;
      }
      if (kept.length === 0) this._buckets.delete(key);
      else this._buckets.set(key, kept);
    }
    return count;
  }
}
