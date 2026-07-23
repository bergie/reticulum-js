/**
 * @file router.js
 * @description LXMF Router for managing incoming and outgoing messages
 */

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { Resource } from "../core/resource.js";
import { LinkStatus } from "../transport/link.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import {
  buildAnnounceAppData,
  parseAnnounceAppData,
  parsePropagationNodeAppData,
} from "./announce_data.js";
import {
  ALL_MESSAGES,
  DEFAULT_SYNC_STRATEGY,
  DELIVERY_LIMIT,
  MAX_PEERING_COST,
  MESSAGE_GET_PATH,
  OFFER_REQUEST_PATH,
  PROPAGATION_COST,
  STAMP_SIZE,
} from "./constants.js";
import { Message } from "./message.js";
import { LXMPeer } from "./peer.js";
import {
  packPropagationContainer,
  unpackPropagationContainer,
} from "./propagation.js";
import { PropagationNode } from "./propagation_node.js";
import { generateStamp, WORKBLOCK_EXPAND_ROUNDS_PN } from "./stamper.js";

/**
 * Upper bound (ms) for awaiting an outgoing Resource transfer to reach
 * COMPLETE. `Resource.advertise()` only sends the advertisement — the actual
 * data is pulled by the receiver via RESOURCE_REQ — so callers MUST await the
 * transfer before reporting success, otherwise the message is lost if the
 * link comes down (or the process exits) first. The JS Resource has no
 * sender-side watchdog yet, so this bounds the wait on a dead link.
 */
const RESOURCE_TRANSFER_TIMEOUT_MS = 60_000;

/**
 * Handles LXMF routing and message processing.
 * @description LXMF Router for managing incoming and outgoing messages
 */
export class LXMRouter extends EventTarget {
  /**
   * Creates an LXMF router bound to the given identity and Reticulum instance.
   * @param {import("../core/identity.js").Identity} identity
   * @param {import("../core/reticulum.js").Reticulum} rnsCore - The Reticulum instance
   */
  constructor(identity, rnsCore) {
    super();
    this.identity = identity;
    this.rns = rnsCore;
    this.deliveryDest = null;
    /** @type {import("./propagation_node.js").PropagationNode|null} */
    this.propagationNode = null;
    /** @type {import("../core/destination.js").Destination|null} */
    this.propagationDest = null;
    // --- Client-side propagation (submit + sync) ---
    /** @type {Uint8Array|null} destination hash of the configured propagation node. */
    this.outboundPropagationNode = null;
    /** @type {import("../transport/link.js").Link|null} cached link to the node. */
    this.outboundPropagationLink = null;
    /** Client per-transfer download limit (KB) advertised in `/get` requests. */
    this.deliveryPerTransferLimit = DELIVERY_LIMIT;
    this.pendingMessages = new Map();
    this.pendingLinks = new Map();
    // Tracks outbound links (by hex link_id) we have already sent LINKIDENTIFY
    // on, so we identify once per link rather than on every message.
    this.identifiedLinks = new Set();
    // Last display name / stamp cost we announced with (§4.3 app_data).
    this.displayName = null;
    this.stampCost = null;
    // Tracks transient_ids of ingested paper/propagated messages we have
    // already processed, so a repeated URI ingestion is ignored
    // (LXMRouter.locally_processed_transient_ids).
    /** @type {Map<string, number>} */
    this.processedTransientIds = new Map();
    // --- Peer mesh (§5.8.4): peered propagation nodes keyed by dest hash. ---
    /** @type {Map<string, LXMPeer>} */
    this.peers = new Map();
  }

