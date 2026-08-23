/**
 * Held announces (work doc #31 step 3, mirroring Python `Interface.hold_announce`
 * / `process_held_announces` + the Transport.inbound hold decision): while an
 * announce burst is latched, announces for *unknown* destinations are buffered
 * on the receiving interface and released one-per-interval (lowest hops first)
 * once the burst quiets — instead of being processed immediately. Known
 * destinations and destinations with an outstanding `path?` request bypass
 * the hold.
 */
import assert from "node:assert";
import test from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType, Packet } from "../../src/core/packet.js";
import { Interface } from "../../src/interfaces/base.js";
import { TransportCore } from "../../src/transport/transport.js";
import { toHex } from "../../src/utils/encoding.js";

const nowSec = () => Date.now() / 1000;

/** Captures broadcast packets in place of a real interface layer. */
class CapturingLayer {
  constructor() {
    /** @type {Packet[]} */
    this.packets = [];
  }
  /** @param {Packet} pkt */
  broadcast(pkt) {
    this.packets.push(pkt);
  }
}

/**
 * Builds a real announce on the wire (serialize → deserialize) so the inbound
 * path sees exactly what a remote peer would send.
 *
 * @param {string} appName
 * @returns {Promise<{packet: Packet, destinationHash: Uint8Array}>}
 */
async function buildWireAnnounce(appName) {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(appName, DestType.SINGLE, identity, layer);
  await dest.announce();
  const incoming = Packet.deserialize(layer.packets[0].serialize());
  return {
    packet: incoming,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
  };
}

/** An established interface with an announce burst pre-latched (as a flood would). */
class BurstInterface extends Interface {
  readable = null;
  writable = null;
  constructor() {
    super();
    this.name = "burst";
    this.created = Date.now() - 3 * 60 * 60 * 1000; // established
    this.icBurstActive = true;
    this.icBurstActivated = nowSec(); // hold not elapsed
    this.icHeldRelease = nowSec() + this.icBurstPenalty;
  }
}

function burstInterface() {
  return new BurstInterface();
}

test("an unknown-destination announce is held during a burst, not processed", async () => {
  const { packet, destinationHash } =
    await buildWireAnnounce("hold.unknown.dest");
  const transport = new TransportCore();
  const iface = burstInterface();

  /** @type {any} */
  let event = null;
  transport.addEventListener("announce", (e) => {
    event = e.detail;
  });

  await transport._handleAnnounce(packet, iface);

  assert.strictEqual(event, null, "no announce event while held");
  assert.strictEqual(transport.routingTable.hasRoute(destinationHash), false);
  assert.strictEqual(
    iface.heldAnnounces.size,
    1,
    "announce buffered on the interface",
  );
  assert.strictEqual(transport._sweepTimer !== null, true, "sweep armed");
});

test("a known-destination announce is never held", async () => {
  const { packet } = await buildWireAnnounce("hold.known.dest");
  const transport = new TransportCore();
  const iface = burstInterface();

  // First arrival held; pretend a route already exists for a second dest.
  const { packet: second, destinationHash } =
    await buildWireAnnounce("hold.known.dest2");
  transport.routingTable.addOrUpdateRoute(destinationHash, {
    nextHop: destinationHash,
    hops: 1,
    viaInterface: iface,
  });

  /** @type {any} */
  let event = null;
  transport.addEventListener("announce", (e) => {
    event = e.detail;
  });
  await transport._handleAnnounce(second, iface);

  assert.ok(event, "known destination processed immediately despite burst");
  assert.strictEqual(iface.heldAnnounces.size, 0);
});

test("a destination with an outstanding path request bypasses the hold", async () => {
  const { packet, destinationHash } =
    await buildWireAnnounce("hold.waiting.pr");
  const transport = new TransportCore();
  const iface = burstInterface();
  // Record a recent outbound `path?` request for this destination. The
  // held-announce exemption keys off the in-flight PR table (RNS 1.5.0),
  // which is cleared on announce receipt — distinct from the egress MI gate.
  transport.inflightPathRequests.set(toHex(destinationHash), nowSec());

  /** @type {any} */
  let event = null;
  transport.addEventListener("announce", (e) => {
    event = e.detail;
  });
  await transport._handleAnnounce(packet, iface);

  assert.ok(event, "the announce we asked for is never delayed");
  assert.strictEqual(iface.heldAnnounces.size, 0);
});

