/**
 * End-to-end tests for the `lxmf.delivery` announce path in {@link LXMRouter}
 * (SPEC §4.3 + §4.5).
 *
 * Verifies that:
 *  - `router.announce(name, stampCost)` attaches a §4.3 msgpack `app_data` to
 *    the announce body, signed verbatim, and recoverable via
 *    `Identity.validateAnnounce` + `parseAnnounceAppData`.
 *  - A validated inbound announce dispatched by the transport fires a `peer`
 *    event carrying the decoded `app_data`.
 */
import assert from "node:assert";
import test from "node:test";
import {
  buildAnnounceAppData,
  parseAnnounceAppData,
} from "../../src/lxmf/announce_data.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import { SF_COMPRESSION } from "../../src/lxmf/constants.js";
import { Identity } from "../../src/core/identity.js";

/**
 * Builds a mock RNS core whose `transport` is a real EventTarget so the
 * router's inbound-announce listener can be exercised, and whose `broadcast`
 * captures outgoing announce packets.
 *
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

test("LXMRouter.announce attaches a §4.3 app_data recoverable from the wire", async () => {
  const identity = await Identity.generate();
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const captured = [];
  const router = new LXMRouter(identity, mockRns(captured));
  await router.init();

  await router.announce("TestNode", 8);

  assert.strictEqual(captured.length, 1, "one announce packet broadcast");
  const pkt = captured[0];

  // The app_data is part of the signed announce body, so recover it through
  // the same validation path a remote peer would use (§4.5).
  const result = await Identity.validateAnnounce(
    /** @type {Uint8Array} */ (pkt.destinationHash),
    pkt.contextFlag,
    pkt.payload,
  );
  assert.ok(result, "our own announce must validate");

  const parsed = parseAnnounceAppData(result.appData);
  assert.ok(parsed);
  assert.strictEqual(parsed.displayName, "TestNode");
  assert.strictEqual(parsed.stampCost, 8);
  assert.deepStrictEqual(parsed.supportedFunctions, [SF_COMPRESSION]);
});

test("LXMRouter.announce with a Unicode name round-trips losslessly", async () => {
  const identity = await Identity.generate();
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const captured = [];
  const router = new LXMRouter(identity, mockRns(captured));
  await router.init();

  const name = "Søren ☃";
  await router.announce(name, null);

  const result = await Identity.validateAnnounce(
    /** @type {Uint8Array} */ (captured[0].destinationHash),
    captured[0].contextFlag,
    captured[0].payload,
  );
  assert.ok(result);
  const parsed = parseAnnounceAppData(result.appData);
  assert.ok(parsed);
  assert.strictEqual(parsed.displayName, name);
});

test("LXMRouter fires a `peer` event with decoded app_data on inbound announce", async () => {
  const identity = await Identity.generate();
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const captured = [];
  const rns = mockRns(captured);
  const router = new LXMRouter(identity, rns);
  await router.init();

  /** @type {any} */
  let peer = null;
  router.addEventListener("peer", (event) => {
    peer = /** @type {CustomEvent} */ (event).detail;
  });

  // Simulate a remote peer's validated announce arriving from the transport.
  const remoteIdentity = await Identity.generate();
  const remoteAppData = buildAnnounceAppData("RemoteNode", 16);
  const remoteHash = crypto.getRandomValues(new Uint8Array(16));

  rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: {
        destinationHash: remoteHash,
        identity: remoteIdentity,
        appData: remoteAppData,
      },
    }),
  );

  assert.ok(peer, "expected a peer event");
  assert.deepStrictEqual(peer.destinationHash, remoteHash);
  assert.strictEqual(peer.identity, remoteIdentity);
  assert.ok(peer.appData);
  assert.strictEqual(peer.appData.displayName, "RemoteNode");
  assert.strictEqual(peer.appData.stampCost, 16);
});

test("LXMRouter fires a `peer` event even for legacy raw-UTF-8 app_data", async () => {
  const identity = await Identity.generate();
  const rns = mockRns([]);
  const router = new LXMRouter(identity, rns);
  await router.init();

  /** @type {any} */
  let peer = null;
  router.addEventListener("peer", (event) => {
    peer = /** @type {CustomEvent} */ (event).detail;
  });

  rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: {
        destinationHash: crypto.getRandomValues(new Uint8Array(16)),
        identity: await Identity.generate(),
        // "Original announce format": a bare UTF-8 name, not msgpack-wrapped.
        appData: new TextEncoder().encode("LegacyPeer"),
      },
    }),
  );

  assert.ok(peer);
  assert.strictEqual(peer.appData.displayName, "LegacyPeer");
  assert.strictEqual(peer.appData.stampCost, null);
});
