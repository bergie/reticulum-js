/**
 * Inbound message deduplication (Python `LXMRouter.lxmf_delivery`'s
 * `has_message` check): every delivery of the same wire message — over a
 * link, as an opportunistic packet, via a propagation-node sync — carries the
 * same content-derived message id, so the second and later copies must be
 * dropped instead of re-dispatched (which would re-run message handlers and
 * duplicate replies).
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "@reticulum/core/src/core/destination.js";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { DestType } from "@reticulum/core/src/core/packet.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { Message } from "../src/message.js";
import { LXMRouter } from "../src/router.js";

/** Mock RNS core (transport is a real TransportCore; broadcast is a no-op). */
function mockRns() {
  return Object.assign(new EventTarget(), {
    registerDestination: () => {},
    broadcast: () => {},
    // A real TransportCore so the router's instance-scoped cache calls
    // (work doc #37) work; it has no interfaces so nothing hits the network.
    transport: new TransportCore(),
  });
}

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Remembers `identity` under its `lxmf.delivery` destination hash. */
async function rememberDelivery(identity, transport) {
  const out = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    null,
  );
  await transport.rememberIdentity(
    rnd(16),
    out.destinationHash,
    await identity.getPublicKey(),
    null,
  );
  return out;
}

/** Flushes pending async listener work (event dispatch is awaited in-flight). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("inbound dedup — _dispatchMessage / hasMessage", () => {
  test("a repeated delivery of the same message over a link dispatches once", async () => {
    const recipient = await Identity.generate();
    const sender = await Identity.generate();
    const rns = mockRns();
    const senderOut = await rememberDelivery(sender, rns.transport);
    await rememberDelivery(recipient, rns.transport);

    const router = new LXMRouter(recipient, rns);
    await router.init();

    const msg = new Message({
      destinationHash: router.deliveryDest.destinationHash,
      sourceHash: senderOut.destinationHash,
      timestamp: 1730000000,
      title: "dedup",
      content: "link me twice",
    });
    const { messageId, wireData } = await msg.serialize(sender);

    const link = Object.assign(new EventTarget(), {
      linkId: rnd(16),
    });
    router._attachLinkMessageListeners(link);

    /** @type {Message[]} */
    const received = [];
    router.addEventListener("message", (event) => {
      received.push(event.detail.message);
    });

    const dispatch = () =>
      link.dispatchEvent(
        new CustomEvent("data", {
          detail: { packet: { payload: wireData }, link: link.linkId },
        }),
      );
    dispatch();
    await flush();
    dispatch();
    await flush();

    assert.strictEqual(received.length, 1, "second copy is dropped");
    assert.strictEqual(received[0].content, "link me twice");
    assert.strictEqual(
      router.hasMessage(messageId),
      true,
      "the delivered id is remembered",
    );
    assert.strictEqual(
      router.hasMessage(rnd(32)),
      false,
      "an unseen id is not remembered",
    );
  });

  test("the same message over a link and again as an opportunistic packet dispatches once", async () => {
    const recipient = await Identity.generate();
    const sender = await Identity.generate();
    const rns = mockRns();
    const senderOut = await rememberDelivery(sender, rns.transport);
    await rememberDelivery(recipient, rns.transport);

    const router = new LXMRouter(recipient, rns);
    await router.init();

    const msg = new Message({
      destinationHash: router.deliveryDest.destinationHash,
      sourceHash: senderOut.destinationHash,
      timestamp: 1730000001,
      title: "dedup",
      content: "cross-path duplicate",
    });
    const { wireData } = await msg.serialize(sender);

    const link = Object.assign(new EventTarget(), {
      linkId: rnd(16),
    });
    router._attachLinkMessageListeners(link);

    /** @type {Message[]} */
    const received = [];
    router.addEventListener("message", (event) => {
      received.push(event.detail.message);
    });

    // Link copy: full wire form (dest-hash prefixed).
    link.dispatchEvent(
      new CustomEvent("data", {
        detail: { packet: { payload: wireData }, link: link.linkId },
      }),
    );
    await flush();

    // Opportunistic copy: the destination emits the decrypted payload with
    // the destination hash stripped (the sender's opportunistic form).
    router.deliveryDest.dispatchEvent(
      new CustomEvent("data", {
        detail: { plaintext: wireData.subarray(16) },
      }),
    );
    await flush();

    assert.strictEqual(
      received.length,
      1,
      "the opportunistic copy of an already-delivered message is dropped",
    );
  });

  test("distinct messages dispatch separately", async () => {
    const recipient = await Identity.generate();
    const sender = await Identity.generate();
    const rns = mockRns();
    const senderOut = await rememberDelivery(sender, rns.transport);
    await rememberDelivery(recipient, rns.transport);

    const router = new LXMRouter(recipient, rns);
    await router.init();

    /** @type {Message[]} */
    const received = [];
    router.addEventListener("message", (event) => {
      received.push(event.detail.message);
    });

    for (const content of ["first", "second"]) {
      const msg = new Message({
        destinationHash: router.deliveryDest.destinationHash,
        sourceHash: senderOut.destinationHash,
        timestamp: 1730000002 + received.length,
        title: "dedup",
        content,
      });
      const { wireData } = await msg.serialize(sender);
      router.deliveryDest.dispatchEvent(
        new CustomEvent("data", {
          detail: { plaintext: wireData.subarray(16) },
        }),
      );
      await flush();
    }

    assert.strictEqual(received.length, 2, "both messages dispatched");
    assert.deepStrictEqual(
      received.map((m) => m.content),
      ["first", "second"],
    );
  });
});

