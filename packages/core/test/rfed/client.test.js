/**
 * rfed client (work doc #25, Phase 1) — subscribe / publish / receive / pull
 * over a real loopback mesh.
 *
 * Because no Rust toolchain or vendored `reticulum-rust` is available in this
 * environment, the client is exercised against a minimal in-process JS server
 * fixture (`MinimalRfedNode`) that mirrors the Rust `destinations.rs` handlers'
 * wire behaviour: the same `/rfed/subscribe` signed payload, the same SEND
 * `[channel_hash ‖ inner_blob ‖ stamp]` layout, the same `/rfed/pull` response
 * shape, and the same fanout `[channel_hash ‖ inner_blob]` delivery.
 *
 * The Phase-0 codec (verified against the Python reference) carries the message
 * content, so this test covers the client's transport protocol end-to-end.
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
} from "../../src/core/packet.js";
import { Message } from "../../src/lxmf/message.js";
import { parseSendPayload } from "../../src/rfed/blob.js";
import { deliveryHashFor } from "../../src/rfed/channel.js";
import { RFedClient } from "../../src/rfed/client.js";
import { validateChannelStamp } from "../../src/rfed/stamp.js";
import { toHex } from "../../src/utils/encoding.js";

/** Polls `fn` every 10 ms until it returns truthy or `timeoutMs` elapses. */
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

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

// ─── Loopback mesh ────────────────────────────────────────────────────────

/** Shared broadcast wire: every transport sees every packet. */
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
    broadcast() {},
  };
  return { identity, rns, transport };
}

/**
 * Minimal rfed server fixture — mirrors the Rust `destinations.rs` handlers
 * closely enough to validate the client's wire protocol. Stores blobs in
 * memory, fans out to subscribers live, and serves `/rfed/pull` from a deferred
 * queue. NOT the Phase-2 production node.
 */
class MinimalRfedNode {
  /**
   * @param {Object} opts
   * @param {Identity} opts.identity
   * @param {any} opts.rns
   * @param {number|null} [opts.stampCost]
   */
  constructor({ identity, rns, stampCost = null }) {
    this.identity = identity;
    this.rns = rns;
    this.stampCost = stampCost && stampCost > 0 ? stampCost : null;
    /** channelHashHex → Map<deliveryHashHex, subscriberIdentity> */
    this.subscriptions = new Map();
    /** channelHashHex → Array<{blob, received}> (live store + pull source) */
    this.deferred = new Map();
  }

  /** Bring up the three modern split destinations the client targets. */
  async start() {
    // rfed.channel.subscribe — /rfed/subscribe handler.
    const subscribeDest = await Destination.IN(
      "rfed.channel.subscribe",
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    await subscribeDest.registerRequestHandler("/rfed/subscribe", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data) =>
        this._handleSubscribeAsync(data),
    });
    this.rns.transport.bindLocalDestination(subscribeDest);
    subscribeDest.addEventListener(
      "link_request",
      async (/** @type {any} */ e) => {
        try {
          await subscribeDest.acceptLink(e.detail.packet);
        } catch (err) {
          console.error(
            "subscribe acceptLink error:",
            String(err).slice(0, 120),
          );
        }
      },
    );