  /**
   * Initializes the router and registers the LXMF delivery destination.
   */
  async init() {
    log("ROUTER", "Initializing...");
    // Register the standard LXMF delivery destination.
    // Assumes Destination.IN was updated to accept the rnsCore as the 4th/5th parameter
    const deliveryDest = await Destination.IN(
      "lxmf.delivery",
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    log("ROUTER", `deliveryDest set: ${deliveryDest.name}`);
    this.deliveryDest = deliveryDest;

    // Bind it to the central routing table
    this.rns.transport.bindLocalDestination(deliveryDest);
    this.rns.registerDestination(deliveryDest);

    // §7.4: enable forward-secrecy ratchets so the delivery destination
    // advertises a ratchet in its announces and can decrypt messages that
    // peers encrypt to it. Without this, ratchet-enforcing Python peers drop
    // our outbound messages and we gain no forward secrecy.
    await deliveryDest.enableRatchets();

    this._setupListeners();

    this.dispatchEvent(
      new CustomEvent("ready", { detail: { destination: deliveryDest } }),
    );
    log("ROUTER", "init complete.");
  }

  /**
   * Announces the `lxmf.delivery` destination with the given display name.
   *
   * Builds the §4.3 msgpack `app_data` (`[name(bin8), stamp_cost, [SF_COMPRESSION]]`)
   * and attaches it to the identity so `Destination.announce` signs it as part
   * of the announce body.
   *
   * @param {string} displayName - Human-readable node name shown to peers.
   * @param {number|null} [stampCost=null] - Active stamp cost (1-254), or null
   *   to advertise stamping as disabled.
   * @returns {Promise<void>}
   */
  async announce(displayName, stampCost = null) {
    if (!this.deliveryDest) {
      throw new Error("Router not initialized; call init() first.");
    }
    this.displayName = displayName;
    this.stampCost = stampCost;
    // Slice so the identity owns an ArrayBuffer-backed copy (the §4.3 blob is
    // signed verbatim by Destination.announce, so the bytes must not alias a
    // larger transient buffer).
    this.identity.appData = buildAnnounceAppData(
      displayName,
      stampCost,
    ).slice();
    await this.deliveryDest.announce();
  }

  /**
   * Enables the propagation-node role (§5.3): creates the `lxmf.propagation`
   * destination, registers the `/get` message-download handler, and ingests
   * submitted messages received via link Resources.
   *
   * The node stores propagated messages addressed to *other* identities and
   * serves them to clients over `/get`; messages addressed to this router's
   * own delivery identity are locally delivered (decrypted + dispatched as a
   * `message` event). Returns the {@link PropagationNode} for direct access
   * (e.g. inspecting {@link PropagationNode.store}).
   *
   * Call {@link announcePropagationNode} afterwards to broadcast the node.
   *
   * @param {import("./propagation_node.js").PropagationNodeOptions} [options]
   * @returns {Promise<PropagationNode>}
   */
  async enablePropagation(options = {}) {
    if (this.propagationNode) return this.propagationNode;

    const propDest = await Destination.IN(
      "lxmf.propagation",
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    this.propagationDest = propDest;
    this.rns.transport.bindLocalDestination(propDest);
    this.rns.registerDestination(propDest);

    const deliveryHash = this.deliveryDest?.destinationHash ?? null;
    const node = new PropagationNode({
      ...options,
      getLocalIdentityHash: () => this.identity.identityHash,
      getDeliveryDestination: (hash) => {
        if (!deliveryHash) return null;
        return toHex(hash) === toHex(deliveryHash)
          ? /** @type {any} */ (this.deliveryDest)
          : null;
      },
      onLocalDelivery: (msg) => {
        // Locally-delivered propagated messages are dispatched through the
        // same `message` event as direct ones (SOURCE_UNKNOWN semantics: the
        // sender identity may not be known, so the signature is not verified
        // here, mirroring Python lxmf_delivery).
        this._dispatchMessage(/** @type {any} */ (msg), null);
      },
    });
    this.propagationNode = node;

    // Per-destination app_data: advertise this node's limits/costs.
    propDest.appData = node.buildAnnounceAppData().slice();

    // §5.3: serve stored messages to clients over /get.
    await propDest.registerRequestHandler(MESSAGE_GET_PATH, {
      responseGenerator: node.getRequestHandler(),
    });
    // §5.8.4: accept sync offers from peered propagation nodes.
    await propDest.registerRequestHandler(OFFER_REQUEST_PATH, {
      responseGenerator: node.getOfferRequestHandler(),
    });

    // Accept links and ingest submitted propagation containers (Resources).
    /** @type {any} */ (propDest).addEventListener(
      "link_request",
      async (/** @type {any} */ event) => {
        try {
          const link = await /** @type {any} */ (propDest).acceptLink(
            event.detail.packet,
          );
          link.bz2 = this.rns.compressionProvider || undefined;
          link.addEventListener("resource", (/** @type {any} */ resEvent) => {
            const resource = /** @type {any} */ (resEvent).detail.resource;
            resource
              .whenComplete()
              .then(async () => {
                const container = unpackPropagationContainer(
                  /** @type {Uint8Array} */ (resource.data),
                );
                if (container) {
                  const res = await node.ingestBlobs(container.messages);
                  log(
                    "LXMF",
                    `Propagation submit ingested: ${res.stored} stored, ${res.delivered} delivered, ${res.rejected} rejected`,
                    LogLevel.DEBUG,
                  );
                  // Queue newly-stored messages for distribution to every
                  // peered node (LXMRouter.flush_peer_distribution_queue).
                  this._distributeStored(res.storedIds);
                }
              })
              .catch((/** @type {Error} */ err) => {
                log(
                  "LXMF",
                  `Propagation resource transfer failed: ${err}`,
                  LogLevel.ERROR,
                );
              });
          });
        } catch (e) {
          log(
            "LXMF",
            `Failed to accept propagation link: ${e}`,
            LogLevel.ERROR,
          );
        }
      },
    );

    return node;
  }

  /**
   * Announces the `lxmf.propagation` destination, advertising this node to the
   * network. Requires {@link enablePropagation} first.
   * @returns {Promise<void>}
   */
  async announcePropagationNode() {
    if (!this.propagationDest) {
      throw new Error(
        "Propagation not enabled; call enablePropagation() first.",
      );
    }
    await this.propagationDest.announce();
  }

  // ----------------------------------------------------------------
  // Peer mesh (§5.8.4): peered propagation nodes
  // ----------------------------------------------------------------

  /**
   * Establishes (or updates) a peering relationship with another propagation
   * node (`LXMRouter.peer`). The peer's advertised limits and costs are read
   * from its app_data; messages this node stores are then offered to it on the
   * next {@link syncPeers}.
   *
   * @param {Uint8Array} destinationHash Peer's `lxmf.propagation` hash.
   * @param {Object} config
   * @param {number} config.stampCost Peer's propagation stamp cost.
   * @param {number} config.stampCostFlexibility Peer's stamp cost flexibility.
   * @param {number} config.peeringCost Peer's peering cost (≤ MAX_PEERING_COST).
   * @param {number|null} [config.perTransferLimitKb] Per-message transfer limit.
   * @param {number|null} [config.perSyncLimitKb] Per-sync cumulative limit.
   * @param {Map<number, Uint8Array>|null} [config.metadata] Node metadata map.
   * @returns {LXMPeer|null} the peer, or null if peering was rejected.
   */
  peer(destinationHash, config) {
    if (config.peeringCost > MAX_PEERING_COST) {
      log(
        "LXMF",
        `Not peering with ${toHex(destinationHash)}: peering cost ${config.peeringCost} > max ${MAX_PEERING_COST}`,
        LogLevel.NOTICE,
      );
      this.unpeer(destinationHash);
      return null;
    }
    const key = toHex(destinationHash);
    /** @type {LXMPeer} */
    let peer;
    if (this.peers.has(key)) {
      peer = /** @type {LXMPeer} */ (this.peers.get(key));
    } else {
      peer = new LXMPeer(this, destinationHash.slice(), DEFAULT_SYNC_STRATEGY);
      this.peers.set(key, peer);
    }
    peer.alive = true;
    peer.lastHeard = Date.now() / 1000;
    peer.propagationStampCost = config.stampCost;
    peer.propagationStampCostFlexibility = config.stampCostFlexibility;
    peer.peeringCost = config.peeringCost;
    peer.propagationTransferLimit = config.perTransferLimitKb ?? null;
    peer.propagationSyncLimit =
      config.perSyncLimitKb ?? config.perTransferLimitKb ?? null;
    peer.metadata = config.metadata ?? null;
    // Invalidate any stale peering key so a cost change regenerates it.
    if (!peer.peeringKeyReady()) peer.peeringKey = null;
    log("LXMF", `Peered with ${toHex(destinationHash)}`, LogLevel.NOTICE);
    return peer;
  }

  /**
   * Breaks a peering relationship (`LXMRouter.unpeer`).
   * @param {Uint8Array} destinationHash
   */
  unpeer(destinationHash) {
    const removed = this.peers.delete(toHex(destinationHash));
    if (removed)
      log(
        "LXMF",
        `Broke peering with ${toHex(destinationHash)}`,
        LogLevel.NOTICE,
      );
  }

  /**
   * Runs one outbound sync pass against every peered node. Resolves when all
   * peers have completed (or postponed) their sync.
   * @returns {Promise<void>}
   */
  async syncPeers() {
    for (const peer of this.peers.values()) {
      try {
        await peer.sync();
      } catch (err) {
        log("LXMF", `Sync with peer ${peer.id} failed: ${err}`, LogLevel.ERROR);
      }
    }
  }

  /**
   * Marks newly-stored messages as unhandled for every peered node so they will
   * be offered on the next {@link syncPeers} (`flush_peer_distribution_queue`).
   * @param {Uint8Array[]} storedIds
   * @private
   */
  _distributeStored(storedIds) {
    const store = this.propagationNode?.store;
    if (!store || storedIds.length === 0 || this.peers.size === 0) return;
    for (const tid of storedIds) {
      for (const peer of this.peers.values()) {
        store.markUnhandledForPeer(tid, peer.destinationHash);
      }
    }
  }

  // ----------------------------------------------------------------
  // Client-side propagation: submit (PROPAGATED) + sync (download)
  // ----------------------------------------------------------------

  /**
   * Sets the propagation node to submit messages to and sync from, by its
   * `lxmf.propagation` destination hash. The node's identity/app_data must be
   * learned from an announce before submit/sync can run.
   *
   * @param {Uint8Array} destinationHash
   */
  setOutboundPropagationNode(destinationHash) {
    this.outboundPropagationNode = destinationHash;
    this.outboundPropagationLink = null; // force a fresh link to the new node
  }

  /**
   * Establishes (and caches) a Link to the configured propagation node's
   * `lxmf.propagation` destination, waiting until it is ACTIVE.
   * @returns {Promise<import("../transport/link.js").Link>}
   * @private
   */
  async _ensurePropagationLink() {
    if (!this.outboundPropagationNode) {
      throw new Error("No outbound propagation node configured.");
    }
    const cached = this.outboundPropagationLink;
    if (cached && cached.status === 2 /* LinkStatus.ACTIVE */) {
      return cached;
    }
    const nodeIdentity = await Destination.recall(this.outboundPropagationNode);
    if (!nodeIdentity) {
      throw new Error(
        `Propagation node identity unknown for ${toHex(
          this.outboundPropagationNode,
        )}; wait for its announce.`,
      );
    }
    const nodeDest = await Destination.OUT(
      "lxmf.propagation",
      DestType.SINGLE,
      nodeIdentity,
      this.rns,
    );
    const link = await nodeDest.createLink();
    await link.whenActive();
    this.outboundPropagationLink = link;
    return link;
  }

  /**
   * Submits a message to the configured propagation node for store-and-forward
   * delivery (LXMF.md §5.8 / LXMessage PROPAGATED).
   *
   * Packs the message into propagation form (`dest_hash ‖ E(src‖sig‖payload)`,
   * §5.3), appends a propagation stamp meeting the node's advertised cost, and
   * sends the `msgpack([time, [lxmf_data]])` container to the node as a Link
   * Resource. The node stores it until the recipient syncs.
   *
   * @param {Message} message
   * @param {import("../core/identity.js").Identity} senderIdentity
   * @param {{stampCost?: number}} [options] Override the stamp cost (defaults
   *   to the node's advertised cost, then {@link PROPAGATION_COST}).
   * @returns {Promise<{transientId: Uint8Array, stampCost: number}>}
   */
  async submitToPropagationNode(message, senderIdentity, options = {}) {
    if (!this.outboundPropagationNode) {
      throw new Error("No outbound propagation node configured.");
    }

    // Resolve the stamp cost: explicit option > node's advertised cost > default.
    let stampCost = options.stampCost;
    if (stampCost == null) {
      const nodeIdentity = await Destination.recall(
        this.outboundPropagationNode,
      );
      const pn = nodeIdentity
        ? parsePropagationNodeAppData(nodeIdentity.appData)
        : null;
      stampCost = pn?.stampCost ?? PROPAGATION_COST;
    }

    const { container, transientId } = await this._packForPropagationSubmit(
      message,
      senderIdentity,
      stampCost,
    );

    const link = await this._ensurePropagationLink();
    if (!link.bz2)
      link.bz2 = /** @type {any} */ (this.rns.compressionProvider) || undefined;
    const resource = new Resource({
      data: container,
      link,
      bz2: link.bz2,
    });
    await resource.advertise();
    // advertise() only sends the advertisement; the node pulls the actual
    // lxmf_data afterwards via RESOURCE_REQ. Wait for the transfer to reach
    // COMPLETE before reporting success — otherwise the message is never
    // stored if the link (or the process) goes away first.
    await this._awaitOutgoingResource(resource, link);

    return { transientId, stampCost };
  }

  /**
   * Awaits an outgoing Resource transfer reaching COMPLETE.
   *
   * `Resource.advertise()` only emits the RESOURCE_ADV; the receiver then
   * drives the transfer by sending RESOURCE_REQ, and the sender validates a
   * final RESOURCE_PRF. A caller that returns straight after `advertise()`
   * (as propagation submit and large DIRECT delivery previously did) reports
   * success before any message bytes have crossed the wire, so the message is
   * silently lost when the link is torn down or the process exits before the
   * receiver pulls the parts.
   *
   * Resolves once the transfer is COMPLETE. Rejects if the Resource fails, if
   * the carrier Link closes first, or if the wait exceeds
   * {@link RESOURCE_TRANSFER_TIMEOUT_MS} (the JS Resource has no sender-side
   * watchdog yet, so this bounds the wait on a dead link).
   *
   * @param {Resource} resource
   * @param {import("../transport/link.js").Link} link
   * @returns {Promise<void>}
   * @private
   */
  async _awaitOutgoingResource(resource, link) {
    let cleanup = () => {};
    const completion = resource.whenComplete();
    const guard = new Promise((_, reject) => {
      const onStatus = (/** @type {any} */ ev) => {
        if (
          ev.detail.status === LinkStatus.CLOSED &&
          resource.status !== /* ResourceStatus.COMPLETE */ 6
        ) {
          reject(new Error("Link closed before the LXMF transfer completed"));
        }
      };
      const timer = setTimeout(() => {
        reject(new Error("LXMF transfer timed out waiting for completion"));
      }, RESOURCE_TRANSFER_TIMEOUT_MS);
      cleanup = () => {
        clearTimeout(timer);
        link.removeEventListener("statuschange", onStatus);
      };
      link.addEventListener("statuschange", onStatus);
    });
    try {
      await Promise.race([completion.then(() => {}), guard]);
    } finally {
      cleanup();
    }
  }

  /**
   * Packs a message into the propagation submit container
   * (`msgpack([time, [lxmf_data || stamp]])`) for a given stamp cost, without
   * touching the transport. Factored out of {@link submitToPropagationNode}
   * so the wire format is unit-testable.
   *
   * @param {Message} message
   * @param {import("../core/identity.js").Identity} senderIdentity
   * @param {number} stampCost
   * @returns {Promise<{container: Uint8Array, transientId: Uint8Array, stampCost: number}>}
   * @private
   */
  async _packForPropagationSubmit(message, senderIdentity, stampCost) {
    const recipientIdentity = await Destination.recall(message.destinationHash);
    if (!recipientIdentity) {
      throw new Error(
        `Unknown recipient identity for ${toHex(message.destinationHash)}`,
      );
    }
    const recipientOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      recipientIdentity,
      this.rns,
    );

    const { lxmfData, transientId } = await message.toPropagationData(
      senderIdentity,
      recipientOut,
    );

    // Append the propagation stamp (always 32 bytes; the node strips it and
    // validates it against transient_id). Cost 0 accepts any stamp.
    let stamp;
    if (stampCost > 0) {
      const generated = await generateStamp(
        transientId,
        stampCost,
        WORKBLOCK_EXPAND_ROUNDS_PN,
      );
      if (!generated) throw new Error("Failed to generate propagation stamp");
      stamp = generated[0];
    } else {
      stamp = new Uint8Array(STAMP_SIZE);
    }
    const stamped = new Uint8Array(lxmfData.length + stamp.length);
    stamped.set(lxmfData, 0);
    stamped.set(stamp, lxmfData.length);

    return {
      container: packPropagationContainer([stamped]),
      transientId,
      stampCost,
    };
  }

  /**
   * Downloads messages addressed to `identity` from the configured propagation
   * node (LXMRouter.request_messages_from_propagation_node).
   *
   * Drives the `/get` exchange: list available `transient_id`s, request those
   * not already held, decrypt + dispatch each, then ack so the node purges
   * them. Resolves with counts of received / duplicate messages.
   *
   * @param {import("../core/identity.js").Identity} identity The recipient
   *   identity to identify as (so the node serves our messages).
   * @param {number} [maxMessages=ALL_MESSAGES] Cap on messages fetched.
   * @returns {Promise<{received: number, duplicates: number}>}
   */
  async syncFromPropagationNode(identity, maxMessages = ALL_MESSAGES) {
    if (!this.outboundPropagationNode) {
      throw new Error("No outbound propagation node configured.");
    }

    const link = await this._ensurePropagationLink();
    // The node serves messages for the identified recipient only.
    await link.identify(identity);

    // Phase 1: list available transient_ids.
    const list = await link.request(MESSAGE_GET_PATH, [null, null]);
    this._throwOnPeerError(list);
    if (!Array.isArray(list)) {
      throw new Error("Invalid message list from propagation node");
    }

    // Phase 2: split into wants (fetch) and haves (tell the node to purge).
    const wants = [];
    const haves = [];
    for (const tid of list) {
      if (this.processedTransientIds.has(toHex(tid))) {
        haves.push(tid);
      } else if (maxMessages === ALL_MESSAGES || wants.length < maxMessages) {
        wants.push(tid);
      }
    }
    if (wants.length === 0 && haves.length === 0) {
      return { received: 0, duplicates: 0 };
    }

    const messages = await link.request(MESSAGE_GET_PATH, [
      wants,
      haves,
      this.deliveryPerTransferLimit,
    ]);
    this._throwOnPeerError(messages);
    if (!Array.isArray(messages)) {
      throw new Error("Invalid message data from propagation node");
    }

    // Phase 3: decrypt + deliver each received lxmf_data.
    const receivedIds = [];
    let received = 0;
    for (const lxmfData of messages) {
      const tid = await Message.transientIdFromPropagationData(lxmfData);
      const tidHex = toHex(tid);
      if (this.processedTransientIds.has(tidHex)) continue;
      if (await this._ingestPropagationData(lxmfData)) {
        this.processedTransientIds.set(tidHex, Date.now() / 1000);
        receivedIds.push(tid);
        received++;
      }
    }

    // Phase 4: ack so the node purges the messages we received.
    if (receivedIds.length > 0) {
      await link.request(MESSAGE_GET_PATH, [null, receivedIds]);
    }

    return { received, duplicates: messages.length - received };
  }

  /**
   * Decrypts a synced `lxmf_data` (base form, stamp already stripped by the
   * node) addressed to this router's delivery destination and dispatches it as
   * a `message` event. Returns false if it is not for us or undecryptable.
   *
   * @param {Uint8Array} lxmfData
   * @returns {Promise<boolean>}
   * @private
   */
  async _ingestPropagationData(lxmfData) {
    if (!this.deliveryDest || !this.deliveryDest.destinationHash) return false;
    const destinationHash = lxmfData.subarray(0, 16);
    if (toHex(destinationHash) !== toHex(this.deliveryDest.destinationHash)) {
      return false;
    }
    const message = await Message.fromPropagationData(
      lxmfData,
      this.deliveryDest,
    );
    if (!message) return false;
    const senderIdentity = await Destination.recall(message.sourceHash);
    await this._dispatchMessage(message, null, senderIdentity ?? undefined);
    return true;
  }

  /**
   * Throws when a `/get` response is a peer error code.
   * @param {any} response
   * @private
   */
  _throwOnPeerError(response) {
    if (typeof response === "number" && response >= 0xf0) {
      throw new Error(
        `Propagation node returned error code 0x${response.toString(16)}`,
      );
    }
  }

  /**
   * Sets up event listeners for both direct packets and incoming link requests.
   * @private
   */
  _setupListeners() {
    const deliveryDest = this.deliveryDest;
    const expectedDestHash = deliveryDest?.destinationHash;
    if (!expectedDestHash) {
      throw new Error(
        "Cannot set up listeners: delivery destination not initialized",
      );
    }

    // 1. Listen for standard Single-Packet LXMF Messages
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "data",
      async (/** @type {any} */ event) => {
        const { plaintext } = /** @type {any} */ (event).detail;
        try {
          await this._processIncomingMessage(plaintext, null, expectedDestHash);
        } catch (e) {
          log(
            "LXMF",
            `[!] Failed to process single-packet LXMF message: ${e}`,
            LogLevel.ERROR,
          );
        }
      },
    );

    // 2. Listen for Large LXMF Messages arriving via Links
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "link_request",
      async (/** @type {any} */ event) => {
        log("LXMF", "[*] Incoming LXMF Link Request");

        try {
          // Use the clean callback we built into Destination.js
          const link = await /** @type {any} */ (this.deliveryDest).acceptLink(
            event.detail.packet,
          );
          // Inject the caller-supplied bz2 module so any compressed inbound
          // resource can be decompressed (§10.2). Harmless when absent.
          link.bz2 = this.rns.compressionProvider || undefined;

          // Listen for single-packet LXMF messages over the established link
          link.addEventListener("data", async (/** @type {any} */ pktEvent) => {
            await this._processIncomingMessage(
              /** @type {any} */ (pktEvent).detail.packet.payload,
              pktEvent.detail.link,
              expectedDestHash,
            );
          });

          // §5.2/§10.1: a large DIRECT message arrives as a Resource. Feed the
          // reassembled, integrity-checked body through the same inbound path
          // as a single-packet message once the transfer completes.
          link.addEventListener("resource", (/** @type {any} */ resEvent) => {
            const resource = /** @type {any} */ (resEvent).detail.resource;
            resource
              .whenComplete()
              .then(() => {
                this._processIncomingMessage(
                  /** @type {Uint8Array} */ (resource.data),
                  link.linkId,
                  expectedDestHash,
                );
              })
              .catch((/** @type {Error} */ err) => {
                log(
                  "LXMF",
                  `Incoming LXMF resource transfer failed: ${err}`,
                  LogLevel.ERROR,
                );
              });
          });

          // Python LXMF is not ready to receive messages until it has identified
          // We should park messages until we receive LINKIDENTIFY (or a timeout)
          const linkHex = toHex(link.linkId);
          this.pendingLinks.set(linkHex, true);
          const timer = setTimeout(() => {
            log("LXMF", `Timeout waiting for link ${linkHex} to identify`);
            this.pendingLinks.delete(linkHex);
            this.processPendingMessages(link.linkId);
          }, 10000);

          // Listen for identity on the link
          link.addEventListener(
            "identify",
            async (/** @type {any} */ event) => {
              try {
                if (timer) {
                  clearTimeout(timer);
                }

                const peerIdentity = event.detail.identity;
                const identityHash = await Identity.truncatedHash(
                  peerIdentity.publicKey,
                );
                log(
                  "LXMF",
                  `Received LINKIDENTIFY for ${toHex(identityHash)} (${linkHex})`,
                );

                // 2. CRITICAL: Derive and store by the LXMF Address (sourceHash)
                const peerDeliveryDest = await Destination.OUT(
                  "lxmf.delivery",
                  DestType.SINGLE,
                  peerIdentity,
                  this.rns,
                );

                // Map the LXMF Address to the Identity Key
                if (!peerDeliveryDest.destinationHash) {
                  throw new Error(
                    "Failed to derive peer delivery destination hash",
                  );
                }
                await Destination.remember(
                  identityHash,
                  peerDeliveryDest.destinationHash,
                  peerIdentity.publicKey,
                );

                // #16: a LINKIDENTIFY is an authenticated contact — the peer
                // proved ownership of this identity over a live link. Persist
                // the just-remembered identity so its signature can be verified
                // across a restart (recall() reads from the same map the
                // Persistor flushes). markContacted schedules a debounced
                // flush, coalescing repeated identifies.
                this.rns.persistor?.markContacted(
                  peerDeliveryDest.destinationHash,
                );

                this.pendingLinks.delete(linkHex);
                this.processPendingMessages(link.linkId);
              } catch (e) {
                log(
                  "ROUTER",
                  `Failed to derive LXMF destination for peer from link: ${e}`,
                  LogLevel.ERROR,
                );
              }
            },
          );
        } catch (e) {
          log(
            "LXMF",
            `[!] Failed to respond to LXMF link request: ${e}`,
            LogLevel.ERROR,
          );
        }
      },
    );

