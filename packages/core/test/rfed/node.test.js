/**
 * rfed node (work doc #25, Phase 2).
 *
 * Exercises the production `RFedNode` against a loopback mesh: a JS node
 * serving JS client(s) end-to-end (subscribe → publish → live fanout;
 * deferred → pull; deferred → announce-drain; stamp enforcement; unsubscribe),
 * and a two-client relay through one node (publisher → node → subscriber).
 *
 * The `LoopbackTransport` mirrors the real `Transport` closely enough for
 * rfed: it routes DATA/LINKREQUEST packets to bound destinations and active
 * links, and dispatches an `"announce"` event on ANNOUNCE packets so the
 * node's subscriber-presence tracker fires (the only announce field the node
 * reads is `destinationHash`).
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Allow, Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
  PacketType as PT,
} from "../../src/core/packet.js";
import { Message } from "../../src/lxmf/message.js";
import { unwrapChannelMessage } from "../../src/rfed/blob.js";
import { deliveryHashFor, deriveChannel } from "../../src/rfed/channel.js";
import { RFedClient } from "../../src/rfed/client.js";
import { RFedNode } from "../../src/rfed/node.js";
import { SubscriptionTable } from "../../src/rfed/subscription.js";
import { toHex } from "../../src/utils/encoding.js";
import { MicroMsgPack } from "../../src/utils/msgpack.js";

/** Polls `fn` every 10 ms until truthy or `timeoutMs` elapses. */
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline)
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

// ─── Loopback mesh ────────────────────────────────────────────────────────

class Wire {
  constructor() {
    /** @type {LoopbackTransport[]} */
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
        .catch((err) =>
          console.error("loopback route error:", String(err).slice(0, 160)),
        );
    }
    return true;
  }
  async _route(packet) {
    // Real Transport validates the announce and emits `"announce"`; the node
    // only consumes `destinationHash`, so that is all we synthesise here.
    if (packet.packetType === PT.ANNOUNCE) {
      this.dispatchEvent(
        new CustomEvent("announce", {
          detail: { destinationHash: packet.destinationHash },
        }),
      );
    }
    const dh = toHex(packet.destinationHash);
    if (this.activeLinks.has(dh)) {
      await this.activeLinks.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      await this.destinations.get(dh).receive(packet, this);
    }
  }
}

/** @returns {Promise<{identity: Identity, rns: any, transport: LoopbackTransport}>} */
async function makeRns() {
  const identity = await Identity.generate();
  const transport = new LoopbackTransport();
  const rns = {
    transport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
    // Destination._emitAnnounce sends via `interfaceLayer.broadcast`; the real
    // RNS fans that out to every interface. Forward it to the loopback wire so
    // announces reach the node's presence tracker.
    broadcast: (/** @type {any} */ packet) => transport.sendPacket(packet),
  };
  return { identity, rns, transport };
}

/** The subscriber's `rfed.delivery` destination hash (what `listen()` announces). */
async function rfedDeliveryHash(identity) {
  const d = await Destination.OUT("rfed.delivery", DestType.SINGLE, identity);
  return /** @type {Uint8Array} */ (d.destinationHash);
}

/**
 * Stands up an RFedNode + one client on a shared loopback wire, with the
 * node's identity recallable from each of its service-destination hashes.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.nodeConfig]
 * @returns {Promise<{node: RFedNode, nodeHash: Uint8Array, client: RFedClient, clientDeliveryHash: Uint8Array}>}
 */
async function fixture({ nodeConfig = {} } = {}) {
  const wire = new Wire();
  const nodeRns = await makeRns();
  const clientRns = await makeRns();
  wire.attach(nodeRns.transport);
  wire.attach(clientRns.transport);

  const node = new RFedNode({
    identity: nodeRns.identity,
    rns: nodeRns.rns,
    config: nodeConfig,
  });
  await node.start();

  // Make the node identity recallable by the client from any of its dest hashes.
  const nodeNames = [
    "rfed.node",
    "rfed.channel.subscribe",
    "rfed.channel.unsubscribe",
    "rfed.channel.publish",
    "rfed.channel.pull",
  ];
  for (const name of nodeNames) {
    const d = await Destination.OUT(name, DestType.SINGLE, nodeRns.identity);
    await Destination.remember(
      rnd(16),
      d.destinationHash,
      nodeRns.identity.publicKey,
      null,
    );
  }
  const nodeHash = (
    await Destination.OUT(
      "rfed.channel.subscribe",
      DestType.SINGLE,
      nodeRns.identity,
    )
  ).destinationHash;

  const client = new RFedClient({
    identity: clientRns.identity,
    rns: clientRns.rns,
  });
  const clientDeliveryHash = await rfedDeliveryHash(clientRns.identity);

  return { node, nodeHash, client, clientDeliveryHash };
}

