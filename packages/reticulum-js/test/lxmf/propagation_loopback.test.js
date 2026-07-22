/**
 * End-to-end LXMF propagation round-trip over a real loopback mesh.
 *
 * Three independent nodes share a virtual wire (broadcast bus):
 *
 *   ┌─ NODE ─────┐   submit (Resource)   ┌─ SENDER ──┐
 *   │ lxmf.prop  │◄──────────────────────│ router    │
 *   │ store +/get │                       └───────────┘
 *   │            │   sync (/get x3)
 *   │            │◄──────────────────────┌─ RECIPIENT┐
 *   └────────────┘                       │ router    │
 *                                        └───────────┘
 *
 * Drives the *whole* live stack the client examples rely on: link handshakes
 * to the `lxmf.propagation` destination, a Resource submit (advertise → windowed
 * transfer → proof), node ingestion + stamp validation, and the full `/get`
 * exchange (list → fetch → ack-purge) — then asserts the message decrypts and
 * its signature verifies on the recipient, and the node purges it post-ack.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { Message } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import { toHex } from "../../src/utils/encoding.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * Polls `fn` every 10 ms until it returns truthy or `timeoutMs` elapses.
 * @template T
 * @param {() => T|undefined} fn
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
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

/** Shared broadcast wire: every transport sees every packet (others drop it). */
class Wire {
  constructor() {
    /** @type {LoopbackTransport[]} */
    this.transports = [];
  }
  /** @param {LoopbackTransport} t */
  attach(t) {
    t.wire = this;
    this.transports.push(t);
  }
}

/**
 * Loopback transport peered to a {@link Wire} (assigned on attach). Delivery
 * to peers is deferred to a fresh microtask so inbound packets never process
 * re-entrantly.
 */
