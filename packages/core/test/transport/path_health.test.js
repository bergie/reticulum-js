/**
 * Tests for bitrate-adaptive timeouts + path-health state (work doc #29).
 *
 * Covers:
 *   - `TransportCore.firstHopTimeout` / `establishmentTimeout` /
 *     `extraLinkProofTimeout` math (mirrors `RNS.Transport`).
 *   - path-state transitions driven at the leaf chokepoints: a validated PROOF
 *     flips the path RESPONSIVE; a proof that times out flips it UNRESPONSIVE.
 *   - `PacketReceipt.startTimeout` firing `setFailed` and leaving the registry.
 */
import assert from "node:assert";
import test from "node:test";
import {
  createAnnounceRandomHash,
  Destination,
} from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { PacketReceipt, ReceiptStatus } from "../../src/core/packet_receipt.js";
import { Reticulum } from "../../src/core/reticulum.js";
import { PathState } from "../../src/transport/router.js";

/** Network MTU / base per-hop timeout mirrored from RNS.Reticulum (protocol-fixed). */
const MTU = 500;
const DEFAULT_PER_HOP_TIMEOUT = 6;

/**
 * Loopback interface that routes every written packet straight back into the
 * transport, with a configurable bitrate for the timeout math.
 * @param {import("../../src/transport/transport.js").TransportCore} transport
 * @param {number} bitrate
 */
function attachLoopback(transport, bitrate = 1_000_000) {
  const iface = Object.assign(new EventTarget(), {
    name: "loopback",
    bitrate,
    _packetWriter: {
      write: async (/** @type {Packet} */ pkt) => {
        setImmediate(() => {
          transport._routeIncomingPacket(pkt, iface);
        });
      },
    },
  });
  transport.addInterface(iface, true);
  return iface;
}

test("firstHopTimeout: MTU*8/bitrate + DEFAULT_PER_HOP_TIMEOUT for a known route", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const iface = attachLoopback(transport, 1000);
  const hash = crypto.getRandomValues(new Uint8Array(16));
  transport.routingTable.addOrUpdateRoute(hash, {
    nextHop: crypto.getRandomValues(new Uint8Array(16)),
    hops: 1,
    viaInterface: iface,
    randomBlob: createAnnounceRandomHash(
      crypto.getRandomValues(new Uint8Array(16)),
      1000,
    ),
  });

  // 500 * 8 / 1000 + 6 = 10 seconds.
  assert.strictEqual(transport.firstHopTimeout(hash), 10);
  // Reticulum.getFirstHopTimeout delegates to the transport.
  assert.strictEqual(rns.getFirstHopTimeout(hash), 10);
});

test("firstHopTimeout: falls back to DEFAULT_PER_HOP_TIMEOUT with no route / bitrate", () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const unknown = crypto.getRandomValues(new Uint8Array(16));
  assert.strictEqual(
    transport.firstHopTimeout(unknown),
    DEFAULT_PER_HOP_TIMEOUT,
  );

  // A route whose interface has no bitrate also falls back.
  const hash = crypto.getRandomValues(new Uint8Array(16));
  const noBitrateIface = Object.assign(new EventTarget(), { name: "nb" });
  transport.routingTable.addOrUpdateRoute(hash, {
    nextHop: crypto.getRandomValues(new Uint8Array(16)),
    hops: 1,
    viaInterface: noBitrateIface,
    randomBlob: createAnnounceRandomHash(
      crypto.getRandomValues(new Uint8Array(16)),
      1,
    ),
  });
  assert.strictEqual(transport.firstHopTimeout(hash), DEFAULT_PER_HOP_TIMEOUT);
});