describe("inbound dedup — propagation sync", () => {
  test("a synced copy of an already-delivered message is not re-dispatched but is acked", async () => {
    const recipient = await Identity.generate();
    const sender = await Identity.generate();
    const rns = mockRns();
    const senderOut = await rememberDelivery(sender, rns.transport);
    const deliveryOut = await rememberDelivery(recipient, rns.transport);

    const router = new LXMRouter(recipient, rns);
    await router.init();
    router.setOutboundPropagationNode(rnd(16));

    const msg = new Message({
      destinationHash: deliveryOut.destinationHash,
      sourceHash: senderOut.destinationHash,
      timestamp: 1730000003,
      title: "sync dedup",
      content: "delivered directly, then synced",
    });

    // The same message in propagation form (what the node would hand back).
    const { lxmfData, transientId } = await msg.toPropagationData(
      sender,
      deliveryOut,
    );

    // 1. The message arrives directly (opportunistic form).
    const { wireData } = await msg.serialize(sender);
    /** @type {Message[]} */
    const received = [];
    router.addEventListener("message", (event) => {
      received.push(event.detail.message);
    });
    router.deliveryDest.dispatchEvent(
      new CustomEvent("data", {
        detail: { plaintext: wireData.subarray(16) },
      }),
    );
    await flush();
    assert.strictEqual(received.length, 1, "direct copy delivered");

    // 2. The propagation node is synced, offering the very same message.
    /** @type {{path: string, data: any}[]} */
    const requests = [];
    let phase = 0;
    const fakeLink = {
      status: 2,
      async identify() {},
      async request(path, data) {
        requests.push({ path, data });
        phase++;
        if (phase === 1) return [transientId]; // list
        if (phase === 2) return [lxmfData]; // fetched base lxmf_data
        return null; // ack
      },
    };
    router._ensurePropagationLink = async () => /** @type {any} */ (fakeLink);

    const res = await router.syncFromPropagationNode(recipient);

    assert.strictEqual(
      received.length,
      1,
      "the synced copy must not re-dispatch the message",
    );
    assert.strictEqual(
      res.received,
      0,
      "a duplicate is not counted as received",
    );
    assert.strictEqual(res.duplicates, 1, "it is counted as a duplicate");
    // The duplicate is still acked so the node purges it (Python
    // message_get_response acks every fetched message, duplicates included).
    assert.strictEqual(requests.length, 3, "list, fetch and ack requests");
    assert.deepStrictEqual(requests[2].data[0], null);
    assert.strictEqual(requests[2].data[1].length, 1);
    assert.deepStrictEqual(requests[2].data[1][0], transientId);
    assert.ok(
      router.processedTransientIds.has(toHex(transientId)),
      "the transient id is marked processed so the next sync lists it as a have",
    );
  });
});
