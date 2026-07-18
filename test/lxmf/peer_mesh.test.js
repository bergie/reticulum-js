/**
 * Peer-mesh sync (§5.8.4): unit tests for the MessageStore per-peer tracking
 * and the PropagationNode `/offer` handler, plus an end-to-end peering
 * round-trip over a loopback mesh (submit → distribute → peer-sync → recipient
 * sync from the second node).
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType } from "../../src/core/packet.js";
import {
  PEER_ERROR_INVALID_KEY,
  PEER_ERROR_NO_IDENTITY,
} from "../../src/lxmf/constants.js";
import { Message } from "../../src/lxmf/message.js";
import { MessageStore } from "../../src/lxmf/message_store.js";
import { PropagationNode } from "../../src/lxmf/propagation_node.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import {
  generateStamp,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
} from "../../src/lxmf/stamper.js";
import { toHex } from "../../src/utils/encoding.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/** @returns {{transientId: Uint8Array, destinationHash: Uint8Array, lxmfData: Uint8Array, stampData: Uint8Array, received: number, stampValue: number, size: number, handledPeers: Set<string>, unhandledPeers: Set<string>}} */
function entry(received = 1000) {
  return {
    transientId: rnd(32),
    destinationHash: rnd(16),
    lxmfData: rnd(80),
    stampData: new Uint8Array(32),
    received,
    stampValue: 10,
    size: 112,
    handledPeers: new Set(),
    unhandledPeers: new Set(),
  };
}

describe("MessageStore per-peer tracking", () => {
  test("markUnhandled/markHandled drive the unhandled-for-peer list", () => {
    const store = new MessageStore();
    const e = entry();
    store.add(e);
    const peer = rnd(16);

    assert.strictEqual(store.unhandledEntriesForPeer(peer).length, 0);
    store.markUnhandledForPeer(e.transientId, peer);
    assert.strictEqual(store.unhandledEntriesForPeer(peer).length, 1);
    store.markHandledForPeer(e.transientId, peer);
    assert.strictEqual(store.unhandledEntriesForPeer(peer).length, 0);
  });

  test("unhandled entries are sorted by weight ascending (size × age)", () => {
    const store = new MessageStore();
    const peer = rnd(16);
    const big = entry(Date.now() / 1000); // newer, large-ish
    big.size = 500;
    const small = entry(Date.now() / 1000); // newer, small
    small.size = 100;
    store.add(big);
    store.add(small);
    store.markUnhandledForPeer(big.transientId, peer);
    store.markUnhandledForPeer(small.transientId, peer);

    const list = store.unhandledEntriesForPeer(peer);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].size, 100);
    assert.strictEqual(list[1].size, 500);
  });

  test("entries below minAcceptedCost are excluded", () => {
    const store = new MessageStore();
    const peer = rnd(16);
    const low = entry();
    low.stampValue = 2;
    const high = entry();
    high.stampValue = 20;
    store.add(low);
    store.add(high);
    store.markUnhandledForPeer(low.transientId, peer);
    store.markUnhandledForPeer(high.transientId, peer);
    assert.strictEqual(store.unhandledEntriesForPeer(peer, 10).length, 1);
  });
});