test("establishmentTimeout: firstHopTimeout + PER_HOP * max(1, hops)", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const iface = attachLoopback(transport, 1000);
  const hash = crypto.getRandomValues(new Uint8Array(16));
  transport.routingTable.addOrUpdateRoute(hash, {
    nextHop: crypto.getRandomValues(new Uint8Array(16)),
    hops: 3,
    viaInterface: iface,
    randomBlob: createAnnounceRandomHash(
      crypto.getRandomValues(new Uint8Array(16)),
      1000,
    ),
  });

  // first_hop(10) + 6 * max(1, 3) = 10 + 18 = 28 seconds.
  assert.strictEqual(transport.establishmentTimeout(hash), 28);
  // 1-hop fallback when the route has no hop count recorded.
  const oneHop = crypto.getRandomValues(new Uint8Array(16));
  transport.routingTable.addOrUpdateRoute(oneHop, {
    nextHop: crypto.getRandomValues(new Uint8Array(16)),
    hops: 1,
    viaInterface: iface,
    randomBlob: createAnnounceRandomHash(
      crypto.getRandomValues(new Uint8Array(16)),
      2000,
    ),
  });
  assert.strictEqual(
    transport.establishmentTimeout(oneHop),
    10 + DEFAULT_PER_HOP_TIMEOUT * 1,
  );
});

test("extraLinkProofTimeout: (8 / bitrate) * MTU, 0 without a bitrate", () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const fast = /** @type {any} */ ({ bitrate: 1000 });
  // (8 / 1000) * 500 = 4 seconds.
  assert.strictEqual(transport.extraLinkProofTimeout(fast), 4);
  assert.strictEqual(transport.extraLinkProofTimeout(null), 0);
  assert.strictEqual(
    transport.extraLinkProofTimeout(/** @type {any} */ ({})),
    0,
  );
});

/**
 * Online interface stub with a configurable bitrate for the medium-timeout
 * tests. Mirrors `attachLoopback`'s shape but with explicit `online` control
 * and no packet routing.
 * @param {number} bitrate
 * @param {boolean} [online]
 */
function onlineIface(bitrate, online = true) {
  return Object.assign(new EventTarget(), {
    name: `iface-${bitrate}`,
    bitrate,
    online,
  });
}

test("lowestInterfaceBitrate: min of online interfaces with a bitrate", () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  // No interfaces → null.
  assert.strictEqual(transport.lowestInterfaceBitrate, null);

  const fast = onlineIface(1_000_000);
  const slow = onlineIface(1000);
  transport.addInterface(fast);
  transport.addInterface(slow);
  assert.strictEqual(transport.lowestInterfaceBitrate, 1000);

  // Removing the slow one recomputes from the remaining set.
  transport.removeInterface(slow);
  assert.strictEqual(transport.lowestInterfaceBitrate, 1_000_000);
});

test("lowestInterfaceBitrate: ignores offline / zero / non-numeric bitrates", () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const online = onlineIface(5000, true);
  const offline = onlineIface(100, false);
  const zero = onlineIface(0, true);
  const nonNumeric = Object.assign(new EventTarget(), {
    name: "nn",
    online: true,
    bitrate: "fast",
  });
  transport.addInterface(online);
  transport.addInterface(offline);
  transport.addInterface(zero);
  transport.addInterface(nonNumeric);
  assert.strictEqual(transport.lowestInterfaceBitrate, 5000);

  // Only the offline one left → null.
  transport.removeInterface(online);
  assert.strictEqual(transport.lowestInterfaceBitrate, null);
});

test("mediumPathTimeout: 0 with no online bitrate", () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  assert.strictEqual(transport.mediumPathTimeout(), 0);
  // An offline interface doesn't lift the unknown state.
  transport.addInterface(onlineIface(1000, false));
  assert.strictEqual(transport.mediumPathTimeout(), 0);
});

test("mediumPathTimeout: 2*(MTU*8/rate) + DEFAULT_PER_HOP_TIMEOUT", () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  transport.addInterface(onlineIface(1000));
  // 2 * (500 * 8 / 1000) + 6 = 2 * 4 + 6 = 14 seconds.
  assert.strictEqual(transport.mediumPathTimeout(), 14);
  // Reticulum.getMediumPathTimeout delegates to the transport.
  assert.strictEqual(rns.getMediumPathTimeout(), 14);
  // Reticulum.getLowestInterfaceBitrate delegates too.
  assert.strictEqual(rns.getLowestInterfaceBitrate(), 1000);
});

