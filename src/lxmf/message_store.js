/**
 * @file message_store.js
 * @description In-memory store for propagated LXMF messages on a propagation
 *   node (`LXMRouter.propagation_entries` in the Python reference).
 *
 * Entries are keyed by `transient_id = SHA-256(lxmf_data)` and serve the
 * client `/get` exchange (`LXMRouter.message_get_request`): list available
 * transient_ids for a recipient, fetch their base `lxmf_data`, and purge
 * acknowledged ones. All ownership checks (a client may only touch messages
 * addressed to it) mirror the Python `message_entry[0] == remote_hash` filter.
 */

import { toHex } from "../utils/encoding.js";

/**
 * A stored propagated message.
 *
 * @typedef {Object} PropagationEntry
 * @property {Uint8Array} transientId SHA-256(lxmfData) — the dedup/store key.
 * @property {Uint8Array} destinationHash Recipient `lxmf.delivery` hash (16B).
 * @property {Uint8Array} lxmfData Base propagation form (stamp stripped).
 * @property {Uint8Array} stampData The trailing 32-byte stamp, preserved.
 * @property {number} received Unix seconds when stored.
 * @property {number} stampValue Stamp proof-of-work value.
 * @property {number} size Stored byte size (lxmfData + stamp).
 * @property {Set<string>} handledPeers hex peer hashes that already hold this message.
 * @property {Set<string>} unhandledPeers hex peer hashes still needing this message.
 */

/** Seconds per 4-day age-weight unit (Python `get_weight`). */
const AGE_WEIGHT_UNIT = 60 * 60 * 24 * 4;

/**
 * Transfer weight used to order a sync offer (`LXMRouter.get_weight`):
 * `priority * max(1, age/4days) * size`, ascending. There is no prioritised
 * list yet, so priority is always 1.0.
 *
 * @param {PropagationEntry} entry
 * @returns {number}
 */
function weightOf(entry) {
  const ageWeight = Math.max(
    1,
    (Date.now() / 1000 - entry.received) / AGE_WEIGHT_UNIT,
  );
  return ageWeight * entry.size;
}

export class MessageStore {
  constructor() {
    /** @type {Map<string, PropagationEntry>} keyed by hex(transientId). */
    this._entries = new Map();
  }

  /** @returns {number} number of stored messages. */
  get size() {
    return this._entries.size;
  }

  /**
   * @param {Uint8Array} transientId
   * @returns {boolean}
   */
  has(transientId) {
    return this._entries.has(toHex(transientId));
  }

  /**
   * @param {Uint8Array} transientId
   * @returns {PropagationEntry|null}
   */
  get(transientId) {
    return this._entries.get(toHex(transientId)) ?? null;
  }

  /**
   * Adds an entry; no-op (returns false) if the transient_id is already known.
   *
   * @param {PropagationEntry} entry
   * @returns {boolean} true if inserted, false on duplicate.
   */
  add(entry) {
    const key = toHex(entry.transientId);
    if (this._entries.has(key)) return false;
    entry.handledPeers ??= new Set();
    entry.unhandledPeers ??= new Set();
    this._entries.set(key, entry);
    return true;
  }

  /**
   * Removes an entry unconditionally.
   *
   * @param {Uint8Array} transientId
   * @returns {boolean} true if an entry was removed.
   */
  remove(transientId) {
    return this._entries.delete(toHex(transientId));
  }

  /**
   * Removes an entry only if it is owned by `ownerHash` (a client may only
   * purge messages addressed to itself).
   *
   * @param {Uint8Array} transientId
   * @param {Uint8Array} ownerHash
   * @returns {boolean}
   */
  removeForDestination(transientId, ownerHash) {
    const entry = this.get(transientId);
    if (!entry) return false;
    if (toHex(entry.destinationHash) !== toHex(ownerHash)) return false;
    return this._entries.delete(toHex(transientId));
  }

  /**
   * Lists transient_ids addressed to `destinationHash`, sorted by stored size
   * ascending (matches `message_get_request`'s size-ascending list order).
   *
   * @param {Uint8Array} destinationHash
   * @returns {Uint8Array[]}
   */
  transientIdsForDestination(destinationHash) {
    const hex = toHex(destinationHash);
    /** @type {PropagationEntry[]} */
    const matching = [];
    for (const e of this._entries.values()) {
      if (toHex(e.destinationHash) === hex) matching.push(e);
    }
    matching.sort((a, b) => a.size - b.size);
    return matching.map((e) => e.transientId);
  }

  /**
   * Returns the base `lxmf_data` (stamp stripped) for serving, but only if the
   * entry exists and is owned by `ownerHash`.
   *
   * @param {Uint8Array} transientId
   * @param {Uint8Array} ownerHash
   * @returns {Uint8Array|null}
   */
  serveDataForDestination(transientId, ownerHash) {
    const entry = this.get(transientId);
    if (!entry) return null;
    if (toHex(entry.destinationHash) !== toHex(ownerHash)) return null;
    return entry.lxmfData;
  }

  /**
   * Marks a message as still needed by `peerHash` (unhandled for that peer).
   * Used when a new message is ingested and must be distributed to peers.
   *
   * @param {Uint8Array} transientId
   * @param {Uint8Array} peerHash
   * @returns {boolean}
   */
  markUnhandledForPeer(transientId, peerHash) {
    const entry = this.get(transientId);
    if (!entry) return false;
    const hex = toHex(peerHash);
    entry.unhandledPeers.add(hex);
    entry.handledPeers.delete(hex);
    return true;
  }

  /**
   * Marks a message as already held by `peerHash` (handled), removing it from
   * the peer's unhandled set (`LXMPeer.add_handled_message`).
   *
   * @param {Uint8Array} transientId
   * @param {Uint8Array} peerHash
   * @returns {boolean}
   */
  markHandledForPeer(transientId, peerHash) {
    const entry = this.get(transientId);
    if (!entry) return false;
    const hex = toHex(peerHash);
    entry.handledPeers.add(hex);
    entry.unhandledPeers.delete(hex);
    return true;
  }

  /**
   * Lists the unhandled messages for a peer, as
   * `{ transientId, weight, size, entry }` sorted by weight ascending
   * (`LXMPeer.sync` offer ordering). Entries whose stamp value is below
   * `minAcceptedCost` are excluded.
   *
   * @param {Uint8Array} peerHash
   * @param {number} [minAcceptedCost]
   * @returns {{transientId: Uint8Array, weight: number, size: number, entry: PropagationEntry}[]}
   */
  unhandledEntriesForPeer(peerHash, minAcceptedCost = 0) {
    const hex = toHex(peerHash);
    /** @type {{transientId: Uint8Array, weight: number, size: number, entry: PropagationEntry}[]} */
    const out = [];
    for (const e of this._entries.values()) {
      if (!e.unhandledPeers.has(hex)) continue;
      if (e.stampValue < minAcceptedCost) continue;
      out.push({
        transientId: e.transientId,
        weight: weightOf(e),
        size: e.size,
        entry: e,
      });
    }
    out.sort((a, b) => a.weight - b.weight);
    return out;
  }
}
