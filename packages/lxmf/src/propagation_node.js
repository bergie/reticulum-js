/**
 * @file propagation_node.js
 * @description Server side of the LXMF propagation protocol (§5.3): a node that
 *   stores propagated messages and serves them to clients over the `/get`
 *   request exchange (`LXMRouter.message_get_request` / `lxmf_propagation`).
 *
 * This module holds the protocol logic (store + stamp validation + ingestion +
 * the `/get` request handler) decoupled from the transport, so it is unit-
 * testable. The owning {@link LXMRouter} wires it to the `lxmf.propagation`
 * destination's request handler and Resource-receive path.
 */

import { Destination, DestType, LogLevel, log, toHex } from "@reticulum/core";
import { buildPropagationNodeAppData } from "./announce_data.js";
import {
  APP_NAME,
  MAX_INBOUND_SYNCS,
  PEER_ERROR_INVALID_DATA,
  PEER_ERROR_INVALID_KEY,
  PEER_ERROR_NO_ACCESS,
  PEER_ERROR_NO_IDENTITY,
  PEER_ERROR_THROTTLED,
  PEERING_COST,
  PN_STAMP_THROTTLE_SECS,
  PROCESSED_PRUNE_INTERVAL_SECS,
  PROCESSED_TID_TTL_SECS,
  PROPAGATION_COST,
  PROPAGATION_COST_FLEX,
  PROPAGATION_LIMIT,
  SYNC_LIMIT,
} from "./constants.js";
import { Message } from "./message.js";
import { MessageStore } from "./message_store.js";
import { validatePeeringKey, validatePnStamps } from "./stamper.js";

const DESTINATION_LENGTH = 16;

/**
 * @typedef {Object} PropagationNodeOptions
 * @property {number} [stampCost] Required propagation stamp cost.
 * @property {number} [stampCostFlexibility] Stamp cost flexibility.
 * @property {number} [perTransferLimitKb] Per-transfer limit (KB) advertised.
 * @property {number} [perSyncLimitKb] Per-sync limit (KB) advertised.
 * @property {number} [peeringCost] Peering cost advertised.
 * @property {string|null} [name] Operator node name (announce metadata).
 * @property {boolean} [nodeState] Whether this node is actively serving.
 * @property {number|null} [storageLimitBytes] Stored-message byte cap; when
 *   set, the highest-weight entries are evicted to stay under it.
 *   `null` = unlimited.
 * @property {number|null} [messageTtlSecs] Stored-message age TTL; entries
 *   older than this are pruned by {@link PropagationNode#tickMaintenance}.
 *   `null` = no age TTL (default; the Python reference relies on the byte cap).
 * @property {import("./message_store.js").MessageStore} [store] Pre-built store
 *   to adopt (e.g. loaded from disk by a runner) instead of a fresh one.
 * @property {(identity: import("@reticulum/core").Identity) => boolean} [identityAllowed]
 *   Access control; defaults to allow all (open node).
 * @property {() => Uint8Array} [getLocalIdentityHash]
 *   Returns this node's own 16-byte identity hash, used to build the peering_id
 *   for `/offer` peering-key validation.
 * @property {(destinationHash: Uint8Array) => (import("@reticulum/core").Destination|null)} [getDeliveryDestination]
 *   Resolves a recipient hash to the local inbound `lxmf.delivery` destination,
 *   for local delivery of messages addressed to this node's own identities.
 *   Returns null when the recipient is not local.
 * @property {(message: Message, transientId: Uint8Array) => void|Promise<void>} [onLocalDelivery]
 * @property {number} [maxInboundSyncs=3] Cap on concurrent inbound peer-sync
 *   transfers; `/offer` replies `ERROR_THROTTLED` beyond it (Python
 *   `MAX_INBOUND_SYNCS`).
 * @property {number} [stampThrottleSecs=180] Throttle window for peers whose
 *   batches contained invalid stamps, and the postponement the
 *   `ERROR_THROTTLED` reply asks of the peer (Python `PN_STAMP_THROTTLE`).
 * @property {boolean} [sequentialValidation=true] Only one stamp batch may
 *   validate at a time; offers arriving during a validation are refused with
 *   `ERROR_THROTTLED` (Python `propagation_sequential_validation`).
 * @property {Uint8Array[]} [staticPeerHashes] Peered node destination hashes
 *   that bypass the validation and inbound-sync gates (Python
 *   `static_peers` + `static_peers_bypass_sequential`).
 *   Invoked when a propagated message addressed to a local identity decrypts.
 * @property {(storedIds: Uint8Array[]) => void} [onStored]
 *   Invoked with the transient_ids newly stored by {@link ingestBlobs}. The
 *   owning router uses this to queue the messages for distribution to peered
 *   propagation nodes (`flush_peer_distribution_queue`), so the peer-mesh sync
 *   offers them on its next pass. Wiring it here (rather than at each call
 *   site) guarantees that every ingest path — link Resources, in-process
 *   embedded-node submits, paper-message ingestion — distributes identically.
 */