describe("PropagationNode /offer handler", () => {
  test("returns the wanted subset (ids the node does not have)", async () => {
    const nodeIdentity = await Identity.generate();
    const remoteIdentity = await Identity.generate();
    const PEERING_COST = 8;
    const node = new PropagationNode({
      peeringCost: PEERING_COST,
      getLocalIdentityHash: () => nodeIdentity.identityHash,
    });
    // One message already in the store (handled), one not.
    const present = entry();
    node.store.add(present);
    const absent = entry().transientId;

    // Peering key: stamp over receivingHash ‖ offeringHash at peeringCost.
    const peeringId = new Uint8Array(32);
    peeringId.set(nodeIdentity.identityHash, 0);
    peeringId.set(remoteIdentity.identityHash, 16);
    const [pk] = await generateStamp(
      peeringId,
      PEERING_COST,
      WORKBLOCK_EXPAND_ROUNDS_PEERING,
    );

    const response = await node.handleOfferRequest(remoteIdentity, [
      pk,
      [present.transientId, absent],
    ]);
    assert.ok(Array.isArray(response));
    assert.strictEqual(response.length, 1);
    assert.deepStrictEqual(response[0], absent);
  });

  test("returns true when the node wants every offered message", async () => {
    const nodeIdentity = await Identity.generate();
    const remoteIdentity = await Identity.generate();
    const node = new PropagationNode({
      peeringCost: 8,
      getLocalIdentityHash: () => nodeIdentity.identityHash,
    });
    const peeringId = new Uint8Array(32);
    peeringId.set(nodeIdentity.identityHash, 0);
    peeringId.set(remoteIdentity.identityHash, 16);
    const [pk] = await generateStamp(
      peeringId,
      8,
      WORKBLOCK_EXPAND_ROUNDS_PEERING,
    );

    const response = await node.handleOfferRequest(remoteIdentity, [
      pk,
      [rnd(32), rnd(32)],
    ]);
    assert.strictEqual(response, true);
  });

  test("returns false when the node already has every offered message", async () => {
    const nodeIdentity = await Identity.generate();
    const remoteIdentity = await Identity.generate();
    const node = new PropagationNode({
      peeringCost: 8,
      getLocalIdentityHash: () => nodeIdentity.identityHash,
    });
    const present = entry();
    node.store.add(present);
    const peeringId = new Uint8Array(32);
    peeringId.set(nodeIdentity.identityHash, 0);
    peeringId.set(remoteIdentity.identityHash, 16);
    const [pk] = await generateStamp(
      peeringId,
      8,
      WORKBLOCK_EXPAND_ROUNDS_PEERING,
    );

    const response = await node.handleOfferRequest(remoteIdentity, [
      pk,
      [present.transientId],
    ]);
    assert.strictEqual(response, false);
  });

  test("rejects an invalid peering key", async () => {
    const nodeIdentity = await Identity.generate();
    const remoteIdentity = await Identity.generate();
    const node = new PropagationNode({
      peeringCost: 8,
      getLocalIdentityHash: () => nodeIdentity.identityHash,
    });
    const bogus = rnd(32);
    const response = await node.handleOfferRequest(remoteIdentity, [
      bogus,
      [rnd(32)],
    ]);
    assert.strictEqual(response, PEER_ERROR_INVALID_KEY);
  });

  test("rejects without a remote identity", async () => {
    const node = new PropagationNode({ peeringCost: 8 });
    const response = await node.handleOfferRequest(null, [rnd(32), []]);
    assert.strictEqual(response, PEER_ERROR_NO_IDENTITY);
  });
});

// ---------------------------------------------------------------------------
// End-to-end peering over a shared loopback wire.
// ---------------------------------------------------------------------------

const PEERING_COST = 8; // low PoW for fast tests

/** Shared broadcast wire (every transport sees every packet). */
class Wire {
  constructor() {
    /** @type {any[]} */
    this.transports = [];
  }
  attach(t) {
    t.wire = this;
    this.transports.push(t);
  }
}
class LoopbackTransport extends EventTarget {
  constructor() {
    super();
    this.wire = null;
    this.activeLinks = new Map();
    this.destinations = new Map();
  }
  addLink(hash, link) {
    this.activeLinks.set(toHex(hash), link);
  }
  removeLink(hash) {
    this.activeLinks.delete(toHex(hash));
  }
  bindLocalDestination(dest) {
    this.destinations.set(toHex(dest.destinationHash), dest);
  }
  async sendPacket(packet) {
    for (const peer of this.wire.transports) {
      if (peer === this) continue;
      const p = peer;
      Promise.resolve()
        .then(() => p._route(packet))
        .catch((e) =>
          console.error("loopback route error:", String(e).slice(0, 160)),
        );
    }
    return true;
  }
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.activeLinks.has(dh)) {
      await this.activeLinks.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      await this.destinations.get(dh).receive(packet, this);
    }
  }
}

async function makeNode() {
  const identity = await Identity.generate();
  const transport = new LoopbackTransport();
  const rns = {
    transport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
  };
  return { identity, rns, transport };
}

async function rememberDelivery(identity) {
  const out = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    null,
  );
  await Destination.remember(
    rnd(16),
    out.destinationHash,
    identity.publicKey,
    null,
  );
  return out;
}

