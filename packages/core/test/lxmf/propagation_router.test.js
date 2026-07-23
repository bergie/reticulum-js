/**
 * Smoketests for {@link LXMRouter.enablePropagation} wiring (§5.3): the
 * `lxmf.propagation` destination is created, the `/get` handler is registered,
 * per-destination app_data is advertised, and the propagated-announce round-
 * trips a valid propagation-node announce.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import { parsePropagationNodeAppData } from "../../src/lxmf/announce_data.js";
import { LXMRouter } from "../../src/lxmf/router.js";

/**
 * Mock RNS core: real EventTargets for transport + interface so the router's
 * announce/listener wiring exercises, and `broadcast` captures announce pkts.
 * @param {import("../../src/core/packet.js").Packet[]} captured
 */
function mockRns(captured) {
  return Object.assign(new EventTarget(), {
    registerDestination: () => {},
    broadcast: (/** @type {any} */ pkt) => {
      captured.push(pkt);
    },
    transport: Object.assign(new EventTarget(), {
      bindLocalDestination: () => {},
    }),
  });
}

describe("LXMRouter.enablePropagation wiring", () => {
  test("creates the propagation destination, /get handler, and PN app_data", async () => {
    const identity = await Identity.generate();
    /** @type {import("../../src/core/packet.js").Packet[]} */
    const captured = [];
    const router = new LXMRouter(identity, mockRns(captured));
    await router.init();

    const node = await router.enablePropagation({
      stampCost: 0,
      stampCostFlexibility: 0,
      name: "TestNode",
    });
    assert.strictEqual(router.propagationNode, node);
    assert.ok(router.propagationDest, "propagation destination created");
    assert.ok(router.propagationDest !== router.deliveryDest);

    // The /get and /offer handlers are registered on the propagation destination.
    assert.strictEqual(router.propagationDest.requestHandlers.size, 2);

    // Per-destination app_data parses as a propagation-node announce.
    const parsed = parsePropagationNodeAppData(router.propagationDest.appData);
    assert.ok(parsed);
    assert.strictEqual(parsed.nodeState, true);
    assert.strictEqual(parsed.name, "TestNode");
    assert.strictEqual(parsed.stampCost, 0);
  });

  test("announcePropagationNode broadcasts a valid PN announce", async () => {
    const identity = await Identity.generate();
    /** @type {import("../../src/core/packet.js").Packet[]} */
    const captured = [];
    const router = new LXMRouter(identity, mockRns(captured));
    await router.init();
    await router.enablePropagation({ stampCost: 0, stampCostFlexibility: 0 });
    await router.announcePropagationNode();

    assert.strictEqual(captured.length, 1);
    const announce = captured[0];
    // The propagation destination handles links, not opportunistic packets, so
    // it does not enable ratchets (context_flag stays false).
    assert.strictEqual(announce.contextFlag, false);

    // The announce body carries the PN app_data.
    const result = await Identity.validateAnnounce(
      router.propagationDest.destinationHash,
      announce.contextFlag,
      announce.payload,
    );
    assert.ok(result);
    const parsed = parsePropagationNodeAppData(result.appData);
    assert.ok(parsed);
    assert.strictEqual(parsed.nodeState, true);
  });

  test("enablePropagation is idempotent", async () => {
    const identity = await Identity.generate();
    const router = new LXMRouter(identity, mockRns([]));
    await router.init();
    const a = await router.enablePropagation();
    const b = await router.enablePropagation();
    assert.strictEqual(a, b);
  });
});
