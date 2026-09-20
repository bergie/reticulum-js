/**
 * Client-side propagation (§5.3): submit packing and the `/get` sync exchange.
 *
 * `_packForPropagationSubmit` is verified structurally (container + stamp +
 * transient_id + round-trip decrypt). The sync orchestration
 * (`syncFromPropagationNode`) is driven against a mock Link whose `request`
 * returns scripted `/get` responses, asserting the list → wants → ack sequence
 * and local delivery of the synced message.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "@reticulum/core/src/core/destination.js";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { DestType } from "@reticulum/core/src/core/packet.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { Message } from "../src/message.js";
import { unpackPropagationContainer } from "../src/propagation.js";
import { LXMRouter } from "../src/router.js";

/** Mock RNS core (transport is a real TransportCore; broadcast is a no-op). */
function mockRns() {
  return Object.assign(new EventTarget(), {
    registerDestination: () => {},
    broadcast: () => {},
    // A real TransportCore (no interfaces) so instance-scoped cache calls
    // (work doc #37) work.
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

describe("submit packing — _packForPropagationSubmit", () => {
  test("builds msgpack([time,[lxmf_data||stamp]]) with transient_id over the base", async () => {
    const sender = await Identity.generate();
    const recipient = await Identity.generate();
    const rns = mockRns();
    const recipientOut = await rememberDelivery(recipient, rns.transport);
    const senderOut = await rememberDelivery(sender, rns.transport);

    const router = new LXMRouter(sender, rns);
    await router.init();

    const message = new Message({
      destinationHash: recipientOut.destinationHash,
      sourceHash: senderOut.destinationHash,
      timestamp: 1730000000,
      title: "PN submit",
      content: "store-and-forward me",
    });
    const { container, transientId, stampCost } =
      await router._packForPropagationSubmit(message, sender, 0);
    assert.strictEqual(stampCost, 0);

    const c = unpackPropagationContainer(container);
    assert.ok(c);
    assert.strictEqual(c.messages.length, 1);
    const blob = c.messages[0];

    // The blob is base lxmf_data + a 32-byte stamp; transient_id is over base.
    const base = blob.subarray(0, blob.length - 32);
    assert.deepStrictEqual(
      transientId,
      await Message.transientIdFromPropagationData(base),
    );

    // The base decrypts back to the original message for the recipient.
    const inDest = await Destination.IN(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient,
      null,
    );
    const recovered = await Message.fromPropagationData(base, inDest);
    assert.ok(recovered);
    assert.strictEqual(recovered.content, "store-and-forward me");
    assert.ok(await recovered.verifySignature(sender));
  });
});

describe("sync — syncFromPropagationNode orchestration", () => {
  test("drives list → wants → ack and delivers the synced message", async () => {
    const syncer = await Identity.generate(); // the router's identity (recipient)
    const sender = await Identity.generate();
    const rns = mockRns();
    await rememberDelivery(syncer, rns.transport);
    await rememberDelivery(sender, rns.transport);

    const router = new LXMRouter(syncer, rns);
    await router.init();
    router.setOutboundPropagationNode(rnd(16));

    // A real propagation-form message addressed to the router's delivery dest.
    const deliveryOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      syncer,
      null,
    );
    const senderOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      sender,
      null,
    );
    const msg = new Message({
      destinationHash: deliveryOut.destinationHash,
      sourceHash: senderOut.destinationHash,
      title: "synced",
      content: "arrived via propagation node",
    });
    const { lxmfData, transientId } = await msg.toPropagationData(
      sender,
      deliveryOut,
    );

    /** @type {{path: string, data: any}[]} */
    const requests = [];
    let identified = false;
    let phase = 0;
    const fakeLink = {
      status: 2,
      async identify() {
        identified = true;
      },
      async request(path, data) {
        requests.push({ path, data });
        phase++;
        if (phase === 1) return [transientId]; // list
        if (phase === 2) return [lxmfData]; // fetched base lxmf_data
        return null; // ack
      },
    };
    router._ensurePropagationLink = async () => /** @type {any} */ (fakeLink);

    /** @type {Message|null} */
    let delivered = null;
    router.addEventListener("message", (event) => {
      delivered = event.detail.message;
    });

    const res = await router.syncFromPropagationNode(syncer);
    assert.strictEqual(identified, true, "must identify before requesting");
    assert.strictEqual(res.received, 1);

    // Three /get requests: list, fetch, ack.
    assert.strictEqual(requests.length, 3);
    assert.deepStrictEqual(requests[0].data, [null, null]);
    assert.ok(Array.isArray(requests[1].data[0])); // wants
    assert.deepStrictEqual(requests[1].data[0][0], transientId);
    assert.deepStrictEqual(requests[2].data[0], null); // ack: [null, haves]

    assert.ok(delivered);
    assert.strictEqual(delivered.content, "arrived via propagation node");
    assert.ok(await delivered.verifySignature(sender));
  });

  test("marks already-held transient_ids as haves (no re-fetch)", async () => {
    const syncer = await Identity.generate();
    const rns = mockRns();
    await rememberDelivery(syncer, rns.transport);
    const router = new LXMRouter(syncer, rns);
    await router.init();
    router.setOutboundPropagationNode(rnd(16));

    const heldTid = rnd(32);
    router.processedTransientIds.set(toHex(heldTid), Date.now() / 1000);

    /** @type {{data: any}[]} */
    const requests = [];
    let phase = 0;
    const fakeLink = {
      status: 2,
      async identify() {},
      async request(_path, data) {
        requests.push({ data });
        phase++;
        return phase === 1 ? [heldTid] : [];
      },
    };
    router._ensurePropagationLink = async () => /** @type {any} */ (fakeLink);

    const res = await router.syncFromPropagationNode(syncer);
    assert.strictEqual(res.received, 0);
    // The held id is in haves (so the node purges it), not wants.
    assert.deepStrictEqual(requests[1].data[0], []);
    assert.deepStrictEqual(requests[1].data[1], [heldTid]);
  });
});