class LoopbackTransport extends EventTarget {
  constructor() {
    super();
    /** @type {Wire|null} */
    this.wire = null;
    /** @type {Map<string, any>} */
    this.activeLinks = new Map();
    /** @type {Map<string, any>} */
    this.destinations = new Map();
    /** @type {any[]} */
    this.sent = [];
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
  /** @param {any} packet @param {Uint8Array|null} [_linkId] */
  async sendPacket(packet, _linkId = null) {
    this.sent.push(packet);
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
  /** @param {any} packet */
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

describe("LXMF propagation — submit → store → sync over a loopback mesh", () => {
  test("a submitted message is stored then synced back to its recipient", async () => {
    // --- Three independent nodes on a shared wire ---
    const wire = new Wire();
    const node = await makeNode();
    const sender = await makeNode();
    const recipient = await makeNode();
    for (const n of [node, sender, recipient]) wire.attach(n.transport);

    // --- NODE: stand up delivery + propagation destinations ---
    const nodeRouter = new LXMRouter(node.identity, node.rns);
    await nodeRouter.init();
    await nodeRouter.enablePropagation({
      stampCost: 0,
      stampCostFlexibility: 0,
      name: "JS loopback PN",
    });
    const nodePropHash = nodeRouter.propagationDest.destinationHash;
    // Make the node's propagation destination globally recallable (pubkey +
    // advertised app_data) so clients can open links and read the stamp cost.
    await Destination.remember(
      rnd(16),
      nodePropHash,
      node.identity.publicKey,
      nodeRouter.propagationDest.appData,
    );

    // --- RECIPIENT: router so its delivery destination exists ---
    const recipientRouter = new LXMRouter(recipient.identity, recipient.rns);
    await recipientRouter.init();
    const recipientDeliveryHash = recipientRouter.deliveryDest.destinationHash;
    // Make the recipient's delivery destination recallable so the sender can
    // encrypt the propagation blob to it.
    await Destination.remember(
      rnd(16),
      recipientDeliveryHash,
      recipient.identity.publicKey,
      null,
    );

    // --- SENDER: router + make its delivery destination recallable so the
    //     recipient can verify the message signature on sync ---
    const senderRouter = new LXMRouter(sender.identity, sender.rns);
    await senderRouter.init();
    await Destination.remember(
      rnd(16),
      senderRouter.deliveryDest.destinationHash,
      sender.identity.publicKey,
      null,
    );

    // --- SUBMIT: sender stores a message for the recipient on the node ---
    senderRouter.setOutboundPropagationNode(nodePropHash);
    const message = new Message({
      sourceHash: senderRouter.deliveryDest.destinationHash,
      destinationHash: recipientDeliveryHash,
      title: "integration",
      content: "submit->store->sync over the loopback mesh",
      timestamp: 1730000000,
    });
    await senderRouter.submitToPropagationNode(message, sender.identity, {
      stampCost: 0,
    });

    // Wait for the node to ingest + store the submitted Resource.
    await waitFor(
      () =>
        (nodeRouter.propagationNode?.store.size ?? 0) >= 1 ? true : undefined,
      6000,
    );
    assert.strictEqual(
      nodeRouter.propagationNode.store.size,
      1,
      "node must store the submitted message",
    );

    // --- SYNC: recipient downloads its messages from the node ---
    recipientRouter.setOutboundPropagationNode(nodePropHash);
    /** @type {Message|null} */
    let received = null;
    recipientRouter.addEventListener("message", (event) => {
      received = /** @type {any} */ (event).detail.message;
    });

    const res = await recipientRouter.syncFromPropagationNode(
      recipient.identity,
      100,
    );
    assert.strictEqual(res.received, 1, "sync must report 1 received message");

    await waitFor(() => (received ? true : undefined), 3000);
    assert.ok(received, "recipient must deliver the synced message");
    assert.strictEqual(
      received.content,
      "submit->store->sync over the loopback mesh",
    );
    assert.strictEqual(received.title, "integration");
    assert.ok(
      await received.verifySignature(sender.identity),
      "sender signature must verify on the recipient",
    );

    // The sync ack purges the delivered message from the node's store.
    assert.strictEqual(
      nodeRouter.propagationNode.store.size,
      0,
      "node must purge the message after the sync ack",
    );
  });

  test("a second submit after purge is served on the next sync", async () => {
    const wire = new Wire();
    const node = await makeNode();
    const sender = await makeNode();
    const recipient = await makeNode();
    for (const n of [node, sender, recipient]) wire.attach(n.transport);

    const nodeRouter = new LXMRouter(node.identity, node.rns);
    await nodeRouter.init();
    await nodeRouter.enablePropagation({ stampCost: 0, name: "JS PN 2" });
    const nodePropHash = nodeRouter.propagationDest.destinationHash;
    await Destination.remember(
      rnd(16),
      nodePropHash,
      node.identity.publicKey,
      nodeRouter.propagationDest.appData,
    );

    const recipientRouter = new LXMRouter(recipient.identity, recipient.rns);
    await recipientRouter.init();
    const recipientDeliveryHash = recipientRouter.deliveryDest.destinationHash;
    await Destination.remember(
      rnd(16),
      recipientDeliveryHash,
      recipient.identity.publicKey,
      null,
    );

    const senderRouter = new LXMRouter(sender.identity, sender.rns);
    await senderRouter.init();
    await Destination.remember(
      rnd(16),
      senderRouter.deliveryDest.destinationHash,
      sender.identity.publicKey,
      null,
    );
    senderRouter.setOutboundPropagationNode(nodePropHash);

    /** @type {string[]} */
    const got = [];
    recipientRouter.setOutboundPropagationNode(nodePropHash);
    recipientRouter.addEventListener("message", (event) => {
      got.push(/** @type {any} */ (event).detail.message.content);
    });

    for (const body of ["first", "second"]) {
      const msg = new Message({
        sourceHash: senderRouter.deliveryDest.destinationHash,
        destinationHash: recipientDeliveryHash,
        title: body,
        content: body,
        timestamp: 1730000000 + got.length,
      });
      await senderRouter.submitToPropagationNode(msg, sender.identity, {
        stampCost: 0,
      });
      await waitFor(
        () =>
          (nodeRouter.propagationNode?.store.size ?? 0) >= 1 ? true : undefined,
        6000,
      );
      const res = await recipientRouter.syncFromPropagationNode(
        recipient.identity,
        100,
      );
      assert.strictEqual(res.received, 1, `sync #${body} should receive 1`);
      await waitFor(() => got.includes(body) || undefined, 3000);
    }

    assert.deepStrictEqual(got, ["first", "second"]);
    assert.strictEqual(
      nodeRouter.propagationNode.store.size,
      0,
      "node store empty after both syncs",
    );
  });
});