    // 3. Listen for validated announces from the transport (SPEC §4.5) and
    //    decode the lxmf.delivery `app_data` (§4.3) so the app layer learns
    //    peer display names / stamp costs without a separate handshake.
    //    Self-echo for local destinations is already filtered by the transport
    //    (§9.5), so we only see remote announces here.
    this.rns.transport.addEventListener("announce", (event) => {
      const { destinationHash, identity, appData } =
        /** @type {CustomEvent} */ (event).detail;
      this.dispatchEvent(
        new CustomEvent("peer", {
          detail: {
            destinationHash,
            identity,
            appData: parseAnnounceAppData(appData),
          },
        }),
      );
    });
  }

  /**
   * Processes a raw LXMF message wire buffer.
   * @param {Uint8Array} wireData
   * @param {Uint8Array|null} linkId
   * @param {Uint8Array} [expectedDestHash]
   * @private
   */
  async _processIncomingMessage(wireData, linkId, expectedDestHash) {
    if (wireData.length < 80) {
      throw new Error("LXMF message too short to contain required headers");
    }

    const linkHex = linkId ? toHex(linkId) : null;

    // 1. Deserialize the message immediately
    const message = await Message.deserialize(wireData, expectedDestHash);

    log("LXMF", `Incoming message from source ${toHex(message.sourceHash)}`);

    // 2. Validate signature against the SENDER'S public key
    const senderIdentity = await Destination.recall(message.sourceHash);

    if (!senderIdentity) {
      log(
        "LXMF",
        `Identity unknown for ${toHex(message.sourceHash)}. Requesting...`,
      );

      // Park the message until the link identifies (or the pending-link
      // timeout fires), which is when we can learn the sender's identity.
      this.pendingMessages.set(linkId, wireData);

      return;
    }

    // The sender identity is already known, so there is no need to wait for
    // LINKIDENTIFY. Python's lxmf_delivery delivers immediately in this case;
    // we match that behaviour and only park when the identity is unknown.
    this.pendingMessages.delete(linkId);

    // 3. Verify the signature with §5.6 msgpack-variant tolerance.
    if (!(await message.verifySignature(senderIdentity))) {
      throw new Error(
        "Invalid LXMF message signature: Cryptographic proof failed.",
      );
    }

    // §16: a validated inbound message means we've communicated with the
    // sender — remember their identity/ratchet/path across restarts.
    this.rns.persistor?.markContacted(message.sourceHash);

    // 4. Dispatch to the UI layer
    this._dispatchMessage(message, linkId);
  }

  /**
   * Dispatches a fully-received, signature-verified message to listeners as a
   * `message` event. When `senderIdentity` is provided the signature is
   * re-checked and a failure raises (cryptographic proof failed); when it is
   * `null` (e.g. a paper message whose sender we have not announced with yet)
   * the message is still delivered, mirroring Python's
   * `lxmf_delivery` SOURCE_UNKNOWN behaviour.
   *
   * @param {Message} message
   * @param {Uint8Array|null} linkId
   * @param {Identity} [senderIdentity] - optional pre-recalled sender identity.
   * @returns {Promise<void>}
   * @private
   */
  async _dispatchMessage(message, linkId, senderIdentity) {
    if (senderIdentity && !(await message.verifySignature(senderIdentity))) {
      throw new Error(
        "Invalid LXMF message signature: Cryptographic proof failed.",
      );
    }

    this.dispatchEvent(
      new CustomEvent("message", {
        detail: {
          message,
          link: linkId,
        },
      }),
    );
  }

  /**
   * Call this when a new Identity is cached (e.g., in your IDENTIFY handler).
   * It checks if any parked messages are now ready for processing.
   * @param {Uint8Array} linkId
   */
  async processPendingMessages(linkId) {
    const hashHex = toHex(linkId);
    const expectedDestHash = this.deliveryDest?.destinationHash;
    if (!expectedDestHash) {
      return;
    }
    if (this.pendingMessages.has(linkId)) {
      log(
        "LXMF",
        `Identity acquired. Re-processing parked message for ${hashHex}`,
      );
      const wireData = this.pendingMessages.get(linkId);
      await this._processIncomingMessage(wireData, linkId, expectedDestHash);
    }
  }

  /**
   * Ingests a paper message delivered as an `lxm://` URI (`LXMRouter.ingest_lxm_uri`).
   *
   * The URI body is base64-decoded into the paper payload, de-duplicated by its
   * `transient_id` (so re-ingesting the same QR/URI is a no-op), decrypted with
   * the local `lxmf.delivery` destination, and dispatched through the same
   * `message` event path as a network-delivered message. Paper messages always
   * disable stamp enforcement (`LXMRouter.lxmf_propagation` is_paper_message).
   *
   * The sender's signature is verified when their identity is already known
   * (recalled from a prior announce); otherwise the message is still delivered
   * with an unverified signature, exactly like the Python reference.
   *
   * @param {string} uri - The `lxm://` paper message URI.
   * @returns {Promise<Message|null>} The reconstructed message, or `null` when
   *   the URI is not addressed to this node (decryption fails) or was already
   *   ingested.
   */
  async ingestUri(uri) {
    if (!this.deliveryDest) {
      throw new Error("Router not initialized; call init() first.");
    }
    const paperData = Message.paperDataFromUri(uri);
    const transientId = await Message.transientIdFromPropagationData(paperData);
    const transientHex = toHex(transientId);
    if (this.processedTransientIds.has(transientHex)) {
      log("LXMF", `Paper message ${transientHex} already ingested; ignoring.`);
      return null;
    }
    this.processedTransientIds.set(transientHex, Date.now() / 1000);

    const message = await Message.fromPaperData(paperData, this.deliveryDest);
    if (!message) {
      log("LXMF", "Paper URI not addressed to this node (decryption failed).");
      return null;
    }

    log("LXMF", `Ingested paper message from ${toHex(message.sourceHash)}`);
    const senderIdentity = await Destination.recall(message.sourceHash);
    await this._dispatchMessage(message, null, senderIdentity ?? undefined);
    return message;
  }

  /**
   * Serializes and sends an LXMF message.
   *
   * When delivering over a link, this waits for the link to become ACTIVE and
   * then sends LINKIDENTIFY (once per initiator link) *before* the message
   * DATA — Python LXMF otherwise drops packets that arrive before identify.
   * @param {Message} message
   * @param {Identity} senderIdentity
   * @param {Uint8Array|null} linkId
   * @returns {Promise<void>}
   */
  async send(message, senderIdentity, linkId) {
    const { messageId, wireData } = await message.serialize(senderIdentity);
    log("LXMF", `DEBUG: Sending LXMF Message ID: ${toHex(messageId)}`);
    log("LXMF", `DEBUG: Sending to ${toHex(message.destinationHash)}`);

    const DESTINATION_LENGTH = 16; // RNS TRUNCATED_HASHLENGTH//8

    // Direct delivery happens over a Link. The full LXMF body
    // (dest_hash || source_hash || signature || payload) travels inside the
    // link, Token-encrypted by link.send() (LXMF.md §5.2). `createLink()`
    // resolves as soon as the handshake is *initiated*, but the session token
    // is only derived once the handshake completes and the Link becomes ACTIVE.
    // Wait for that so we don't try to encrypt with a token that doesn't exist.
    if (linkId) {
      const linkKey = toHex(linkId);
      const link = this.rns.transport.activeLinks.get(linkKey);
      if (link) {
        await link.whenActive();
        // Python LXMF will not process application DATA on a link until the
        // initiator has sent LINKIDENTIFY (it drops anything arriving before
        // that). We enforce the counterpart on our side: identify ourselves to
        // the responder before sending the message, once per initiator link.
        if (link.initiator && !this.identifiedLinks.has(linkKey)) {
          await link.identify(senderIdentity);
          this.identifiedLinks.add(linkKey);
        }
        // §5.2/§10.1: a DIRECT body larger than the Link MDU must be sent as a
        // Resource. The boundary is exactly the Link MDU (431 B at mtu 500);
        // the spec's "319-byte LXMF content size" is the same threshold
        // expressed as `MDU − LXMF_OVERHEAD(112)`.
        if (wireData.length > link.mdu) {
          if (!link.bz2) link.bz2 = this.rns.compressionProvider || undefined;
          const resource = new Resource({
            data: wireData,
            link,
            bz2: link.bz2,
          });
          await resource.advertise();
          // Wait for the full DIRECT body to be transferred before returning;
          // advertise() alone only signals that a Resource is available.
          await this._awaitOutgoingResource(resource, link);
          return;
        }
      }
      const linkPacket = new Packet({
        packetType: PacketType.DATA,
        contextFlag: true,
        contextByte: ContextType.NONE,
        destinationHash: message.destinationHash,
        destinationType: DestType.SINGLE,
        transportType: 0,
        payload: wireData,
      });
      await this.rns.transport.sendPacket(linkPacket, linkId);
      return;
    }

    // Opportunistic delivery: a single encrypted DATA packet addressed
    // directly to the recipient's lxmf.delivery destination (LXMF.md §5.1).
    //
    // The leading destination hash is stripped from the LXMF body — it is
    // conveyed by the outer Reticulum packet envelope and re-prepended by the
    // receiver (Python LXMRouter.delivery_packet). The remainder is encrypted
    // with the recipient's public key via Destination.send, exactly mirroring
    // LXMessage.__as_packet for the OPPORTUNISTIC case. Sending the plaintext
    // body unencrypted causes the recipient's identity.decrypt() to return
    // null and silently drop the message.
    const peerIdentity = await Destination.recall(message.destinationHash);
    if (!peerIdentity) {
      throw new Error(
        `Cannot deliver opportunistically: identity for ${toHex(message.destinationHash)} is unknown`,
      );
    }
    const peerDestination = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      peerIdentity,
      this.rns,
    );
    const opportunisticPacket = new Packet({
      packetType: PacketType.DATA,
      contextFlag: true,
      contextByte: ContextType.NONE,
      destinationHash: message.destinationHash,
      destinationType: DestType.SINGLE,
      transportType: 0,
      payload: wireData.subarray(DESTINATION_LENGTH),
    });
    await peerDestination.send(opportunisticPacket);
  }
}