/**
 * Server-side propagation logic. Owns the {@link MessageStore} and implements
 * the `/get` request-response exchange and the ingestion of submitted blobs.
 */
export class PropagationNode {
  /**
   * @param {PropagationNodeOptions} [options]
   */
  constructor(options = {}) {
    /** @type {MessageStore} */
    this.store =
      options.store ??
      new MessageStore({
        storageLimitBytes: options.storageLimitBytes ?? null,
        messageTtlSecs: options.messageTtlSecs ?? null,
      });
    this.stampCost = options.stampCost ?? PROPAGATION_COST;
    this.stampCostFlexibility =
      options.stampCostFlexibility ?? PROPAGATION_COST_FLEX;
    this.perTransferLimitKb = options.perTransferLimitKb ?? PROPAGATION_LIMIT;
    this.perSyncLimitKb = options.perSyncLimitKb ?? SYNC_LIMIT;
    this.peeringCost = options.peeringCost ?? PEERING_COST;
    /**
     * Cap on concurrent inbound peer-sync transfers (Python
     * `MAX_INBOUND_SYNCS`, lxmd default 3). Offers arriving while this many
     * sync transfers are in flight are refused with `ERROR_THROTTLED`;
     * the throttled peer postpones its next sync by `stampThrottleSecs`.
     * @type {number}
     */
    this.maxInboundSyncs = options.maxInboundSyncs ?? MAX_INBOUND_SYNCS;
    /**
     * Throttle window (seconds) applied to peers whose transferred batches
     * contained invalid stamps, and the postponement the `ERROR_THROTTLED`
     * reply asks of the peer (Python `PN_STAMP_THROTTLE`).
     * @type {number}
     */
    this.stampThrottleSecs =
      options.stampThrottleSecs ?? PN_STAMP_THROTTLE_SECS;
    /**
     * Whether only one stamp batch may validate at a time — offers arriving
     * during a validation are refused with `ERROR_THROTTLED` (Python
     * `propagation_sequential_validation`, lxmd default on). Static peers
     * listed in `staticPeerHashes` bypass the gates.
     * @type {boolean}
     */
    this.sequentialValidation = options.sequentialValidation ?? true;
    /**
     * Peered node destination hashes (hex) that bypass the sequential
     * validation and inbound-sync gates (Python `static_peers` +
     * `static_peers_bypass_sequential`).
     * @type {Set<string>}
     */
    this.staticPeerHashes = new Set(
      (options.staticPeerHashes ?? []).map((h) => toHex(h)),
    );
    /** hex(identityHash) → throttle-until epoch seconds (invalid-stamp bans). */
    this.throttledPeers = new Map();
    /** hex(resource hash) → in-flight inbound peer-sync transfers. */
    this.inboundSyncs = new Map();
    /** Number of stamp batches currently validating. */
    this.validatingCount = 0;
    this.name = options.name ?? null;
    this.nodeState = options.nodeState ?? true;
    this.identityAllowed = options.identityAllowed ?? (() => true);
    this.getDeliveryDestination =
      options.getDeliveryDestination ?? (() => null);
    this.onLocalDelivery = options.onLocalDelivery ?? (() => {});
    this.onStored = options.onStored ?? (() => {});
    this.getLocalIdentityHash =
      options.getLocalIdentityHash ?? (() => new Uint8Array(0));

    /**
     * hex(transientId) already processed (dedup) → epoch seconds. TTL-pruned
     * (see {@link tickMaintenance}) so the set cannot grow without bound on
     * long-running nodes.
     * @type {Map<string, number>}
     */
    this.locallyProcessed = new Map();
    /** hex(transientId) delivered to a local identity → epoch seconds. */
    this.locallyDelivered = new Map();
    /** Epoch seconds of the last dedup-cache prune (0 = due immediately). */
    this._lastDedupPrune = 0;
  }

  /** Minimum accepted stamp value = max(0, cost − flexibility). */
  minAcceptedCost() {
    return Math.max(0, this.stampCost - this.stampCostFlexibility);
  }

