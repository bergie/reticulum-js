/**
 * @file blob_store.js
 * @description In-memory rfed blob store (work doc #25, Phase 2).
 *
 * Mirrors the Rust `rfed::blob_store::BlobStore` API and semantics: blobs are
 * keyed by a random 16-byte `message_id` and tagged with their 16-byte channel
 * (`destination_hash`). The store is the **sync-side** backing — it is written
 * on every SEND ingest and read by the peer-sync engine (Phase 4). Client
 * delivery (fanout / deferred pull) does NOT read from here.
 *
 * Eviction mirrors the Rust node: a 30-day TTL checked at most once per hour,
 * and oldest-first capacity eviction when `storageLimitBytes` would be
 * exceeded.
 *
 * This is the pure, in-memory, web-platform implementation. A filesystem-backed
 * adapter (`blobs/<ch_hex>/<id_hex>`) lives in `@reticulum/node` for production
 * deployments; the interface here is what both satisfy.
 */

import { Identity } from "../core/identity.js";
import { toHex } from "../utils/encoding.js";

/** Evict blobs older than this (seconds). SPEC §5: 30 days. */
const BLOB_TTL_SECS = 30 * 24 * 3600;
/** Re-run the TTL sweep at most this often (seconds). */
const EVICT_CHECK_INTERVAL_SECS = 3600;

/** Default in-memory capacity (SPEC §5: 2 GB). */
const DEFAULT_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * @typedef {Object} BlobMeta
 * @property {Uint8Array} messageId - 16-byte random id (the store key).
 * @property {Uint8Array} destinationHash - 16-byte channel hash.
 * @property {number} received - Unix timestamp (seconds) of ingest.
 * @property {number} size - Byte length of the blob.
 */

/**
 * In-memory blob store. Implements the same surface as the Rust
 * `BlobStore` so a filesystem adapter can drop in for production use.
 */
export class BlobStore {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.storageLimitBytes] Capacity cap; defaults to 2 GiB.
   */
  constructor({ storageLimitBytes = DEFAULT_STORAGE_LIMIT_BYTES } = {}) {
    /** @type {Map<string, Uint8Array>} hex(messageId) → raw blob bytes. */
    this._blobs = new Map();
    /** @type {Map<string, BlobMeta>} hex(messageId) → metadata. */
    this._meta = new Map();
    this.storageLimitBytes = storageLimitBytes;
    this.usedBytes = 0;
    this._lastEviction = 0;
  }

  /**
   * Stores a blob under a fresh random 16-byte message id.
   *
   * @param {Uint8Array} destinationHash - 16-byte channel hash.
   * @param {Uint8Array} blob - Raw inner blob (stamp already stripped).
   * @returns {Uint8Array} the assigned 16-byte message id.
   */
  store(destinationHash, blob) {
    return this.storeWithId(destinationHash, Identity.getRandomHash(), blob);
  }

  /**
   * Stores a blob under a caller-supplied message id. Idempotent when the same
   * `(messageId, destinationHash)` pair is stored again (used by peer sync to
   * preserve upstream ids); collides otherwise.
   *
   * @param {Uint8Array} destinationHash
   * @param {Uint8Array} messageId
   * @param {Uint8Array} blob
   * @returns {Uint8Array} the message id.
   * @throws {Error} if `messageId` is already stored under a different channel.
   */
  storeWithId(destinationHash, messageId, blob) {
    const key = toHex(messageId);
    const existing = this._meta.get(key);
    if (existing) {
      if (toHex(existing.destinationHash) !== toHex(destinationHash)) {
        throw new Error(`blob message-id collision for ${key}`);
      }
      return existing.messageId;
    }

    const now = Date.now() / 1000;
    // Periodic TTL sweep (at most once per interval).
    if (now - this._lastEviction > EVICT_CHECK_INTERVAL_SECS) {
      this._evictOlderThan(now - BLOB_TTL_SECS);
      this._lastEviction = now;
    }
    // Capacity eviction to make room.
    this._evictToFit(blob.length);

    this._blobs.set(key, new Uint8Array(blob));
    /** @type {BlobMeta} */
    const meta = {
      messageId: new Uint8Array(messageId),
      destinationHash: new Uint8Array(destinationHash),
      received: now,
      size: blob.length,
    };
    this._meta.set(key, meta);
    this.usedBytes += blob.length;
    return meta.messageId;
  }

  /**
   * Reads a blob by message id.
   * @param {Uint8Array} messageId
   * @returns {Uint8Array|null}
   */
  get(messageId) {
    return this._blobs.get(toHex(messageId)) ?? null;
  }

  /** All known message ids (sync manifest source). */
  allMessageIds() {
    return Array.from(this._meta.values(), (m) => new Uint8Array(m.messageId));
  }

  /**
   * All message ids stored under the given channel hash.
   * @param {Uint8Array} channelHash
   * @returns {Uint8Array[]}
   */
  messageIdsForChannel(channelHash) {
    const want = toHex(channelHash);
    /** @type {Uint8Array[]} */
    const out = [];
    for (const m of this._meta.values()) {
      if (toHex(m.destinationHash) === want) out.push(new Uint8Array(m.messageId));
    }
    return out;
  }

  /**
   * Deletes a blob by message id.
   * @param {Uint8Array} messageId
   * @returns {boolean} true if a blob was removed.
   */
  delete(messageId) {
    const key = toHex(messageId);
    const meta = this._meta.get(key);
    if (!meta) return false;
    this._meta.delete(key);
    this._blobs.delete(key);
    this.usedBytes -= meta.size;
    return true;
  }

  /** Number of stored blobs. */
  get length() {
    return this._meta.size;
  }

  /**
   * Evicts every blob whose `received` timestamp predates `cutoff`.
   * @param {number} cutoff - Unix seconds.
   * @returns {number} count evicted.
   */
  _evictOlderThan(cutoff) {
    let count = 0;
    for (const m of Array.from(this._meta.values())) {
      if (m.received > 0 && m.received < cutoff) {
        this.delete(m.messageId);
        count++;
      }
    }
    return count;
  }

  /**
   * Evicts the oldest blobs (by `received`) until `neededBytes` fit under the
   * capacity limit.
   * @param {number} neededBytes
   */
  _evictToFit(neededBytes) {
    if (this.usedBytes + neededBytes <= this.storageLimitBytes) return;
    const ordered = Array.from(this._meta.values()).sort((a, b) => a.received - b.received);
    for (const m of ordered) {
      if (this.usedBytes + neededBytes <= this.storageLimitBytes) break;
      this.delete(m.messageId);
    }
  }
}