test("mediumPathTimeout: clamps sub-minimum bitrate to MINIMUM_BITRATE", () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  // bitrate below MINIMUM_BITRATE (5) is clamped up to 5.
  transport.addInterface(onlineIface(1));
  // 2 * (500 * 8 / 5) + 6 = 2 * 800 + 6 = 1606 seconds.
  assert.strictEqual(transport.mediumPathTimeout(), 1606);
});

test("PacketReceipt.startTimeout fires setFailed and leaves the registry", async () => {
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const destinationHash = crypto.getRandomValues(new Uint8Array(16));
  let failed = 0;
  const receipt = new PacketReceipt(packetHash, destinationHash, {
    failed: () => {
      failed += 1;
    },
  });
  PacketReceipt.track(receipt);
  receipt.startTimeout(40);

  await new Promise((r) => setTimeout(r, 70));
  assert.strictEqual(receipt.status, ReceiptStatus.FAILED);
  assert.strictEqual(failed, 1);
  assert.strictEqual(PacketReceipt.find(receipt.truncatedHash), null);
});

test("a validated PROOF flips the path state RESPONSIVE", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  attachLoopback(transport);

  const recvIdentity = await Identity.generate();
  const recvDest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    recvIdentity,
    /** @type {any} */ (rns),
  );
  transport.bindLocalDestination(recvDest);
  await Destination.remember(
    crypto.getRandomValues(new Uint8Array(32)),
    /** @type {Uint8Array} */ (recvDest.destinationHash),
    recvIdentity.publicKey,
  );

  // Seed a route to the receiver so markPathResponsive has a target. It starts
  // UNKNOWN; a successful proof must flip it RESPONSIVE.
  transport.routingTable.addOrUpdateRoute(recvDest.destinationHash, {
    nextHop: crypto.getRandomValues(new Uint8Array(16)),
    hops: 1,
    viaInterface: transport.defaultInterface,
    randomBlob: createAnnounceRandomHash(
      crypto.getRandomValues(new Uint8Array(16)),
      1000,
    ),
  });
  assert.strictEqual(
    transport.routingTable.getState(recvDest.destinationHash),
    PathState.UNKNOWN,
  );

  const payload = await recvIdentity.encrypt(new Uint8Array([42]));
  const dataPacket = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: /** @type {Uint8Array} */ (recvDest.destinationHash),
    contextByte: ContextType.NONE,
    payload,
  });
  await transport.sendPacket(dataPacket);
  // Let the loopback proof round-trip resolve the receipt.
  await new Promise((r) => setTimeout(r, 50));

  assert.strictEqual(
    transport.routingTable.getState(recvDest.destinationHash),
    PathState.RESPONSIVE,
    "a validated proof must mark the path responsive",
  );
});

test("a proof that times out flips the path state UNRESPONSIVE", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  attachLoopback(transport);

  // A destination nobody proves for (no receiver bound), but we have a route.
  const silentHash = crypto.getRandomValues(new Uint8Array(16));
  transport.routingTable.addOrUpdateRoute(silentHash, {
    nextHop: crypto.getRandomValues(new Uint8Array(16)),
    hops: 1,
    viaInterface: transport.defaultInterface,
    randomBlob: createAnnounceRandomHash(
      crypto.getRandomValues(new Uint8Array(16)),
      1000,
    ),
  });

  const dataPacket = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: silentHash,
    contextByte: ContextType.NONE,
    payload: new Uint8Array([1]),
  });
  await transport.sendPacket(dataPacket);

  // sendPacket started a firstHopTimeout receipt (~6s). Simulate the timeout
  // firing by clearing the real timer and driving the failed path directly,
  // so the test stays under the per-test timeout.
  const dataHash = await dataPacket.getHash();
  const tracked = PacketReceipt.find(dataHash.slice(0, 16));
  assert.ok(tracked, "sendPacket should track a PacketReceipt");
  tracked.clearTimeout();
  tracked.setFailed();

  assert.strictEqual(
    transport.pathIsUnresponsive(silentHash),
    true,
    "a timed-out proof must mark the path unresponsive",
  );
  assert.strictEqual(
    transport.routingTable.getState(silentHash),
    PathState.UNRESPONSIVE,
  );
});