  /**
   * Marks an inbound peer-sync transfer as in flight (Python
   * `propagation_resources_transferring`). The owning router calls this when
   * a transfer born of an accepted offer begins, and {@link endInboundSync}
   * when it concludes. While {@link maxInboundSyncs} transfers are in
   * flight, `/offer` replies `ERROR_THROTTLED`.
   * @param {string} key hex(resource hash)
   * @returns {void}
   */
  beginInboundSync(key) {
    this.inboundSyncs.set(key, Date.now() / 1000);
  }

  /**
   * Marks an inbound peer-sync transfer concluded.
   * @param {string} key hex(resource hash)
   * @returns {void}
   */
  endInboundSync(key) {
    this.inboundSyncs.delete(key);
  }

  /**
   * Throttles a peer identity for {@link stampThrottleSecs} — used when a
   * transferred batch contained invalid stamps (Python `throttled_peers`).
   * @param {string} remoteHex hex(identityHash) of the offender
   * @returns {void}
   */
  throttlePeer(remoteHex) {
    this.throttledPeers.set(
      remoteHex,
      Date.now() / 1000 + this.stampThrottleSecs,
    );
  }

  /**
   * Builds the `lxmf.propagation` announce app_data advertising this node's
   * limits and costs (LXMRouter.get_propagation_node_app_data).
   *
   * @param {number} [timebase] Unix seconds; defaults to now.
   * @returns {Uint8Array}
   */
  buildAnnounceAppData(timebase = Math.floor(Date.now() / 1000)) {
    return buildPropagationNodeAppData({
      timebase,
      nodeState: this.nodeState,
      perTransferLimitKb: this.perTransferLimitKb,
      perSyncLimitKb: this.perSyncLimitKb,
      stampCost: this.stampCost,
      stampCostFlexibility: this.stampCostFlexibility,
      peeringCost: this.peeringCost,
      name: this.name,
    });
  }

  /**
   * Periodic maintenance — prunes aged entries (when `messageTtlSecs` is set),
   * re-runs capacity eviction, and TTL-prunes the dedup caches. A runner
   * calls this hourly (the Python reference runs the same cull from its job
   * loop).
   *
   * @returns {{ aged: number, dedupPruned: number }}
   */
  tickMaintenance() {
    const { aged } = this.store.prune();
    const dedupPruned = this._pruneDedupCaches();
    return { aged, dedupPruned };
  }

  /**
   * Drops dedup-cache (locally processed / delivered) entries older than
   * {@link PROCESSED_TID_TTL_SECS} (the Python reference's `MESSAGE_EXPIRY *
   * 6` cleanup). Called from {@link tickMaintenance} and lazily from
   * {@link ingestBlobs}, so the caches stay bounded even without a driver.
   *
   * @param {number} [now] Epoch seconds; defaults to now.
   * @returns {number} count of pruned entries.
   */
  _pruneDedupCaches(now = Date.now() / 1000) {
    this._lastDedupPrune = now;
    let pruned = 0;
    for (const cache of [this.locallyProcessed, this.locallyDelivered]) {
      for (const [key, timestamp] of cache) {
        if (now > timestamp + PROCESSED_TID_TTL_SECS) {
          cache.delete(key);
          pruned++;
        }
      }
    }
    return pruned;
  }

  /**
   * Ingests a list of propagation blobs received in a submit/sync Resource
   * container (LXMRouter.propagation_resource_concluded → lxmf_propagation).
   *
   * Each blob is `lxmf_data || stamp`. Stamps are validated against the node's
   * minimum cost; survivors are deduplicated, then either locally delivered
   * (if addressed to one of this node's identities) or stored. Returns the
   * count of newly stored entries and the count of locally delivered entries.
   *
   * @param {Uint8Array[]} transientList
   * @returns {Promise<{stored: number, delivered: number, rejected: number, storedIds: Uint8Array[]}>}
   */
  async ingestBlobs(transientList) {
    const now = Date.now() / 1000;
    if (now - this._lastDedupPrune >= PROCESSED_PRUNE_INTERVAL_SECS) {
      this._pruneDedupCaches(now);
    }
    // Sequential validation (Python `propagation_sequential_validation`):
    // while a stamp batch is being validated, `/offer` replies THROTTLED to
    // other peers, so at most one batch's blobs are in memory for validation
    // at a time. Static peers bypass at the offer gate.
    this.validatingCount++;
    try {
      return await this._ingestBlobsInner(transientList);
    } finally {
      this.validatingCount--;
    }
  }

