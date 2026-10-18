/**
 * Parked-message lifecycle (identity-unknown inbound messages).
 *
 * Messages arriving from a sender whose identity is not yet known are parked
 * until LINKIDENTIFY (link delivery) or an announce (opportunistic delivery)
 * makes the identity recallable. Three lifecycle invariants:
 *
 *   1. No clobbering — several parked messages (per link, and across
 *      opportunistic senders) must all survive until their identities land;
 *      previously one slot per key silently dropped all but the last.
 *   2. Eviction — a parked message whose link closes is dropped (LINKIDENTIFY
 *      can never arrive on a dead link); previously it was pinned forever.
 *   3. Bounded memory — the total parked count is capped
 *      (MAX_PARKED_MESSAGES), dropping oldest first.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "@reticulum/core/src/core/destination.js";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { DestType } from "@reticulum/core/src/core/packet.js";
import { LinkStatus } from "@reticulum/core/src/index.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { Message } from "../src/message.js";
import { LXMRouter, MAX_PARKED_MESSAGES } from "../src/router.js";

function mockRns() {
  return Object.assign(new EventTarget(), {
    registerDestination: () => {},
    broadcast: () => {},
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

/** A serialized message from `sender` addressed to the router's delivery dest. */
async function wireFrom(sender, senderDeliveryHash, router, title) {
  const msg = new Message({
    destinationHash: router.deliveryDest.destinationHash,
    sourceHash: senderDeliveryHash,
    timestamp: 1730000100,
    title,
    content: `parked ${title}`,
  });
  return msg.serialize(sender);
}

describe("parked messages", () => {
  test("multiple parked messages per link all deliver once identified", async () => {
    const recipient = await Identity.generate();
    const sender = await Identity.generate();
    const rns = mockRns();
    const router = new LXMRouter(recipient, rns);
    await router.init();

    // Sender deliberately NOT remembered yet — messages park.
    const senderDelivery = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      sender,
      null,
    );

    const link = Object.assign(new EventTarget(), {
      linkId: rnd(16),
    });
    router._attachLinkMessageListeners(link);

    const received = [];
    router.addEventListener("message", (event) => {
      received.push(event.detail.message.title);
    });

    // Two messages from the same unknown sender over one link: both must be
    // parked (previously the second silently replaced the first).
    const w1 = await wireFrom(
      sender,
      senderDelivery.destinationHash,
      router,
      "first",
    );
    const w2 = await wireFrom(
      sender,
      senderDelivery.destinationHash,
      router,
      "second",
    );
    await router._processIncomingMessage(w1.wireData, link.linkId);
    await router._processIncomingMessage(w2.wireData, link.linkId);
    assert.equal(
      router.pendingMessages.get(toHex(link.linkId))?.length,
      2,
      "both messages must be parked, not clobbered",
    );

    // Identity lands (the identify handler's rememberIdentity): both parked
    // messages re-process and deliver.
    await rememberDelivery(sender, rns.transport);
    await router.processPendingMessages(link.linkId);
    assert.deepEqual(
      received.sort(),
      ["first", "second"],
      "both parked messages must deliver on identify",
    );
    assert.equal(
      router.pendingMessages.size,
      0,
      "the delivered bucket must be empty",
    );
  });

  test("parked messages are dropped when their link closes", async () => {
    const recipient = await Identity.generate();
    const rns = mockRns();
    const router = new LXMRouter(recipient, rns);
    await router.init();

    const link = Object.assign(new EventTarget(), {
      linkId: rnd(16),
    });
    router._attachLinkMessageListeners(link);

    // Park a message for an unknown sender on this link.
    const sender = await Identity.generate();
    const senderDelivery = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      sender,
      null,
    );
    const w = await wireFrom(
      sender,
      senderDelivery.destinationHash,
      router,
      "doomed",
    );
    await router._processIncomingMessage(w.wireData, link.linkId);
    assert.equal(router.pendingMessages.size, 1);

    // The link goes down without ever identifying: the parked buffer must be
    // released, not pinned for the router's lifetime.
    link.dispatchEvent(
      new CustomEvent("statuschange", {
        detail: { status: LinkStatus.CLOSED, oldStatus: LinkStatus.ACTIVE },
      }),
    );
    assert.equal(
      router.pendingMessages.size,
      0,
      "a closed link must not keep its parked messages",
    );
  });

  test("opportunistic messages from distinct senders do not clobber", async () => {
    const recipient = await Identity.generate();
    const rns = mockRns();
    const router = new LXMRouter(recipient, rns);
    await router.init();

    const senders = [];
    for (const title of ["a", "b"]) {
      const sender = await Identity.generate();
      const out = await Destination.OUT(
        "lxmf.delivery",
        DestType.SINGLE,
        sender,
        null,
      );
      const w = await wireFrom(sender, out.destinationHash, router, title);
      await router._processIncomingMessage(w.wireData, null);
      senders.push({ sender, out });
    }
    assert.equal(
      router.pendingMessages.get("opportunistic")?.length,
      2,
      "both unknown-sender opportunistic messages must be parked",
    );
  });

  test("the parked total is capped, dropping oldest first", async () => {
    const recipient = await Identity.generate();
    const rns = mockRns();
    const router = new LXMRouter(recipient, rns);
    await router.init();

    const linkA = Object.assign(new EventTarget(), { linkId: rnd(16) });
    router._attachLinkMessageListeners(linkA);
    const linkB = Object.assign(new EventTarget(), { linkId: rnd(16) });
    router._attachLinkMessageListeners(linkB);

    // Park MAX+1 messages across two links from unknown senders.
    let parked = 0;
    let firstWire = null;
    for (let i = 0; i <= MAX_PARKED_MESSAGES; i++) {
      const sender = await Identity.generate();
      const out = await Destination.OUT(
        "lxmf.delivery",
        DestType.SINGLE,
        sender,
        null,
      );
      const w = await wireFrom(sender, out.destinationHash, router, `m${i}`);
      if (i === 0) firstWire = w.wireData;
      const link = i % 2 === 0 ? linkA : linkB;
      await router._processIncomingMessage(w.wireData, link.linkId);
      parked++;
    }
    let total = 0;
    const survivors = [];
    for (const bucket of router.pendingMessages.values()) {
      total += bucket.length;
      for (const entry of bucket) survivors.push(entry.wireData);
    }
    assert.equal(parked, MAX_PARKED_MESSAGES + 1);
    assert.equal(
      total,
      MAX_PARKED_MESSAGES,
      "the parked total must stay at the cap",
    );
    assert.equal(
      survivors.includes(firstWire),
      false,
      "the oldest parked message must be the one dropped",
    );
  });
});