    // rfed.channel.unsubscribe — /rfed/unsubscribe handler.
    const unsubscribeDest = await Destination.IN(
      "rfed.channel.unsubscribe",
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    await unsubscribeDest.registerRequestHandler("/rfed/unsubscribe", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data) =>
        this._handleUnsubscribeAsync(data),
    });
    this.rns.transport.bindLocalDestination(unsubscribeDest);
    unsubscribeDest.addEventListener(
      "link_request",
      async (/** @type {any} */ e) => {
        try {
          await unsubscribeDest.acceptLink(e.detail.packet);
        } catch (err) {
          console.error(
            "unsubscribe acceptLink error:",
            String(err).slice(0, 120),
          );
        }
      },
    );

    // rfed.channel.publish — fire-and-forget SEND packet callback.
    const publishDest = await Destination.IN(
      "rfed.channel.publish",
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    publishDest.addEventListener("data", (/** @type {any} */ e) =>
      this._handleSend(e.detail.plaintext).catch(() => {}),
    );
    this.rns.transport.bindLocalDestination(publishDest);

    // rfed.channel.pull — /rfed/pull handler (caller-identified).
    const pullDest = await Destination.IN(
      "rfed.channel.pull",
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    await pullDest.registerRequestHandler("/rfed/pull", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data, _reqId, caller) =>
        this._handlePull(data, caller),
    });
    this.rns.transport.bindLocalDestination(pullDest);
    pullDest.addEventListener("link_request", async (/** @type {any} */ e) => {
      try {
        await pullDest.acceptLink(e.detail.packet);
      } catch (err) {
        console.error("pull acceptLink error:", String(err).slice(0, 120));
      }
    });
  }

  /**
   * Verifies the `[channel_hash, pubkey, sig]` payload, records the
   * subscription, and replies `[true, stamp_cost|nil]` — matching the Rust
   * `subscribe_cb` + `verify_signed_payload`.
   * @param {any} data
   * @returns {Promise<[boolean, number|null]>}
   */
  async _handleSubscribeAsync(data) {
    const [channelHash, pubkey, sig] = data;
    if (
      !(channelHash instanceof Uint8Array) ||
      !(pubkey instanceof Uint8Array) ||
      !(sig instanceof Uint8Array)
    )
      return [false, null];
    const subscriberIdentity = await Identity.fromPublicKey(pubkey);
    const ok = await subscriberIdentity.validate(sig, channelHash);
    if (!ok) return [false, null];

    const key = toHex(channelHash);
    if (!this.subscriptions.has(key)) this.subscriptions.set(key, new Map());
    const deliveryHex = toHex(await deliveryHashFor(subscriberIdentity));
    this.subscriptions.get(key).set(deliveryHex, subscriberIdentity);
    return [true, this.stampCost];
  }

  /**
   * `/rfed/unsubscribe` — verifies the signed payload and drops the subscriber.
   * @param {any} data
   * @returns {Promise<boolean>}
   */
  async _handleUnsubscribeAsync(data) {
    const [channelHash, pubkey, sig] = data;
    if (
      !(channelHash instanceof Uint8Array) ||
      !(pubkey instanceof Uint8Array) ||
      !(sig instanceof Uint8Array)
    )
      return false;
    const subscriberIdentity = await Identity.fromPublicKey(pubkey);
    const ok = await subscriberIdentity.validate(sig, channelHash);
    if (!ok) return false;
    const key = toHex(channelHash);
    const deliveryHex = toHex(await deliveryHashFor(subscriberIdentity));
    this.subscriptions.get(key)?.delete(deliveryHex);
    return true;
  }

  /**
   * SEND ingest: stamp validation (when configured), store, fanout.
   * @param {Uint8Array} data
   */
  async _handleSend(data) {
    let channelHash;
    let innerBlob;
    if (this.stampCost) {
      const { channelHash: ch, innerBlob: ib, stamp } = parseSendPayload(data);
      const ok = await validateChannelStamp(ch, ib, stamp, this.stampCost);
      if (!ok) return; // silently drop under-stamped blobs (Rust behaviour)
      channelHash = ch;
      innerBlob = ib;
    } else {
      if (data.length < 17) return;
      channelHash = data.subarray(0, 16);
      innerBlob = data.subarray(16);
    }

    // Store for pull.
    const key = toHex(channelHash);
    if (!this.deferred.has(key)) this.deferred.set(key, []);
    this.deferred.get(key).push({ blob: new Uint8Array(innerBlob) });

    // Fan out to each live subscriber's rfed.delivery.
    const subs = this.subscriptions.get(key);
    if (!subs || subs.size === 0) return;
    const fanoutPayload = new Uint8Array(16 + innerBlob.length);
    fanoutPayload.set(channelHash, 0);
    fanoutPayload.set(innerBlob, 16);
    for (const subscriberIdentity of subs.values()) {
      await this._fanoutTo(subscriberIdentity, fanoutPayload);
    }
  }

  async _fanoutTo(subscriberIdentity, fanoutPayload) {
    const dest = await Destination.OUT(
      "rfed.delivery",
      DestType.SINGLE,
      subscriberIdentity,
      this.rns,
    );
    const packet = new Packet({
      packetType: PacketType.DATA,
      contextFlag: true,
      contextByte: ContextType.NONE,
      destinationType: DestType.SINGLE,
      destinationHash: dest.destinationHash,
      payload: fanoutPayload,
    });
    await dest.send(packet);
  }

  /**
   * `/rfed/pull` — drains one page for the caller + channel.
   * @param {any} data
   * @param {Identity|null} caller
   * @returns {[Array<[Uint8Array, Uint8Array]>, boolean]}
   */
  async _handlePull(data, caller) {
    if (!caller) return [[], false];
    const channelHash = data instanceof Uint8Array ? data : data;
    const key = toHex(channelHash);
    const queue = this.deferred.get(key) ?? [];
    const page = queue.splice(0, 25);
    const pairs = page.map((p) => [new Uint8Array(channelHash), p.blob]);
    return [pairs, queue.length > 0];
  }
}

/**
 * Sets up a two-node mesh: a rfed server fixture + one client. Identities are
 * pre-recalled so each side can build the other's Single destinations.
 * @param {Object} [opts]
 * @param {number|null} [opts.stampCost]
 * @returns {Promise<{node: MinimalRfedNode, nodeHash: Uint8Array, client: RFedClient, wire: Wire}>}
 */