  /**
   * The body of {@link ingestBlobs}, run under the sequential-validation
   * counter.
   * @param {Uint8Array[]} transientList
   * @returns {Promise<{stored: number, delivered: number, rejected: number, storedIds: Uint8Array[]}>}
   * @private
   */
  async _ingestBlobsInner(transientList) {
    const now = Date.now() / 1000;
    const minCost = this.minAcceptedCost();
    const validated = await validatePnStamps(transientList, minCost);
    const rejected = transientList.length - validated.length;

    let stored = 0;
    let delivered = 0;
    /** @type {Uint8Array[]} */
    const storedIds = [];

    for (const v of validated) {
      const key = toHex(v.transientId);
      if (this.store.has(v.transientId) || this.locallyProcessed.has(key)) {
        continue;
      }
      this.locallyProcessed.set(key, now);

      const destinationHash = v.lxmfData.subarray(0, DESTINATION_LENGTH);
      const deliveryDest = this.getDeliveryDestination(destinationHash);
      if (deliveryDest) {
        const msg = await Message.fromPropagationData(v.lxmfData, deliveryDest);
        if (msg) {
          this.locallyDelivered.set(key, now);
          delivered++;
          await this.onLocalDelivery(msg, v.transientId);
          continue;
        }
        // Decryption failed: do not store (we cannot serve an opaque blob we
        // cannot read for a local destination). Fall through to skip.
        continue;
      }

      this.store.add({
        transientId: v.transientId,
        destinationHash: destinationHash.slice(),
        lxmfData: v.lxmfData.slice(),
        stampData: v.stampData.slice(),
        received: Date.now() / 1000,
        stampValue: v.stampValue,
        size: v.lxmfData.length + v.stampData.length,
        handledPeers: new Set(),
        unhandledPeers: new Set(),
      });
      storedIds.push(v.transientId.slice());
      stored++;
    }

    if (storedIds.length > 0) this.onStored(storedIds);

    return { stored, delivered, rejected, storedIds };
  }

  /**
   * Handles a `/get` REQUEST (LXMRouter.message_get_request).
   *
   * `data` is the decoded `[want, have]` or `[want, have, transferLimitKb]`:
   *   - `[null, null]` → list of available transient_ids for the requester.
   *   - `[wants[], haves[]]` → purge haves, return base lxmf_data for wants.
   *   - `[null, haves[]]` → purge-ack only (returns []).
   *
   * Returns a value to be msgpack-encoded as the response: an array of
   * transient_ids, an array of lxmf_data blobs, or a peer error code.
   *
   * @param {import("@reticulum/core").Identity|null} remoteIdentity
   * @param {any} data
   * @returns {Promise<Uint8Array[]|number>}
   */
  async handleGetRequest(remoteIdentity, data) {
    if (!remoteIdentity) return PEER_ERROR_NO_IDENTITY;
    if (!this.identityAllowed(remoteIdentity)) return PEER_ERROR_NO_ACCESS;
    if (!Array.isArray(data) || data.length < 2) return PEER_ERROR_INVALID_DATA;

    // The requester's lxmf.delivery destination hash identifies which stored
    // messages are theirs.
    const remoteDest = await Destination.OUT(
      APP_NAME + ".delivery",
      DestType.SINGLE,
      remoteIdentity,
      null,
    );
    const remoteHash = remoteDest.destinationHash;
    if (!remoteHash) return PEER_ERROR_INVALID_DATA;

    // Phase 1: message list.
    if (data[0] == null && data[1] == null) {
      return this.store.transientIdsForDestination(remoteHash);
    }

    // Phase 2: purge messages the client already has (owned by it).
    if (data[1] != null && Array.isArray(data[1]) && data[1].length > 0) {
      for (const tid of data[1]) {
        this.store.removeForDestination(tid, remoteHash);
      }
    }

    // Phase 3: serve requested messages (owned by it), honouring the client's
    // advertised transfer limit.
    if (data[0] != null && Array.isArray(data[0]) && data[0].length > 0) {
      const clientTransferLimitKb =
        data.length >= 3 && typeof data[2] === "number" ? data[2] : null;
      const out = [];
      let cumulative = 24; // initial structural overhead estimate
      for (const tid of data[0]) {
        const lxmfData = this.store.serveDataForDestination(tid, remoteHash);
        if (!lxmfData) continue;
        const next = cumulative + lxmfData.length + 16;
        if (
          clientTransferLimitKb != null &&
          next > clientTransferLimitKb * 1000
        ) {
          continue;
        }
        out.push(lxmfData);
        cumulative = next;
      }
      return out;
    }

    return [];
  }

