import assert from "node:assert";
import test from "node:test";
import { Destination } from "@reticulum/core/src/core/destination.js";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { DestType } from "@reticulum/core/src/core/packet.js";
import { PacketReceipt } from "@reticulum/core/src/core/packet_receipt.js";
import {
  TransportCore,
  UnknownIdentityError,
} from "@reticulum/core/src/transport/transport.js";
import { bytesEqual, toHex } from "@reticulum/core/src/utils/encoding.js";
import { Message } from "../src/message.js";
import { LXMRouter } from "../src/router.js";

async function makeRouter(onReceipt = () => {}) {
  const identity = await Identity.generate();
  /** @type {any} */
  const interfaceLayer = {
    registerDestination: () => {},
    transport: Object.assign(new TransportCore(), {
      sendPacket: async () => {
        const receipt = new PacketReceipt(
          crypto.getRandomValues(new Uint8Array(32)),
          crypto.getRandomValues(new Uint8Array(16)),
        );
        onReceipt(receipt);
        return receipt;
      },
    }),
  };
  const router = new LXMRouter(identity, interfaceLayer);
  await router.init();
  return { router, identity, interfaceLayer };
}

test("Message guarantees stable timestamp and messageId across repeated serialize calls", async () => {
  const senderIdentity = await Identity.generate();
  const destHash = new Uint8Array(16).fill(0x12);

  const msg = new Message({
    destinationHash: destHash,
    title: "Test",
    content: "Body content",
  });

  const initialTimestamp = msg.timestamp;
  assert.ok(initialTimestamp > 0);

  const { messageId: id1, wireData: wire1 } =
    await msg.serialize(senderIdentity);
  assert.ok(id1 instanceof Uint8Array);
  assert.strictEqual(msg.timestamp, initialTimestamp);
  assert.deepStrictEqual(msg.messageId, id1);

  // Serialize again (e.g. on fallback retry)
  const { messageId: id2, wireData: wire2 } =
    await msg.serialize(senderIdentity);
  assert.strictEqual(msg.timestamp, initialTimestamp);
  assert.deepStrictEqual(
    id1,
    id2,
    "messageId must be identical across serialize calls",
  );
  assert.deepStrictEqual(
    wire1,
    wire2,
    "wireData must be identical across serialize calls",
  );
});

test("send automatically solicits unknown recipient identity when solicit=true", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );

  const { router, identity } = await makeRouter((receipt) => {
    receipt.startTimeout(5_000);
    setTimeout(() => receipt.setDelivered(), 5);
  });

  // Do NOT remember identity initially.
  let solicited = false;
  router.rns.transport.requestPath = async (dh) => {
    solicited = true;
    setTimeout(async () => {
      await router.rns.transport.rememberIdentity(
        new Uint8Array(32),
        recipientDest.destinationHash,
        recipientIdentity.publicKey,
      );
      router.rns.transport.dispatchEvent(
        new CustomEvent("announce", {
          detail: {
            destinationHash: recipientDest.destinationHash,
            identity: recipientIdentity,
          },
        }),
      );
    }, 10);
  };

  // Stub _establishDirectLink to fail fast so opportunistic solicitation is exercised
  router._establishDirectLink = async () => null;

  const message = new Message({
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: recipientDest.destinationHash,
    title: "Hi",
    content: "Testing solicit",
  });

  await router.send(message, identity, { solicit: true, timeoutMs: 1000 });
  assert.strictEqual(
    solicited,
    true,
    "requestPath should have been called to solicit identity",
  );
});

