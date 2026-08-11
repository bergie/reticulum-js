/**
 * @file fed_sync.js
 * @description Federation peer tracking and sync scheduling (work doc #25, Phase 4).
 *
 * Mirrors Rust `rfed::sync` FedSync:
 * - Tracks federation peers (seen via rfed.node announces)
 * - Manages sync backoff timers
 * - Returns peers due for sync when tick() is called
 *
 * The main loop (or a runner) calls tickSync() periodically, then initiates
 * sync sessions for each returned peer hash using syncWithPeer().
 */

import { toHex } from "../utils/encoding.js";

/** Minimum sync backoff (seconds). */
const SYNC_BACKOFF_MIN = 10;
/** Maximum sync backoff (seconds). */
const SYNC_BACKOFF_MAX = 3600;

/**
 * State for a known federation peer.
 * @typedef {Object} FedPeer
 * @property {Uint8Array} destinationHash - 16-byte rfed.node destination hash
 * @property {boolean} alive - Whether the peer is currently reachable
 * @property {number} lastHeard - Unix timestamp when last announce was seen
 * @property {number} nextSyncAttempt - Unix timestamp when next sync is allowed
 * @property {number} lastSyncAttempt - Unix timestamp of last sync attempt
 * @property {number} syncBackoff - Current backoff (seconds, exponential)
 * @property {number|null} peeringCost - PoW cost peer advertises (from announce app_data)
 */

/**
 * Federation sync engine: tracks peers and schedules sync attempts.
 */
export class FedSync {
  /**
   * @param {Object} [options]
   * @property {number} [options.pruneAgeSecs] Age after which unseen peers are pruned (default 7200 = 2*SYNC_BACKOFF_MAX)
   * @property {Uint8Array[]} [options.staticPeers] Static peer hashes (never pruned)
   * @property {Uint8Array|null} [options.localNodeHash] This node's own rfed.node hash (for self-announce filtering)
   */
  constructor({
    pruneAgeSecs = 7200,
    staticPeers = [],
    localNodeHash = null,
  } = {}) {
    /** @type {Map<string, FedPeer>} */
    this.peers = new Map();
    this.pruneAgeSecs = pruneAgeSecs;
    this.staticPeers = staticPeers.map((h) => toHex(h));
    this.localNodeHash = localNodeHash ? toHex(localNodeHash) : null;
  }

  /**
   * Called when an rfed.node announce is seen. Creates or updates peer entry.
   *
   * @param {Uint8Array} destinationHash - 16-byte rfed.node destination hash
   * @param {number|null} peeringCost - PoW cost from announce app_data (optional)
   */
  peerHeard(destinationHash, peeringCost = null) {
    const hex = toHex(destinationHash);

    // Ignore self-announces
    if (this.localNodeHash === hex) return;

    // Only track static peers if configured
    if (this.staticPeers.length > 0 && !this.staticPeers.includes(hex)) return;

    const nowSec = Date.now() / 1000;
    let peer = this.peers.get(hex);

    if (!peer) {
      peer = {
        destinationHash: new Uint8Array(destinationHash),
        alive: false,
        lastHeard: 0,
        nextSyncAttempt: 0,
        lastSyncAttempt: 0,
        syncBackoff: SYNC_BACKOFF_MIN,
        peeringCost: null,
      };
      this.peers.set(hex, peer);
    }

    peer.alive = true;
    peer.lastHeard = nowSec;
    if (peeringCost !== null) {
      peer.peeringCost = peeringCost;
    }
    // Reset backoff on successful announce
    peer.syncBackoff = SYNC_BACKOFF_MIN;
    if (peer.nextSyncAttempt > nowSec + peer.syncBackoff) {
      peer.nextSyncAttempt = nowSec + 5;
    }
  }

  /**
   * Prunes peers not heard from within pruneAgeSecs (except static peers).
   * Returns count of pruned peers.
   *
   * @returns {number}
   */
  pruneStalePeers() {
    const nowSec = Date.now() / 1000;
    let pruned = 0;

    for (const [hex, peer] of this.peers.entries()) {
      // Never prune static peers
      if (this.staticPeers.includes(hex)) continue;

      if (peer.lastHeard < nowSec - this.pruneAgeSecs) {
        this.peers.delete(hex);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Returns a list of peer destination hashes that are due for sync.
   * Called periodically by the main loop/runner.
   *
   * @returns {Uint8Array[]}
   */
  tick() {
    // First, prune stale peers
    this.pruneStalePeers();

    const nowSec = Date.now() / 1000;
    const due = [];

    for (const [hex, peer] of this.peers.entries()) {
      if (peer.alive && peer.nextSyncAttempt <= nowSec) {
        due.push(new Uint8Array(peer.destinationHash));
      }
    }

    return due;
  }

  /**
   * Mark that a sync attempt has started for a peer.
   *
   * @param {Uint8Array} destinationHash
   */
  syncStarted(destinationHash) {
    const hex = toHex(destinationHash);
    const peer = this.peers.get(hex);
    if (peer) {
      peer.lastSyncAttempt = Date.now() / 1000;
    }
  }

  /**
   * Mark that a sync attempt succeeded for a peer (resets backoff).
   *
   * @param {Uint8Array} destinationHash
   */
  syncOk(destinationHash) {
    const hex = toHex(destinationHash);
    const peer = this.peers.get(hex);
    if (peer) {
      peer.syncBackoff = SYNC_BACKOFF_MIN;
      peer.lastSyncAttempt = Date.now() / 1000;
      peer.nextSyncAttempt = Date.now() / 1000 + peer.syncBackoff;
    }
  }

  /**
   * Mark that a sync attempt failed for a peer (increases backoff).
   *
   * @param {Uint8Array} destinationHash
   */
  syncErr(destinationHash) {
    const hex = toHex(destinationHash);
    const peer = this.peers.get(hex);
    if (peer) {
      peer.syncBackoff = Math.min(peer.syncBackoff * 2, SYNC_BACKOFF_MAX);
      peer.lastSyncAttempt = Date.now() / 1000;
      peer.nextSyncAttempt = Date.now() / 1000 + peer.syncBackoff;
    }
  }

  /**
   * Seed static peers as immediately-due sync targets.
   * Called once at startup.
   */
  seedStaticPeers() {
    const nowSec = Date.now() / 1000;
    for (const hash of this.staticPeers) {
      let peer = this.peers.get(hash);
      if (!peer) {
        const bytes = fromHex(hash);
        peer = {
          destinationHash: bytes,
          alive: true,
          lastHeard: 0,
          nextSyncAttempt: 0,
          lastSyncAttempt: 0,
          syncBackoff: SYNC_BACKOFF_MIN,
          peeringCost: null,
        };
        this.peers.set(hash, peer);
      }
      // Always reset to 0 so sync fires immediately on startup
      peer.nextSyncAttempt = 0;
      peer.syncBackoff = SYNC_BACKOFF_MIN;
      peer.alive = true;
    }
  }

  /**
   * Returns the number of known peers.
   */
  get peerCount() {
    return this.peers.size;
  }
}

/**
 * Hex string to Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