async function fixture({ stampCost = null } = {}) {
  const wire = new Wire();
  const nodeRns = await makeRns();
  const clientRns = await makeRns();
  wire.attach(nodeRns.transport);
  wire.attach(clientRns.transport);

  const node = new MinimalRfedNode({
    identity: nodeRns.identity,
    rns: nodeRns.rns,
    stampCost,
  });
  await node.start();

  // Make the node's identity recallable by each of its destination hashes.
  for (const name of [
    "rfed.channel.subscribe",
    "rfed.channel.unsubscribe",
    "rfed.channel.publish",
    "rfed.channel.pull",
  ]) {
    const dest = await Destination.OUT(name, DestType.SINGLE, nodeRns.identity);
    await Destination.remember(
      rnd(16),
      dest.destinationHash,
      nodeRns.identity.publicKey,
      null,
    );
  }
  // The client will recall via the subscribe destination hash.
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
  // Make the client's delivery identity recallable so the node can fan out.
  const clientDeliveryHash = await deliveryHashFor(clientRns.identity);
  await Destination.remember(
    rnd(16),
    clientDeliveryHash,
    clientRns.identity.publicKey,
    null,
  );

  return { node, nodeHash, client, wire };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("rfed client — subscribe + publish + live fanout receive", () => {
  test("a subscribed client receives its own publish (no stamp)", async () => {
    const { nodeHash, client } = await fixture();

    const sub = await client.subscribe(nodeHash, "public.roundtrip");
    assert.strictEqual(sub.ok, true);
    assert.strictEqual(sub.stampCost, null);

    /** @type {any[]} */
    const received = [];
    await client.listen((decoded) => received.push(decoded));

    const lxm = new Message({ content: "hello from the client" });
    await client.publish(nodeHash, "public.roundtrip", lxm);

    const decoded = await waitFor(() => received[0], 5000);
    assert.strictEqual(decoded.message.content, "hello from the client");
    assert.strictEqual(decoded.signatureValid, true);
    assert.strictEqual(decoded.channelName, "public.roundtrip");
  });

  test("stamp cost is cached from subscribe and honoured on publish", async () => {
    const { nodeHash, client } = await fixture({ stampCost: 8 });

    const sub = await client.subscribe(nodeHash, "public.stamped");
    assert.strictEqual(sub.ok, true);
    assert.strictEqual(sub.stampCost, 8);

    const received = [];
    await client.listen((d) => received.push(d));

    await client.publish(
      nodeHash,
      "public.stamped",
      new Message({ content: "stamped body" }),
    );

    const decoded = await waitFor(() => received[0], 8000);
    assert.strictEqual(decoded.message.content, "stamped body");
    assert.strictEqual(decoded.signatureValid, true);
  });

  test("a publish without a valid stamp is silently dropped", async () => {
    // Node requires a stamp; client does NOT subscribe first, so it has no
    // cached cost and publishes stamp-less — the node must drop it.
    const { node, nodeHash, client } = await fixture({ stampCost: 8 });

    await client.publish(
      nodeHash,
      "public.dropped",
      new Message({ content: "no stamp" }),
    );

    // Give the loopback a moment to (not) deliver, then assert the node stored
    // nothing for this channel — the under-stamped blob was rejected at ingest.
    await new Promise((r) => setTimeout(r, 300));
    const { deriveChannel } = await import("../../src/rfed/channel.js");
    const droppedHash = toHex(
      (await deriveChannel("public.dropped")).channelHash,
    );
    assert.strictEqual(
      (node.deferred.get(droppedHash) ?? []).length,
      0,
      "under-stamped publish must not be stored",
    );
  });
});

describe("rfed client — pull paging", () => {
  test("pull drains deferred blobs for a channel", async () => {
    const { nodeHash, client } = await fixture();

    await client.subscribe(nodeHash, "public.pullchannel");
    // Publish two messages without listening live (they land in the node store).
    await client.publish(
      nodeHash,
      "public.pullchannel",
      new Message({ content: "msg one" }),
    );
    await client.publish(
      nodeHash,
      "public.pullchannel",
      new Message({ content: "msg two" }),
    );

    const { items, morePending } = await client.pull(
      nodeHash,
      "public.pullchannel",
    );
    assert.strictEqual(items.length, 2);
    assert.strictEqual(morePending, false);

    // Both blobs must unwrap to the published contents.
    const { deriveChannel } = await import("../../src/rfed/channel.js");
    const { unwrapChannelMessage } = await import("../../src/rfed/blob.js");
    const channel = await deriveChannel("public.pullchannel");
    const deliveryHash = await deliveryHashFor(channel.identity);
    const contents = [];
    for (const item of items) {
      const d = await unwrapChannelMessage({
        innerBlob: item.blob,
        channelIdentity: channel.identity,
        channelDeliveryHash: deliveryHash,
      });
      contents.push(d.message.content);
    }
    contents.sort();
    assert.deepStrictEqual(contents, ["msg one", "msg two"]);
  });
});

describe("rfed client — unsubscribe", () => {
  test("removes the subscription so fanout stops", async () => {
    const { nodeHash, client } = await fixture();
    await client.subscribe(nodeHash, "public.unsub");
    const received = [];
    await client.listen((d) => received.push(d));

    await client.publish(
      nodeHash,
      "public.unsub",
      new Message({ content: "before" }),
    );
    await waitFor(() => received.length >= 1, 5000);

    const res = await client.unsubscribe(nodeHash, "public.unsub");
    assert.strictEqual(res.ok, true);

    await client.publish(
      nodeHash,
      "public.unsub",
      new Message({ content: "after" }),
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(
      received.length,
      1,
      "no further fanout after unsubscribe",
    );
  });
});
