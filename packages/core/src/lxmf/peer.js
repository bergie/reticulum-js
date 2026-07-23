/**
 * @file peer.js
 * @description Outbound side of the LXMF propagation peer-mesh sync
 *   (§5.8.4 / `LXMF/LXMPeer.py`). An {@link LXMPeer} drives a single
 *   one-way sync from this node to a peered propagation node: it presents a
 *   peering key, offers the messages the peer does not yet have, and transfers
 *   the ones it wants as a Resource (the same `msgpack([time,[lxmf_data‖stamp]])`
 *   container format used for client submits).
 *
 *   Peer state (handled/unhandled message sets) lives on the shared
 *   {@link MessageStore}; this class only owns the sync state machine and the
 *   per-peer peering key + statistics. There is no background worker thread —
 *   {@link LXMRouter.syncPeers} drives `sync()` explicitly.
 */

import { Destination } from "../core/destination.js";
import { DestType } from "../core/packet.js";
import { Resource } from "../core/resource.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import {
  APP_NAME,
  DEFAULT_SYNC_STRATEGY,
  OFFER_REQUEST_PATH,
} from "./constants.js";
import { packPropagationContainer } from "./propagation.js";
import { generateStamp, WORKBLOCK_EXPAND_ROUNDS_PEERING } from "./stamper.js";

/**
 * @enum {number}
 * Sync state machine (mirrors `LXMPeer.IDLE … RESOURCE_TRANSFERRING`).
 */
export const PeerState = Object.freeze({
  IDLE: 0x00,
  LINK_ESTABLISHING: 0x01,
  LINK_READY: 0x02,
  REQUEST_SENT: 0x03,
  RESPONSE_RECEIVED: 0x04,
  RESOURCE_TRANSFERRING: 0x05,
});

/** Concatenates two byte arrays. @param {Uint8Array} a @param {Uint8Array} b */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A peering relationship with another propagation node. One-way sync driver.
 */
export class LXMPeer {
  /**
   * @param {import("./router.js").LXMRouter} router
   * @param {Uint8Array} destinationHash Peer's `lxmf.propagation` dest hash.
   * @param {number} [syncStrategy] {@link DEFAULT_SYNC_STRATEGY}.
   */
  constructor(router, destinationHash, syncStrategy = DEFAULT_SYNC_STRATEGY) {
    this.router = router;
    this.destinationHash = destinationHash;
    this.alive = false;
    this.lastHeard = 0;
    this.syncStrategy = syncStrategy;

    // Negotiated from the peer's advertised app_data on `LXMRouter.peer`.
    this.peeringKey = null;
    /** @type {number|null} */
    this.peeringCost = null;
    /** @type {number|null} */
    this.propagationStampCost = null;
    /** @type {number|null} */
    this.propagationStampCostFlexibility = null;
    /** Per-message transfer limit (KB). @type {number|null} */
    this.propagationTransferLimit = null;
    /** Per-sync cumulative limit (KB). @type {number|null} */
    this.propagationSyncLimit = null;
    /** @type {Map<number, Uint8Array>|null} */
    this.metadata = null;

    /** @type {import("../transport/link.js").Link|null} */
    this.link = null;
    /** @type {number} */
    this.state = PeerState.IDLE;
    /** @type {Uint8Array[]} transient_ids carried by the last offer. */
    this.lastOffer = [];

    // Statistics
    this.offered = 0; // messages offered to this peer
    this.outgoing = 0; // messages transferred to this peer
    this.incoming = 0; // messages received from this peer
  }

  /** Human-readable identifier. */
  get id() {
    return toHex(this.destinationHash);
  }

  /**
   * Whether a peering key of sufficient value has been generated for this peer.
   * @returns {boolean}
   */
  peeringKeyReady() {
    if (this.peeringCost == null) return false;
    if (Array.isArray(this.peeringKey) && this.peeringKey.length === 2) {
      const value = /** @type {number} */ (this.peeringKey[1]);
      if (value >= /** @type {number} */ (this.peeringCost)) return true;
      this.peeringKey = null; // value mismatch → regenerate
    }
    return false;
  }

  /**
   * Generates the peering key stamp over
   * `receivingIdentityHash ‖ offeringIdentityHash`
   * (`peerIdentity.hash ‖ this.router.identity.hash`), at the peer's advertised
   * peering cost. Returns true on success.
   * @returns {Promise<boolean>}
   */
  async generatePeeringKey() {
    if (this.peeringCost == null) return false;
    if (this.peeringKey) return true;
    const peerIdentity = await Destination.recall(this.destinationHash);
    if (!peerIdentity) {
      log(
        "LXMF",
        `Cannot generate peering key for ${this.id}: peer identity unknown`,
        LogLevel.ERROR,
      );
      return false;
    }
    const localHash = this.router.identity.identityHash;
    const material = new Uint8Array(
      peerIdentity.identityHash.length + localHash.length,
    );
    material.set(peerIdentity.identityHash, 0); // receiving (peer) first
    material.set(localHash, peerIdentity.identityHash.length); // offering (us)
    const generated = await generateStamp(
      material,
      /** @type {number} */ (this.peeringCost),
      WORKBLOCK_EXPAND_ROUNDS_PEERING,
    );
    if (!generated) return false;
    const [key, value] = generated;
    if (value >= /** @type {number} */ (this.peeringCost)) {
      this.peeringKey = [key, value];
      return true;
    }
    return false;
  }