  /**
   * Builds the `responseGenerator` for `registerRequestHandler("/get", …)`.
   * Adapts the Link handler signature to {@link handleGetRequest}.
   *
   * @returns {(path: string, data: any, requestId: Uint8Array, remoteIdentity: import("@reticulum/core").Identity|null, requestedAt: number) => Promise<Uint8Array[]|number>}
   */
  getRequestHandler() {
    return async (_path, data, _requestId, remoteIdentity) =>
      this.handleGetRequest(remoteIdentity, data);
  }

  /**
   * Handles a `/offer` REQUEST from a peering propagation node
   * (`LXMRouter.offer_request`).
   *
   * `data` is `[peering_key, [transient_id, …]]`. The peering key is validated
   * against `peering_id = receivingIdentityHash ‖ offeringIdentityHash` at this
   * node's own peering cost. The node then reports which offered messages it
   * does not yet have:
   *   - `false`  → it already has every offered message.
   *   - `true`   → it wants every offered message.
   *   - `[ids]`  → it wants exactly that subset.
   *
   * @param {import("@reticulum/core").Identity|null} remoteIdentity
   * @param {any} data
   * @returns {Promise<boolean|Uint8Array[]|number>} the offer response, or a
   *   peer-error code.
   */
  async handleOfferRequest(remoteIdentity, data, link = null) {
    if (!remoteIdentity) return PEER_ERROR_NO_IDENTITY;
    if (!this.identityAllowed(remoteIdentity)) return PEER_ERROR_NO_ACCESS;
    if (!Array.isArray(data) || data.length < 2) return PEER_ERROR_INVALID_DATA;

    // peering_id = receivingIdentity.hash ‖ offeringIdentity.hash (32 bytes).
    const localHash = this.getLocalIdentityHash();
    const remoteHash = remoteIdentity.identityHash;
    const peeringId = new Uint8Array(localHash.length + remoteHash.length);
    peeringId.set(localHash, 0);
    peeringId.set(remoteHash, localHash.length);

    const peeringKey = /** @type {Uint8Array} */ (data[0]);
    if (!(await validatePeeringKey(peeringId, peeringKey, this.peeringCost)))
      return PEER_ERROR_INVALID_KEY;

    // ── Admission control (Python LXMRouter.offer_request) ──
    // Static peers bypass the sequential-validation and inbound-sync gates.
    const remoteHex = toHex(remoteHash);
    const bypass = this.staticPeerHashes.has(remoteHex);
    const nowSecs = Date.now() / 1000;
    const throttleUntil = this.throttledPeers.get(remoteHex);
    if (throttleUntil !== undefined) {
      if (nowSecs < throttleUntil) return PEER_ERROR_THROTTLED;
      this.throttledPeers.delete(remoteHex);
    }
    if (!bypass) {
      if (this.sequentialValidation && this.validatingCount > 0) {
        log(
          "PropagationNode",
          `Offer postponed: already validating ${this.validatingCount} stamp batch(es)`,
        );
        return PEER_ERROR_THROTTLED;
      }
      if (
        this.maxInboundSyncs > 0 &&
        this.inboundSyncs.size >= this.maxInboundSyncs
      ) {
        log(
          "PropagationNode",
          `Offer postponed: ${this.inboundSyncs.size} sync transfer(s) already in flight`,
        );
        return PEER_ERROR_THROTTLED;
      }
    }

    /** @type {Uint8Array[]} */
    const offered = data[1];
    /** @type {Uint8Array[]} */
    const wanted = [];
    for (const tid of offered) {
      if (!this.store.has(tid)) wanted.push(tid);
    }
    if (wanted.length === 0) return false;
    // A wanted-list means a sync transfer will follow on this link: flag it
    // so the router counts it against the inbound-sync admission cap.
    if (link) /** @type {any} */ (link)._rfedInboundSync = true;
    if (wanted.length === offered.length) return true;
    return wanted;
  }

  /**
   * Builds the `responseGenerator` for `registerRequestHandler("/offer", …)`.
   * @returns {function(string, any, Uint8Array, import("@reticulum/core").Identity|null, number, import("@reticulum/core").Link): Promise<boolean|Uint8Array[]|number>} The §11 response generator.
   */
  getOfferRequestHandler() {
    return async (
      /** @type {string} */ _path,
      /** @type {any} */ data,
      /** @type {Uint8Array} */ _requestId,
      /** @type {import("@reticulum/core").Identity|null} */ remoteIdentity,
      /** @type {number} */ _requestedAt,
      /** @type {any} */ link,
    ) => this.handleOfferRequest(remoteIdentity, data, link);
  }
}