/** Unwraps a pulled/raw inner blob for a channel name. */
async function unwrapForChannelName(innerBlob, channelName) {
  const channel = await deriveChannel(channelName);
  const deliveryHash = await deliveryHashFor(channel.identity);
  return unwrapChannelMessage({
    innerBlob,
    channelIdentity: channel.identity,
    channelDeliveryHash: deliveryHash,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("RFedNode — serves a JS client (live fanout)", () => {
  test("a subscribed, listening client receives its own publish", async () => {
    const { node, nodeHash, client, clientDeliveryHash } = await fixture();

    const sub = await client.subscribe(nodeHash, "public.live");
    assert.strictEqual(sub.ok, true);
    assert.strictEqual(sub.stampCost, null); // stamping disabled by default

    const received = [];
    await client.listen((d) => received.push(d));
    // Wait until the node has heard the client's rfed.delivery announce, so the
    // publish goes live rather than being deferred.
    await waitFor(() => node.isOnline(clientDeliveryHash));

    await client.publish(
      nodeHash,
      "public.live",
      new Message({ content: "hello node" }),
    );

    const decoded = await waitFor(() => received[0]);
    assert.strictEqual(decoded.message.content, "hello node");
    assert.strictEqual(decoded.signatureValid, true);
    assert.strictEqual(decoded.channelName, "public.live");
    assert.strictEqual(toHex(decoded.channelHash), toHex(decoded.channelHash));
  });

  test("two clients relay a message end-to-end through one node", async () => {
    // Publisher and subscriber are distinct identities on the same node.
    const wire = new Wire();
    const nodeRns = await makeRns();
    const subRns = await makeRns();
    const pubRns = await makeRns();
    wire.attach(nodeRns.transport);
    wire.attach(subRns.transport);
    wire.attach(pubRns.transport);

    const node = new RFedNode({
      identity: nodeRns.identity,
      rns: nodeRns.rns,
    });
    await node.start();
    for (const name of [
      "rfed.node",
      "rfed.channel.subscribe",
      "rfed.channel.unsubscribe",
      "rfed.channel.publish",
      "rfed.channel.pull",
    ]) {
      const d = await Destination.OUT(name, DestType.SINGLE, nodeRns.identity);
      await Destination.remember(
        rnd(16),
        d.destinationHash,
        nodeRns.identity.publicKey,
        null,
      );
    }
    const nodeHash = (
      await Destination.OUT(
        "rfed.channel.subscribe",
        DestType.SINGLE,
        nodeRns.identity,
      )
    ).destinationHash;

    const subscriber = new RFedClient({
      identity: subRns.identity,
      rns: subRns.rns,
    });
    const publisher = new RFedClient({
      identity: pubRns.identity,
      rns: pubRns.rns,
    });
    const subDeliveryHash = await rfedDeliveryHash(subRns.identity);

    await subscriber.subscribe(nodeHash, "public.relay");
    const received = [];
    await subscriber.listen((d) => received.push(d));
    await waitFor(() => node.isOnline(subDeliveryHash));

    await publisher.publish(
      nodeHash,
      "public.relay",
      new Message({ content: "relay body" }),
    );

    const decoded = await waitFor(() => received[0]);
    assert.strictEqual(decoded.message.content, "relay body");
    assert.strictEqual(decoded.signatureValid, true);
    // The sender is the publisher, not the subscriber.
    assert.deepStrictEqual(
      toHex(decoded.senderPub),
      toHex(await pubRns.identity.getPublicKey()),
    );
  });
});

describe("RFedNode — deferred delivery", () => {
  test("offline subscriber: blob deferred, retrieved via /rfed/pull", async () => {
    const { nodeHash, client } = await fixture();

    // Subscribe but DO NOT listen → node considers the subscriber offline.
    const sub = await client.subscribe(nodeHash, "public.deferred");
    assert.strictEqual(sub.ok, true);

    await client.publish(
      nodeHash,
      "public.deferred",
      new Message({ content: "while away" }),
    );
    // Let the loopback settle (no live delivery should occur).
    await new Promise((r) => setTimeout(r, 150));

    const { items, morePending } = await client.pull(
      nodeHash,
      "public.deferred",
    );
    assert.strictEqual(items.length, 1);
    assert.strictEqual(morePending, false);

    const decoded = await unwrapForChannelName(
      items[0].blob,
      "public.deferred",
    );
    assert.strictEqual(decoded.message.content, "while away");
    assert.strictEqual(decoded.signatureValid, true);
  });

  test("offline subscriber: blob deferred, flushed when rfed.delivery announces", async () => {
    const { node, nodeHash, client } = await fixture();

    await client.subscribe(nodeHash, "public.drain");
    await client.publish(
      nodeHash,
      "public.drain",
      new Message({ content: "queued" }),
    );
    await new Promise((r) => setTimeout(r, 150)); // deferred, not delivered

    const received = [];
    // listen() announces rfed.delivery → the node drains the deferred queue.
    await client.listen((d) => received.push(d));

    const decoded = await waitFor(() => received[0]);
    assert.strictEqual(decoded.message.content, "queued");
    assert.strictEqual(decoded.signatureValid, true);
    // The queue has been drained for this subscriber.
    assert.strictEqual(
      node.deferred.hasPending(client.identity.identityHash),
      false,
    );
  });
});

describe("RFedNode — stamp enforcement", () => {
  test("subscribe advertises the cost and a stamped publish is delivered", async () => {
    const { node, nodeHash, client, clientDeliveryHash } = await fixture({
      nodeConfig: { stampCost: 8 },
    });

    const sub = await client.subscribe(nodeHash, "public.pow");
    assert.strictEqual(sub.ok, true);
    assert.strictEqual(sub.stampCost, 8);

    const received = [];
    await client.listen((d) => received.push(d));
    await waitFor(() => node.isOnline(clientDeliveryHash));

    await client.publish(
      nodeHash,
      "public.pow",
      new Message({ content: "stamped" }),
    );
    const decoded = await waitFor(() => received[0], 8000);
    assert.strictEqual(decoded.message.content, "stamped");
    assert.strictEqual(decoded.signatureValid, true);

    // The stamped blob was stored in the sync-side store.
    const chHash = (await deriveChannel("public.pow")).channelHash;
    assert.strictEqual(node.blobStore.messageIdsForChannel(chHash).length, 1);
  });

  test("an under-stamped publish (no cached cost) is silently dropped", async () => {
    const { node, nodeHash, client } = await fixture({
      nodeConfig: { stampCost: 8 },
    });

    // No subscribe → no cached stamp cost → the client publishes stamp-less,
    // which the node must reject at ingest.
    await client.publish(
      nodeHash,
      "public.dropped",
      new Message({ content: "no stamp" }),
    );
    await new Promise((r) => setTimeout(r, 200));

    const chHash = (await deriveChannel("public.dropped")).channelHash;
    assert.strictEqual(
      node.blobStore.messageIdsForChannel(chHash).length,
      0,
      "under-stamped publish must not be stored",
    );
  });
});

describe("RFedNode — unsubscribe", () => {
  test("after unsubscribe, no further fanout reaches the subscriber", async () => {
    const { node, nodeHash, client, clientDeliveryHash } = await fixture();

    await client.subscribe(nodeHash, "public.unsub");
    const received = [];
    await client.listen((d) => received.push(d));
    await waitFor(() => node.isOnline(clientDeliveryHash));

    await client.publish(
      nodeHash,
      "public.unsub",
      new Message({ content: "before" }),
    );
    await waitFor(() => received.length >= 1);

    const res = await client.unsubscribe(nodeHash, "public.unsub");
    assert.strictEqual(res.ok, true);

    await client.publish(
      nodeHash,
      "public.unsub",
      new Message({ content: "after" }),
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(
      received.length,
      1,
      "no further fanout after unsubscribe",
    );
  });
});

describe("RFedNode — blob store records every ingest", () => {
  test("stored blobs are keyed by channel hash with random message ids", async () => {
    const { node, nodeHash, client, clientDeliveryHash } = await fixture();

    await client.subscribe(nodeHash, "public.store");
    await client.listen(() => {});
    await waitFor(() => node.isOnline(clientDeliveryHash));

    await client.publish(
      nodeHash,
      "public.store",
      new Message({ content: "one" }),
    );
    await client.publish(
      nodeHash,
      "public.store",
      new Message({ content: "two" }),
    );
    await new Promise((r) => setTimeout(r, 150));

    const chHash = (await deriveChannel("public.store")).channelHash;
    const ids = node.blobStore.messageIdsForChannel(chHash);
    assert.strictEqual(ids.length, 2);
    assert.strictEqual(ids[0].length, 16);
    assert.notStrictEqual(toHex(ids[0]), toHex(ids[1]));
  });
});

describe("RFedNode — periodic maintenance (Phase 3)", () => {
  test("tickMaintenance prunes expired deferred entries", async () => {
    // No transport round-trip needed: drive the deferred queue directly with a
    // backdated entry, then let tickMaintenance (7-day TTL) evict it.
    const { node } = await fixture();
    const sub = rnd(16);
    const chan = (await deriveChannel("public.maint")).channelHash;
    node.deferred.enqueue(sub, chan, new Uint8Array([1, 2, 3]), 256);
    assert.strictEqual(node.deferred.hasPending(sub), true);

    // Backdate the entry past the 7-day TTL.
    const bucket = node.deferred._buckets.get(toHex(sub));
    assert.ok(bucket && bucket.length === 1);
    bucket[0].enqueuedAt = Date.now() / 1000 - 8 * 24 * 3600;

    const { deferredEvicted } = node.tickMaintenance();
    assert.strictEqual(deferredEvicted, 1);
    assert.strictEqual(node.deferred.hasPending(sub), false);
  });

  test("tickMaintenance prunes expired blobs", async () => {
    const { node } = await fixture();
    const chan = rnd(16);
    const id = node.blobStore.store(chan, new Uint8Array([9, 9]));
    assert.strictEqual(node.blobStore.get(id)?.length, 2);

    // Backdate the blob past the 30-day TTL, then let tickMaintenance evict it.
    const meta = node.blobStore._meta.get(toHex(id));
    assert.ok(meta);
    meta.received = Date.now() / 1000 - 31 * 24 * 3600;

    const { blobsEvicted } = node.tickMaintenance();
    assert.strictEqual(blobsEvicted, 1);
    assert.strictEqual(node.blobStore.get(id), null);
  });
});

describe("RFedNode — tiered deferred limits (Phase 3)", () => {
  test("policyFor overrides the per-subscriber deferred cap", async () => {
    // A VIP subscriber gets a larger queue than the default tier.
    const wire = new Wire();
    const nodeRns = await makeRns();
    wire.attach(nodeRns.transport);
    const vipHash = rnd(16);
    const node = new RFedNode({
      identity: nodeRns.identity,
      rns: nodeRns.rns,
      config: {
        deferredQueueLimit: 2, // default tier: tiny
        policyFor: (h) =>
          toHex(h) === toHex(vipHash)
            ? { deferredQueueLimit: 10 } // VIP tier
            : { deferredQueueLimit: 2 },
      },
    });
    await node.start();

    const chan = rnd(16);
    // Default-tier subscriber: cap 2 → 3rd enqueue evicts the oldest.
    const defSub = rnd(16);
    for (let i = 0; i < 3; i++)
      node.deferred.enqueue(
        defSub,
        chan,
        new Uint8Array([i]),
        node.policyFor(defSub).deferredQueueLimit,
      );
    assert.strictEqual(node.deferred.drain(defSub).length, 2);

    // VIP subscriber: cap 10 → all 3 survive.
    for (let i = 0; i < 3; i++)
      node.deferred.enqueue(
        vipHash,
        chan,
        new Uint8Array([i]),
        node.policyFor(vipHash).deferredQueueLimit,
      );
    assert.strictEqual(node.deferred.drain(vipHash).length, 3);
  });
});

describe("RFedNode — peer sync (Phase 4)", () => {
  test("two nodes: publisher→A, B syncs from A, subscriber on B receives", async () => {
    const wire = new Wire();
    const aRns = await makeRns();
    const bRns = await makeRns();
    const pubRns = await makeRns();
    const subRns = await makeRns();
    wire.attach(aRns.transport);
    wire.attach(bRns.transport);
    wire.attach(pubRns.transport);
    wire.attach(subRns.transport);

    const nodeA = new RFedNode({ identity: aRns.identity, rns: aRns.rns });
    const nodeB = new RFedNode({ identity: bRns.identity, rns: bRns.rns });
    await nodeA.start();
    await nodeB.start();

    // Make every node identity recallable from each of its dest hashes (needed
    // for OUT dest construction + peer link establishment).
    for (const rns of [aRns, bRns]) {
      for (const name of [
        "rfed.node",
        "rfed.channel.subscribe",
        "rfed.channel.unsubscribe",
        "rfed.channel.publish",
        "rfed.channel.pull",
      ]) {
        const d = await Destination.OUT(name, DestType.SINGLE, rns.identity);
        await Destination.remember(
          rnd(16),
          d.destinationHash,
          rns.identity.publicKey,
          null,
        );
      }
    }
    const aSubHash = (
      await Destination.OUT(
        "rfed.channel.subscribe",
        DestType.SINGLE,
        aRns.identity,
      )
    ).destinationHash;
    const bSubHash = (
      await Destination.OUT(
        "rfed.channel.subscribe",
        DestType.SINGLE,
        bRns.identity,
      )
    ).destinationHash;
    const aNodeHash = (
      await Destination.OUT("rfed.node", DestType.SINGLE, aRns.identity)
    ).destinationHash;

    const publisher = new RFedClient({
      identity: pubRns.identity,
      rns: pubRns.rns,
    });
    const subscriber = new RFedClient({
      identity: subRns.identity,
      rns: subRns.rns,
    });
    const subDeliveryHash = await rfedDeliveryHash(subRns.identity);

    // Subscriber on B subscribes + listens (online on B).
    await subscriber.subscribe(bSubHash, "public.sync");
    const received = [];
    await subscriber.listen((d) => received.push(d));
    await waitFor(() => nodeB.isOnline(subDeliveryHash));

    // Publisher publishes to A. A has no local subscribers → just stores it.
    await publisher.publish(
      aSubHash,
      "public.sync",
      new Message({ content: "synced across two nodes" }),
    );
    // No live delivery yet (subscriber is on B, not A).
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(received.length, 0);
    assert.strictEqual(nodeA.blobStore.allMessageIds().length, 1);

    // B syncs with A: OFFER → gap → GET → ingest → fan out to local subscriber.
    const ingested = await nodeB.syncWithPeer(aNodeHash);
    assert.strictEqual(ingested, 1);

    const decoded = await waitFor(() => received[0]);
    assert.strictEqual(decoded.message.content, "synced across two nodes");
    assert.strictEqual(decoded.signatureValid, true);
    // The blob is now also held by B under the upstream message id.
    assert.strictEqual(nodeB.blobStore.allMessageIds().length, 1);
  });

  test("sync is idempotent — re-sync pulls nothing new", async () => {
    const wire = new Wire();
    const aRns = await makeRns();
    const bRns = await makeRns();
    wire.attach(aRns.transport);
    wire.attach(bRns.transport);

    const nodeA = new RFedNode({ identity: aRns.identity, rns: aRns.rns });
    const nodeB = new RFedNode({ identity: bRns.identity, rns: bRns.rns });
    await nodeA.start();
    await nodeB.start();

    for (const rns of [aRns, bRns]) {
      for (const name of [
        "rfed.node",
        "rfed.channel.subscribe",
        "rfed.channel.publish",
      ]) {
        const d = await Destination.OUT(name, DestType.SINGLE, rns.identity);
        await Destination.remember(
          rnd(16),
          d.destinationHash,
          rns.identity.publicKey,
          null,
        );
      }
    }
    const aNodeHash = (
      await Destination.OUT("rfed.node", DestType.SINGLE, aRns.identity)
    ).destinationHash;

    // Give B a subscription to a channel A holds a blob for.
    const channel = await deriveChannel("public.idem");
    const aSubHash = (
      await Destination.OUT(
        "rfed.channel.subscribe",
        DestType.SINGLE,
        aRns.identity,
      )
    ).destinationHash;
    // Simulate A already holding a blob + B subscribed to that channel.
    const innerBlob = rnd(32);
    nodeA.blobStore.store(channel.channelHash, innerBlob);
    await nodeB.subscriptions.subscribe(
      await Identity.generate(),
      channel.channelHash,
    );

    const first = await nodeB.syncWithPeer(aNodeHash);
    assert.strictEqual(first, 1);
    // Second sync: B already holds the id → gap empty → 0 pulled.
    const second = await nodeB.syncWithPeer(aNodeHash);
    assert.strictEqual(second, 0);
  });
});

describe("RFedNode — notify wake-ups (Phase 5)", () => {
  test("offline subscriber: deferred publish wakes the registered relay", async () => {
    const wire = new Wire();
    const nodeRns = await makeRns();
    const subRns = await makeRns();
    const pubRns = await makeRns();
    const relayRns = await makeRns();
    wire.attach(nodeRns.transport);
    wire.attach(subRns.transport);
    wire.attach(pubRns.transport);
    wire.attach(relayRns.transport);

    const node = new RFedNode({ identity: nodeRns.identity, rns: nodeRns.rns });
    await node.start();
    for (const name of [
      "rfed.node",
      "rfed.channel.subscribe",
      "rfed.channel.unsubscribe",
      "rfed.channel.publish",
      "rfed.channel.pull",
      "rfed.notify",
      "rfed.notify.register",
      "rfed.notify.unregister",
    ]) {
      const d = await Destination.OUT(name, DestType.SINGLE, nodeRns.identity);
      await Destination.remember(
        rnd(16),
        d.destinationHash,
        nodeRns.identity.publicKey,
        null,
      );
    }
    const nodeHash = (
      await Destination.OUT(
        "rfed.notify.register",
        DestType.SINGLE,
        nodeRns.identity,
      )
    ).destinationHash;

    // Relay: an inbound rfed.notify destination that records wake packets.
    const relayDest = await Destination.IN(
      "rfed.notify",
      DestType.SINGLE,
      relayRns.identity,
      relayRns.rns,
    );
    const relayHash = relayDest.destinationHash;
    const wakes = [];
    relayDest.addEventListener("data", (/** @type {any} */ e) =>
      wakes.push(e.detail.plaintext),
    );
    relayRns.transport.bindLocalDestination(relayDest);
    // Make the relay identity recallable by its rfed.notify hash (the node
    // builds an OUT dest from it on wake dispatch).
    await Destination.remember(
      rnd(16),
      relayHash,
      relayRns.identity.publicKey,
      null,
    );

    const subscriber = new RFedClient({
      identity: subRns.identity,
      rns: subRns.rns,
    });
    const publisher = new RFedClient({
      identity: pubRns.identity,
      rns: pubRns.rns,
    });

    // Subscribe but DO NOT listen → offline. Register a notify relay for the
    // channel, scoped to the relay's rfed.notify hash.
    await subscriber.subscribe(nodeHash, "public.notify");
    const ok = await subscriber.registerNotify(
      nodeHash,
      toHex(relayHash),
      "public.notify",
    );
    assert.strictEqual(ok, true);
    assert.strictEqual(node.notifyRegistry.count, 1);

    // Publish while the subscriber is offline → deferred + notify wake.
    await publisher.publish(
      nodeHash,
      "public.notify",
      new Message({ content: "wake me up" }),
    );

    const wake = await waitFor(() => wakes[0]);
    const map = MicroMsgPack.decode(wake);
    // §9.3: receiver = subscriber identity hash, channel = channel hash.
    const channel = await deriveChannel("public.notify");
    assert.deepStrictEqual(toHex(map.channel), toHex(channel.channelHash));
    assert.strictEqual(map.sender, undefined); // fire-and-forget SEND has no sender
    assert.strictEqual(wakes.length, 1);
  });

  test("clearNotify removes all registrations for the subscriber", async () => {
    const { nodeHash, client, node } = await fixture();
    const relay = toHex(rnd(16));

    await client.registerNotify(nodeHash, relay, "public.a");
    await client.registerNotify(nodeHash, relay, "public.b");
    assert.strictEqual(node.notifyRegistry.count, 2);

    const cleared = await client.clearNotify(nodeHash);
    assert.strictEqual(cleared, true);
    assert.strictEqual(node.notifyRegistry.count, 0);
  });
});

// ─── Phase 6: backup failover (SPEC §11) ─────────────────────────────────

describe("RFedNode — backup failover (Phase 6)", () => {
  test("SubscriptionTable: subscribeBackup + backupEntriesForTick + prune", async () => {
    const subs = new SubscriptionTable();
    const owner = rnd(16);
    const sub = rnd(16);
    const ch = rnd(16);

    subs.subscribeBackup(sub, ch, owner);
    assert.strictEqual(subs.length, 1);
    // Idempotent refresh (same sub/ch/owner) — bumps heartbeat, no duplicate.
    subs.subscribeBackup(sub, ch, owner);
    assert.strictEqual(subs.length, 1);

    const entries = subs.backupEntriesForTick();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(toHex(entries[0].ownerNodeHash), toHex(owner));

    // A primary entry is not a backup entry.
    await subs.subscribe(await Identity.generate(), rnd(16));
    assert.strictEqual(subs.backupEntriesForTick().length, 1);

    // pruneStaleBackups only touches backup entries.
    assert.strictEqual(subs.pruneStaleBackups(1e9), 0);
    // Backdate the backup entry → pruneable.
    subs._entries[0].lastRefreshed = 0;
    assert.strictEqual(subs.pruneStaleBackups(90), 1);
    assert.strictEqual(subs.length, 1); // primary entry survives
  });

  test("backup/push handler: registers backup subs + trust gate", async () => {
    const nodeRns = await makeRns();
    const wire = new Wire();
    wire.attach(nodeRns.transport);
    const node = new RFedNode({ identity: nodeRns.identity, rns: nodeRns.rns });
    await node.start();

    // Owner identity + the pairs it pushes.
    const owner = await Identity.generate();
    const subHash = (await Identity.fromPublicKey(owner.publicKey))
      .identityHash;
    const ch = rnd(16);
    const pairsMsgpack = MicroMsgPack.encode([[subHash, ch]]);
    const pubkey = await owner.getPublicKey();
    const sig = await owner.sign(pairsMsgpack);
    // The link decodes the msgpack request body before invoking the handler,
    // so the handler receives the decoded `[value, pubkey, sig]` array.
    const payload = [pairsMsgpack, pubkey, sig];

    const ok = await node._handleBackupPush(payload);
    assert.strictEqual(ok, true);
    assert.strictEqual(node.subscriptions.backupEntriesForTick().length, 1);

    // Trust gate: with trustedBackupPeers set, an untrusted owner is rejected.
    const node2Rns = await makeRns();
    const wire2 = new Wire();
    wire2.attach(node2Rns.transport);
    const node2 = new RFedNode({
      identity: node2Rns.identity,
      rns: node2Rns.rns,
      config: { trustedBackupPeers: [rnd(16)] },
    });
    await node2.start();
    const ok2 = await node2._handleBackupPush(payload);
    assert.strictEqual(ok2, false);
    assert.strictEqual(node2.subscriptions.backupEntriesForTick().length, 0);
  });

  test("fanout suppresses backup sub while owner is reachable", async () => {
    const nodeRns = await makeRns();
    const wire = new Wire();
    wire.attach(nodeRns.transport);
    const node = new RFedNode({ identity: nodeRns.identity, rns: nodeRns.rns });
    await node.start();

    const owner = rnd(16);
    const subHash = rnd(16);
    const ch = rnd(16);
    node.subscriptions.subscribeBackup(subHash, ch, owner);
    node.blobStore.store(ch, rnd(20));

    // Owner silent → failover: blob deferred for the backup subscriber.
    await node._fanout(ch, rnd(12));
    assert.strictEqual(node.deferred.hasPending(subHash), true);

    // Owner now reachable (announce within ownerOfflineSecs) → suppressed.
    node.deferred.enqueue(subHash, ch, rnd(8), 256); // ensure drainable state resets
    node._presence.set(toHex(owner), Date.now() / 1000);
    // New blob, new fanout: no NEW deferral for this subscriber beyond what
    // the suppressed path skips. Clear and re-check.
    node.deferred.drain(subHash);
    const before = node.deferred.hasPending(subHash);
    await node._fanout(ch, rnd(12));
    assert.strictEqual(before, false);
    assert.strictEqual(node.deferred.hasPending(subHash), false);
  });

  test("failover tick dumps channel backlog when owner goes silent", async () => {
    const nodeRns = await makeRns();
    const wire = new Wire();
    wire.attach(nodeRns.transport);
    const node = new RFedNode({ identity: nodeRns.identity, rns: nodeRns.rns });
    await node.start();

    const owner = rnd(16);
    const subHash = rnd(16);
    const ch = rnd(16);
    node.subscriptions.subscribeBackup(subHash, ch, owner);
    // Two blobs in the channel store.
    node.blobStore.store(ch, rnd(20));
    node.blobStore.store(ch, rnd(20));

    // Owner silent → tick adopts the subscriber + enqueues the backlog.
    const adopted = node._backupDeliveryTick();
    assert.strictEqual(adopted.length, 1);
    assert.strictEqual(node.deferred.hasPending(subHash), true);
    const drained = node.deferred.drain(subHash);
    assert.ok(drained.length >= 2);
  });

  test("two-node e2e: primary pushes subscription to backup, then fails over", async () => {
    const wire = new Wire();
    const primaryRns = await makeRns();
    const backupRns = await makeRns();
    wire.attach(primaryRns.transport);
    wire.attach(backupRns.transport);

    const primaryNodeHash = (
      await Destination.OUT("rfed.node", DestType.SINGLE, primaryRns.identity)
    ).destinationHash;

    const primary = new RFedNode({
      identity: primaryRns.identity,
      rns: primaryRns.rns,
      config: { primaryNode: primaryNodeHash },
    });
    // Point the primary at the backup's rfed.node hash as its backup target.
    const backupNodeHash = (
      await Destination.OUT("rfed.node", DestType.SINGLE, backupRns.identity)
    ).destinationHash;
    primary.primaryNode = backupNodeHash;
    const backup = new RFedNode({
      identity: backupRns.identity,
      rns: backupRns.rns,
    });
    await primary.start();
    await backup.start();

    // Make each node's identity recallable by the other.
    for (const rns of [primaryRns, backupRns]) {
      for (const name of ["rfed.node", "rfed.channel.subscribe"]) {
        const d = await Destination.OUT(name, DestType.SINGLE, rns.identity);
        await Destination.remember(
          rnd(16),
          d.destinationHash,
          rns.identity.publicKey,
          null,
        );
      }
    }

    // A subscriber subscribes on the PRIMARY.
    const channel = await deriveChannel("public.failover");
    const subIdentity = await Identity.generate();
    const subHash = subIdentity.identityHash;
    await primary.subscriptions.subscribe(subIdentity, channel.channelHash);
    // Mirror what /rfed/subscribe does: queue the pair for backup push.
    primary._pendingBackupPushes.push([subHash, channel.channelHash]);

    // Backup tick: primary pushes its subscription to the backup.
    const res = await primary.tickBackupDelivery();
    assert.strictEqual(res.pushed, 1);
    // The backup now holds a backup entry tagged with the primary's node hash.
    await waitFor(
      () => backup.subscriptions.backupEntriesForTick().length === 1,
    );
    const held = backup.subscriptions.backupEntriesForTick()[0];
    assert.strictEqual(toHex(held.ownerNodeHash), toHex(primaryNodeHash));
    assert.strictEqual(toHex(held.subscriberHash), toHex(subHash));

    // Backup ingests a blob for the channel (e.g. via sync) while the primary
    // is still "online" → suppressed (no deferral yet).
    backup.blobStore.store(channel.channelHash, rnd(24));
    // Mark the primary reachable on the backup's presence map.
    backup._presence.set(toHex(primaryNodeHash), Date.now() / 1000);
    await backup._fanout(channel.channelHash, rnd(16));
    assert.strictEqual(backup.deferred.hasPending(subHash), false);

    // Primary goes silent → backup failover tick dumps the backlog.
    backup._presence.delete(toHex(primaryNodeHash));
    backup._backupDeliveryTick();
    assert.strictEqual(backup.deferred.hasPending(subHash), true);
  });
});
