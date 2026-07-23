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

import { Destination } from "../core/destination.js";
import { DestType } from "../core/packet.js";
import { toHex } from "../utils/encoding.js";
import { buildPropagationNodeAppData } from "./announce_data.js";
import {
  APP_NAME,
  PEER_ERROR_INVALID_DATA,
  PEER_ERROR_INVALID_KEY,
  PEER_ERROR_NO_ACCESS,
  PEER_ERROR_NO_IDENTITY,
  PEERING_COST,
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
 * @property {(identity: import("../core/identity.js").Identity) => boolean} [identityAllowed]
 *   Access control; defaults to allow all (open node).
 * @property {() => Uint8Array} [getLocalIdentityHash]
 *   Returns this node's own 16-byte identity hash, used to build the peering_id
 *   for `/offer` peering-key validation.
 * @property {(destinationHash: Uint8Array) => (import("../core/destination.js").Destination|null)} [getDeliveryDestination]
 *   Resolves a recipient hash to the local inbound `lxmf.delivery` destination,
 *   for local delivery of messages addressed to this node's own identities.
 *   Returns null when the recipient is not local.
 * @property {(message: Message, transientId: Uint8Array) => void|Promise<void>} [onLocalDelivery]
 *   Invoked when a propagated message addressed to a local identity decrypts.
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
    this.store = new MessageStore();
    this.stampCost = options.stampCost ?? PROPAGATION_COST;
    this.stampCostFlexibility =
      options.stampCostFlexibility ?? PROPAGATION_COST_FLEX;
    this.perTransferLimitKb = options.perTransferLimitKb ?? PROPAGATION_LIMIT;
    this.perSyncLimitKb = options.perSyncLimitKb ?? SYNC_LIMIT;
    this.peeringCost = options.peeringCost ?? PEERING_COST;
    this.name = options.name ?? null;
    this.nodeState = options.nodeState ?? true;
    this.identityAllowed = options.identityAllowed ?? (() => true);
    this.getDeliveryDestination =
      options.getDeliveryDestination ?? (() => null);
    this.onLocalDelivery = options.onLocalDelivery ?? (() => {});
    this.getLocalIdentityHash =
      options.getLocalIdentityHash ?? (() => new Uint8Array(0));

    /** @type {Set<string>} hex(transientId) already processed (dedup). */
    this.locallyProcessed = new Set();
    /** @type {Set<string>} hex(transientId) delivered to a local identity. */
    this.locallyDelivered = new Set();
  }

  /** Minimum accepted stamp value = max(0, cost − flexibility). */
  minAcceptedCost() {
    return Math.max(0, this.stampCost - this.stampCostFlexibility);
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
      this.locallyProcessed.add(key);

      const destinationHash = v.lxmfData.subarray(0, DESTINATION_LENGTH);
      const deliveryDest = this.getDeliveryDestination(destinationHash);
      if (deliveryDest) {
        const msg = await Message.fromPropagationData(v.lxmfData, deliveryDest);
        if (msg) {
          this.locallyDelivered.add(key);
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
   * @param {import("../core/identity.js").Identity|null} remoteIdentity
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
   * @returns {(path: string, data: any, requestId: Uint8Array, remoteIdentity: import("../core/identity.js").Identity|null, requestedAt: number) => Promise<Uint8Array[]|number>}
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
   * @param {import("../core/identity.js").Identity|null} remoteIdentity
   * @param {any} data
   * @returns {Promise<boolean|Uint8Array[]|number>} the offer response, or a
   *   peer-error code.
   */
  async handleOfferRequest(remoteIdentity, data) {
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

    /** @type {Uint8Array[]} */
    const offered = data[1];
    /** @type {Uint8Array[]} */
    const wanted = [];
    for (const tid of offered) {
      if (!this.store.has(tid)) wanted.push(tid);
    }
    if (wanted.length === 0) return false;
    if (wanted.length === offered.length) return true;
    return wanted;
  }

  /**
   * Builds the `responseGenerator` for `registerRequestHandler("/offer", …)`.
   * @returns {(path: string, data: any, requestId: Uint8Array, remoteIdentity: import("../core/identity.js").Identity|null, requestedAt: number) => Promise<boolean|Uint8Array[]|number>}
   */
  getOfferRequestHandler() {
    return async (_path, data, _requestId, remoteIdentity) =>
      this.handleOfferRequest(remoteIdentity, data);
  }
}