/** Polls `fn` until truthy or timeout. */
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline)
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("peer mesh sync over loopback", () => {
  test("node A distributes to peer node B; recipient syncs from B", async () => {
    const wire = new Wire();
    const nodeA = await makeNode();
    const nodeB = await makeNode();
    const sender = await makeNode();
    const recipient = await makeNode();
    for (const n of [nodeA, nodeB, sender, recipient]) wire.attach(n.transport);

    // --- Both nodes enable propagation with a low peering cost. ---
    const routerA = new LXMRouter(nodeA.identity, nodeA.rns);
    await routerA.init();
    await routerA.enablePropagation({
      stampCost: 0,
      stampCostFlexibility: 0,
      peeringCost: PEERING_COST,
      name: "nodeA",
    });
    const routerB = new LXMRouter(nodeB.identity, nodeB.rns);
    await routerB.init();
    await routerB.enablePropagation({
      stampCost: 0,
      stampCostFlexibility: 0,
      peeringCost: PEERING_COST,
      name: "nodeB",
    });

    // Make node B's propagation destination recallable on node A.
    const nodeBPropHash = routerB.propagationDest.destinationHash;
    await Destination.remember(
      rnd(16),
      nodeBPropHash,
      nodeB.identity.publicKey,
      routerB.propagationDest.appData,
    );

    // Recipient + sender delivery destinations known.
    await rememberDelivery(recipient.identity);
    const recipientOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient.identity,
      null,
    );
    const recipientDeliveryHash = recipientOut.destinationHash;
    const senderRouter = new LXMRouter(sender.identity, sender.rns);
    await senderRouter.init();
    await Destination.remember(
      rnd(16),
      senderRouter.deliveryDest.destinationHash,
      sender.identity.publicKey,
      null,
    );

    // Node A peers with node B (advertised costs).
    routerA.peer(nodeBPropHash, {
      stampCost: 0,
      stampCostFlexibility: 0,
      peeringCost: PEERING_COST,
      perTransferLimitKb: 256,
      perSyncLimitKb: 10240,
    });

    // --- Sender submits a message for the recipient to node A. ---
    senderRouter.setOutboundPropagationNode(
      routerA.propagationDest.destinationHash,
    );
    await Destination.remember(
      rnd(16),
      routerA.propagationDest.destinationHash,
      nodeA.identity.publicKey,
      routerA.propagationDest.appData,
    );
    const message = new Message({
      sourceHash: senderRouter.deliveryDest.destinationHash,
      destinationHash: recipientDeliveryHash,
      title: "mesh",
      content: "travels submit -> nodeA -> peer nodeB -> recipient",
      timestamp: 1730000000,
    });
    await senderRouter.submitToPropagationNode(message, sender.identity, {
      stampCost: 0,
    });
    await waitFor(
      () =>
        (routerA.propagationNode?.store.size ?? 0) >= 1 ? true : undefined,
      6000,
    );
    assert.strictEqual(routerA.propagationNode.store.size, 1);

    // --- Node A syncs to its peer node B over the mesh. ---
    await routerA.syncPeers();
    await waitFor(
      () =>
        (routerB.propagationNode?.store.size ?? 0) >= 1 ? true : undefined,
      6000,
    );
    assert.strictEqual(
      routerB.propagationNode.store.size,
      1,
      "node B must hold the distributed message",
    );
    // Node A marked it handled for B (no longer in B's unhandled set).
    assert.strictEqual(routerA.propagationNode.store.size, 1);

    // --- Recipient syncs from node B and receives the message. ---
    const recipientRouter = new LXMRouter(recipient.identity, recipient.rns);
    await recipientRouter.init();
    recipientRouter.setOutboundPropagationNode(nodeBPropHash);
    await Destination.remember(
      rnd(16),
      nodeBPropHash,
      nodeB.identity.publicKey,
      routerB.propagationDest.appData,
    );
    /** @type {Message|null} */
    let received = null;
    recipientRouter.addEventListener("message", (event) => {
      received = /** @type {any} */ (event).detail.message;
    });
    const res = await recipientRouter.syncFromPropagationNode(
      recipient.identity,
      100,
    );
    assert.strictEqual(res.received, 1);
    await waitFor(() => (received ? true : undefined), 3000);
    assert.ok(received, "recipient receives the mesh-distributed message");
    assert.strictEqual(
      received.content,
      "travels submit -> nodeA -> peer nodeB -> recipient",
    );
    assert.ok(await received.verifySignature(sender.identity));
  });
});