test("_establishDirectLink solicits unknown recipient identity when solicit=true", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );

  const { router } = await makeRouter();
  let solicited = false;
  router.rns.transport.requestPath = async () => {
    solicited = true;
    setTimeout(async () => {
      await router.rns.transport.rememberIdentity(
        new Uint8Array(32),
        recipientDest.destinationHash,
        recipientIdentity.publicKey,
      );
      router.rns.transport.dispatchEvent(
        new CustomEvent("announce", {
          detail: {
            destinationHash: recipientDest.destinationHash,
            identity: recipientIdentity,
          },
        }),
      );
    }, 10);
  };

  // Skip the 15s path request wait and link initiation
  router._requestAndAwaitPath = async () => true;

  await router._establishDirectLink(recipientDest.destinationHash, {
    solicit: true,
    timeoutMs: 50,
  });
  assert.strictEqual(
    solicited,
    true,
    "_establishDirectLink should solicit identity",
  );
});

test("send fails with UnknownIdentityError without soliciting when solicit=false", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );

  const { router, identity } = await makeRouter();
  let requestedPath = false;
  router.rns.transport.requestPath = async () => {
    requestedPath = true;
  };

  const message = new Message({
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: recipientDest.destinationHash,
    title: "Hi",
    content: "No solicit",
  });

  await assert.rejects(
    async () => {
      await router.send(message, identity, { solicit: false });
    },
    (err) => {
      assert.ok(err instanceof UnknownIdentityError);
      return true;
    },
  );
  assert.strictEqual(
    requestedPath,
    false,
    "requestPath should NOT be called when solicit=false",
  );
});

test("send with fallback='none' throws if direct link cannot be established", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );

  const { router, identity } = await makeRouter();
  await router.rns.transport.rememberIdentity(
    new Uint8Array(32),
    recipientDest.destinationHash,
    recipientIdentity.publicKey,
  );

  // Force _establishDirectLink to fail
  router._establishDirectLink = async () => null;

  const message = new Message({
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: recipientDest.destinationHash,
    title: "Hi",
    content: "Strict link only",
  });

  await assert.rejects(async () => {
    await router.send(message, identity, { fallback: "none" });
  }, /direct link delivery failed and fallback is "none"/);
});

test("send with fallback='propagation' escalates to submitToPropagationNode when opportunistic delivery fails", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );

  // Setup router where opportunistic send times out / fails proof
  const { router, identity } = await makeRouter((receipt) => {
    receipt.startTimeout(20);
    // Let timeout expire without delivering
  });
  await router.rns.transport.rememberIdentity(
    new Uint8Array(32),
    recipientDest.destinationHash,
    recipientIdentity.publicKey,
  );

  // No direct link
  router._establishDirectLink = async () => null;
  router.outboundPropagationNode = new Uint8Array(16).fill(0x55);

  let propagationSubmitted = false;
  let submittedMessage = null;
  router.submitToPropagationNode = async (msg, sender) => {
    propagationSubmitted = true;
    submittedMessage = msg;
    return { transientId: new Uint8Array(32), stampCost: 0 };
  };

  const message = new Message({
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: recipientDest.destinationHash,
    title: "Hi",
    content: "Escalate to propagation",
  });

  await router.send(message, identity, { fallback: "propagation" });
  assert.strictEqual(
    propagationSubmitted,
    true,
    "submitToPropagationNode should be called on escalation",
  );
  assert.strictEqual(
    submittedMessage,
    message,
    "the exact same Message instance should be submitted",
  );
});

test("send with bare linkId works for backwards compatibility", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );

  const { router, identity } = await makeRouter();
  const fakeLinkId = new Uint8Array(16).fill(0xaa);
  let packetSent = null;

  router.rns.transport.activeLinks.set(toHex(fakeLinkId), {
    whenActive: async () => {},
    initiator: false,
    mdu: 500,
  });
  router.rns.transport.sendPacket = async (pkt, lid) => {
    packetSent = pkt;
    assert.deepStrictEqual(lid, fakeLinkId);
  };

  const message = new Message({
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: recipientDest.destinationHash,
    title: "Hi",
    content: "Bare linkId",
  });

  await router.send(message, identity, fakeLinkId);
  assert.ok(packetSent, "packet was sent over provided linkId");
});