  /**
   * Runs one outbound sync pass: present peering key, offer unhandled messages,
   * transfer those the peer wants, then mark them handled.
   *
   * Resolves true if a transfer was attempted, false if the sync was postponed
   * (no peering key / nothing to offer / no link).
   * @returns {Promise<boolean>}
   */
  async sync() {
    if (!this.peeringKeyReady()) {
      if (!(await this.generatePeeringKey()) || !this.peeringKeyReady()) {
        log(
          "LXMF",
          `Postponing sync with peer ${this.id}: peering key not ready`,
          LogLevel.DEBUG,
        );
        return false;
      }
    }

    const store = this.router.propagationNode?.store;
    if (!store) return false;

    const minAccepted = Math.max(
      0,
      (this.propagationStampCost ?? 0) -
        (this.propagationStampCostFlexibility ?? 0),
    );
    const unhandled = store.unhandledEntriesForPeer(
      this.destinationHash,
      minAccepted,
    );
    if (unhandled.length === 0) {
      log("LXMF", `No unhandled messages for peer ${this.id}`, LogLevel.DEBUG);
      return false;
    }

    // Establish a link to the peer's lxmf.propagation destination and identify.
    const peerIdentity = await Destination.recall(this.destinationHash);
    if (!peerIdentity) return false;
    const peerDest = await Destination.OUT(
      APP_NAME + ".propagation",
      DestType.SINGLE,
      peerIdentity,
      this.router.rns,
    );
    this.state = PeerState.LINK_ESTABLISHING;
    this.link = await peerDest.createLink();
    await this.link.identify(this.router.identity);
    this.state = PeerState.LINK_READY;

    // Apply per-message and per-sync limits, building the offered id list.
    const offeredIds = [];
    let cumulative = 24; // structural overhead estimate
    const perMessageOverhead = 16;
    for (const u of unhandled) {
      const transferSize = u.size + perMessageOverhead;
      if (
        this.propagationTransferLimit != null &&
        transferSize > this.propagationTransferLimit * 1000
      ) {
        // Too large for this peer — treat as handled (won't transfer).
        store.markHandledForPeer(u.transientId, this.destinationHash);
        continue;
      }
      if (
        this.propagationSyncLimit != null &&
        cumulative + transferSize >= this.propagationSyncLimit * 1000
      ) {
        continue;
      }
      cumulative += transferSize;
      offeredIds.push(u.transientId);
    }

    if (offeredIds.length === 0) {
      this._teardown();
      return false;
    }

    const peeringKey = /** @type {[Uint8Array, number]} */ (this.peeringKey);
    const offer = [peeringKey[0], offeredIds];
    this.lastOffer = offeredIds;
    this.state = PeerState.REQUEST_SENT;
    log(
      "LXMF",
      `Offering ${offeredIds.length} message(s) to peer ${this.id}`,
      LogLevel.DEBUG,
    );
    const response = await this.link.request(OFFER_REQUEST_PATH, offer);

    const wanted = this._interpretOfferResponse(response, store);
    if (wanted.length === 0) {
      log(
        "LXMF",
        `Peer ${this.id} did not request any messages; sync complete`,
        LogLevel.DEBUG,
      );
      this.offered += offeredIds.length;
      this._teardown();
      return false;
    }

    // Transfer the wanted messages as a Resource (stamped blobs).
    /** @type {Uint8Array[]} */
    const lxmfList = [];
    for (const tid of wanted) {
      const entry = store.get(tid);
      if (entry) lxmfList.push(concat(entry.lxmfData, entry.stampData));
    }
    const container = packPropagationContainer(lxmfList);
    this.state = PeerState.RESOURCE_TRANSFERRING;
    const resource = new Resource({ data: container, link: this.link });
    await resource.advertise();
    // Wait for the full transfer + proof before tearing down the link,
    // otherwise the link closes mid-transfer and the peer never ingests.
    await resource.whenComplete();

    for (const tid of wanted) {
      store.markHandledForPeer(tid, this.destinationHash);
    }
    this.offered += offeredIds.length;
    this.outgoing += wanted.length;
    this.alive = true;
    this.lastHeard = Date.now() / 1000;
    log(
      "LXMF",
      `Transferred ${wanted.length} message(s) to peer ${this.id}`,
      LogLevel.DEBUG,
    );
    this._teardown();
    return true;
  }

  /**
   * Interprets an `/offer` response (`LXMPeer.offer_response`):
   *   - `false` → peer has everything offered (mark all handled, want nothing).
   *   - `true`  → peer wants everything offered.
   *   - `[ids]` → peer wants that subset; ids absent from the response are
   *     marked handled (the peer already received them elsewhere).
   *   - error code / other → want nothing.
   *
   * @param {any} response
   * @param {import("./message_store.js").MessageStore} store
   * @returns {Uint8Array[]} wanted transient_ids.
   * @private
   */
  _interpretOfferResponse(response, store) {
    if (response === false) {
      for (const tid of this.lastOffer) {
        store.markHandledForPeer(tid, this.destinationHash);
      }
      return [];
    }
    if (response === true) return [...this.lastOffer];
    if (Array.isArray(response)) {
      const set = new Set(response.map((t) => toHex(t)));
      for (const tid of this.lastOffer) {
        if (!set.has(toHex(tid))) {
          store.markHandledForPeer(tid, this.destinationHash);
        }
      }
      return /** @type {Uint8Array[]} */ (response);
    }
    log(
      "LXMF",
      `Peer ${this.id} offer error/unexpected response: ${response}`,
      LogLevel.DEBUG,
    );
    return [];
  }

  /** Tears down the sync link and returns to IDLE. @private */
  _teardown() {
    this.link?.teardown?.();
    this.link = null;
    this.state = PeerState.IDLE;
  }

  /** Operator name from advertised metadata, if present. @type {string|null} */
  get name() {
    const md = this.metadata;
    if (!md || typeof md !== "object") return null;
    const name = md.get(0x01);
    if (name instanceof Uint8Array) {
      try {
        return new TextDecoder().decode(name);
      } catch {
        return null;
      }
    }
    return null;
  }
}
