/**
 * Tests for opportunistic delivery-failure observability in the LXMF router
 * (the counterpart of Python LXMF's per-message delivery state):
 *
 *   - `_sendOpportunistic` resolves only once the receiver's PROOF arrives —
 *     the transport-tracked packet receipt is awaited.
 *   - it **rejects** when the proof wait times out, so callers can fall back
 *     (propagation node, retry) instead of reporting success for a packet the
 *     mesh silently dropped.
 *   - `_requestAndAwaitPath` treats an UNRESPONSIVE-but-present path as
 *     unusable and re-solicits it (Python: "trying to rediscover path").
 */
import assert from "node:assert";
import test from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType } from "../../src/core/packet.js";
import { PacketReceipt } from "../../src/core/packet_receipt.js";
import { Message } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import { toHex } from "../../src/utils/encoding.js";

/**
 * Builds an initialised LXMRouter over a fake RNS whose transport hands back
 * controllable packet receipts (the shape the real transport now returns for
 * opportunistic CTX_NONE DATA).
 * @param {(receipt: PacketReceipt) => void} [onReceipt]
 */
async function makeRouter(onReceipt = () => {}) {
  const identity = await Identity.generate();
  /** @type {any} */
  const interfaceLayer = {
    registerDestination: () => {},
    transport: Object.assign(new EventTarget(), {
      bindLocalDestination: () => {},
      addLink: () => {},
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

test("opportunistic send resolves once the recipient proves the packet", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );
  await Destination.remember(
    recipientIdentity.identityHash,
    /** @type {Uint8Array} */ (recipientDest.destinationHash),
    recipientIdentity.publicKey,
  );

  const { router, identity } = await makeRouter((receipt) => {
    // The receiver proves promptly: deliver within the wait window.
    receipt.startTimeout(5_000);
    setTimeout(() => receipt.setDelivered(), 10);
  });

  const message = new Message({
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: recipientDest.destinationHash,
    title: "",
    content: "Pong",
  });
  const { wireData } = await message.serialize(identity);
  await router._sendOpportunistic(message, wireData); // must not reject.
});

test("opportunistic send rejects when no delivery proof arrives in time", async () => {
  const recipientIdentity = await Identity.generate();
  const recipientDest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    recipientIdentity,
    { registerDestination: () => {} },
  );
  await Destination.remember(
    recipientIdentity.identityHash,
    /** @type {Uint8Array} */ (recipientDest.destinationHash),
    recipientIdentity.publicKey,
  );

  const { router, identity } = await makeRouter((receipt) => {
    // Nobody ever proves: the proof-wait times out quickly.
    receipt.startTimeout(25);
  });

  const message = new Message({
    sourceHash: router.deliveryDest.destinationHash,
    destinationHash: recipientDest.destinationHash,
    title: "",
    content: "Pong",
  });
  const { wireData } = await message.serialize(identity);

  await assert.rejects(
    () => router._sendOpportunistic(message, wireData),
    /no delivery proof/i,
  );
});

test("_requestAndAwaitPath re-solicits an UNRESPONSIVE-but-present path", async () => {
  let unresponsive = true;
  let requested = 0;
  /** @type {any} */
  const interfaceLayer = {
    registerDestination: () => {},
    transport: Object.assign(new EventTarget(), {
      bindLocalDestination: () => {},
      addLink: () => {},
      sendPacket: async () => null,
      hasPath: () => true,
      pathIsUnresponsive: () => unresponsive,
      requestPath: async () => {
        requested += 1;
        // The path-response announce rebuilds the route (usable again).
        unresponsive = false;
        interfaceLayer.transport.dispatchEvent(
          new CustomEvent("announce", {
            detail: {
              destinationHash: crypto.getRandomValues(new Uint8Array(16)),
            },
          }),
        );
      },
    }),
  };
  const identity = await Identity.generate();
  const router = new LXMRouter(identity, interfaceLayer);
  await router.init();

  const dest = crypto.getRandomValues(new Uint8Array(16));
  const usable = await router._requestAndAwaitPath(dest, 2_000);

  assert.strictEqual(requested, 1, "a fresh path request must be sent");
  assert.strictEqual(
    usable,
    true,
    "the response announce must satisfy the wait",
  );
  assert.strictEqual(toHex(dest).length, 32); // sanity: dest was 16 bytes.
});