test("holdAnnounce drops near-max-hop announces, replaces same-dest, caps size", () => {
  const iface = new Interface();
  const fake = (hops, name) => ({
    hops,
    destinationHash: new TextEncoder().encode(name.padEnd(16, ".")),
  });

  iface.holdAnnounce(fake(127, "a")); // >= PATHFINDER_M-1 → dropped
  assert.strictEqual(iface.heldAnnounces.size, 0);
  iface.holdAnnounce(fake(3, "a"));
  assert.strictEqual(iface.heldAnnounces.size, 1);
  iface.holdAnnounce(fake(5, "a")); // same dest → replace
  assert.strictEqual(iface.heldAnnounces.size, 1);
  assert.strictEqual(
    iface.heldAnnounces.values().next().value.hops,
    5,
    "newest emission wins for a held destination",
  );

  iface.icMaxHeldAnnounces = 3;
  iface.holdAnnounce(fake(1, "b"));
  iface.holdAnnounce(fake(1, "c"));
  iface.holdAnnounce(fake(1, "d")); // beyond cap → dropped
  assert.strictEqual(iface.heldAnnounces.size, 3);
});

test("processHeldAnnounces releases lowest-hops first, one per interval", () => {
  const iface = new Interface();
  iface.created = Date.now() - 3 * 60 * 60 * 1000; // established
  const fake = (hops, name) => ({
    hops,
    destinationHash: new TextEncoder().encode(name.padEnd(16, ".")),
  });
  iface.holdAnnounce(fake(4, "far"));
  iface.holdAnnounce(fake(2, "near"));
  iface.holdAnnounce(fake(3, "mid"));

  // Release gate closed: icHeldRelease in the future.
  iface.icHeldRelease = nowSec() + 10;
  assert.strictEqual(iface.processHeldAnnounces(), null);

  // Gate open and quiet (empty frequency deque → 0 Hz < threshold).
  iface.icHeldRelease = nowSec() - 1;
  const first = iface.processHeldAnnounces();
  assert.ok(first);
  assert.strictEqual(
    new TextDecoder().decode(first.destinationHash).startsWith("near"),
    true,
    "lowest hop count released first",
  );
  assert.strictEqual(iface.heldAnnounces.size, 2);

  // Interval re-armed: the next call within 5 s releases nothing.
  assert.strictEqual(iface.processHeldAnnounces(), null);
  iface.icHeldRelease = nowSec() - 1; // force the next window open
  const second = iface.processHeldAnnounces();
  assert.ok(second);
  assert.strictEqual(
    new TextDecoder().decode(second.destinationHash).startsWith("mid"),
    true,
    "next-lowest released next",
  );
});

test("processHeldAnnounces refuses to release while the announce frequency is hot", () => {
  const iface = new Interface();
  iface.created = Date.now() - 3 * 60 * 60 * 1000;
  iface.holdAnnounce({
    hops: 1,
    destinationHash: new TextEncoder().encode("hot.dest........".slice(0, 16)),
  });
  iface.icHeldRelease = nowSec() - 1;
  const now = nowSec();
  iface.iaFreqDeque = [now - 0.2, now - 0.1, now]; // ~15 Hz > 10 threshold
  assert.strictEqual(iface.processHeldAnnounces(), null);
});

test("the transport sweep drains a held announce back into the pipeline", async () => {
  const { packet, destinationHash } = await buildWireAnnounce("hold.sweep");
  const transport = new TransportCore();
  const iface = burstInterface();
  transport.addInterface(iface); // the sweep iterates attached interfaces

  await transport._handleAnnounce(packet, iface);
  assert.strictEqual(iface.heldAnnounces.size, 1);
  assert.ok(transport._sweepTimer);

  // Simulate the burst quieting: hold elapsed, sparse recent samples give a
  // low frequency reading, release gate open.
  iface.icBurstActivated = nowSec() - 20;
  const now = nowSec();
  iface.iaFreqDeque = [now - 2, now - 1, now];
  iface.icHeldRelease = nowSec() - 1;

  /** @type {any} */
  let event = null;
  transport.addEventListener("announce", (e) => {
    event = e.detail;
  });

  // First release: the re-injected announce calls shouldIngressLimit, which
  // unlatches the burst *on that call* but still returns limited — so the
  // announce is re-held (exact Python semantics: the unlatching evaluation
  // still limits).
  await transport._sweepTick();
  assert.strictEqual(event, null, "re-held on the unlatching evaluation");
  assert.strictEqual(iface.heldAnnounces.size, 1);
  assert.strictEqual(iface.icBurstActive, false, "burst unlatched");

  // Second release: burst now inactive → flows through and is ingested.
  iface.icHeldRelease = nowSec() - 1; // force the next window open
  await transport._sweepTick();

  assert.ok(event, "held announce re-entered the pipeline and was ingested");
  assert.strictEqual(transport.routingTable.hasRoute(destinationHash), true);
  assert.strictEqual(iface.heldAnnounces.size, 0);
  // Hops incremented twice (arrival + re-injection), mirroring Python's
  // re-entry through Transport.inbound.
  assert.strictEqual(event.packet.hops, 2);
  // Idle sweep cleaned itself up.
  assert.strictEqual(transport._sweepTimer, null);
});
