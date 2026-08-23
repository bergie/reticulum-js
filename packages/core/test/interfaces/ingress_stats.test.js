/**
 * Ingress-control observability (work doc #31): counters and stats fields
 * surfacing the flood-defense machinery — burst latch counts, burst-dropped
 * PRs (our inline equivalent of Python's `rxqild` queue-drop counter), held
 * announce releases/cap-drops, and the announce/PR frequency readings Python
 * exposes via rnstatus.
 */
import assert from "node:assert";
import test from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Interface } from "../../src/interfaces/base.js";
import { TransportCore } from "../../src/transport/transport.js";

const nowSec = () => Date.now() / 1000;

/** Captures broadcasts in place of a real interface layer. */
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

/** Minimal concrete interface registered with a transport. */
class StubInterface extends Interface {
  readable = null;
  writable = null;
}

test("getStats surfaces the ingress-control state with fresh defaults", () => {
  const iface = new StubInterface();
  const stats = iface.getStats();
  assert.strictEqual(stats.announceBurstActive, false);
  assert.strictEqual(stats.announceBurstActivated, 0);
  assert.strictEqual(stats.announceBurstCount, 0);
  assert.strictEqual(stats.prBurstActive, false);
  assert.strictEqual(stats.prBurstActivated, 0);
  assert.strictEqual(stats.prBurstCount, 0);
  assert.strictEqual(stats.prBurstDrops, 0);
  assert.strictEqual(stats.heldAnnounces, 0);
  assert.strictEqual(stats.heldAnnounceReleases, 0);
  assert.strictEqual(stats.heldAnnounceDrops, 0);
  assert.strictEqual(stats.incomingAnnounceFrequency, 0);
  assert.strictEqual(stats.outgoingAnnounceFrequency, 0);
  assert.strictEqual(stats.incomingPrFrequency, 0);
  assert.strictEqual(stats.outgoingPrFrequency, 0);
  // Protocol-violation counters (RNS 1.5.0) start at zero.
  assert.strictEqual(stats.protocolViolations, 0);
  assert.strictEqual(stats.ifacViolations, 0);
  assert.strictEqual(stats.packetFilterHits, 0);
  // Pre-existing fields still present.
  assert.strictEqual(stats.rxb, 0);
  assert.strictEqual(stats.txb, 0);
  assert.strictEqual(typeof stats.name, "string");
});

test("a PR flood through the transport counts the latch and the drops", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(
    "stats.pr.flood",
    DestType.SINGLE,
    identity,
    layer,
  );
  const transport = new TransportCore();
  transport.bindLocalDestination(dest);
  const iface = new StubInterface();
  iface.name = "flooded";
  transport.addInterface(iface);

  const target = /** @type {Uint8Array} */ (dest.destinationHash);
  for (let i = 0; i < 10; i++) {
    const payload = new Uint8Array(32);
    payload.set(target, 0);
    payload.set(crypto.getRandomValues(new Uint8Array(16)), 16);
    await transport._handlePathRequest(
      new Packet({
        packetType: PacketType.DATA,
        destinationType: DestType.PLAIN,
        destinationHash: await transport._pathRequestDestHash(),
        contextByte: ContextType.NONE,
        payload,
      }),
      iface,
    );
  }

  const stats = iface.getStats();
  assert.strictEqual(stats.prBurstCount, 1, "one latch per flood episode");
  assert.ok(stats.prBurstDrops > 0, "burst drops are visible");
  assert.strictEqual(stats.prBurstActive, true);
  assert.ok(stats.prBurstActivated > 0);
  assert.ok(stats.incomingPrFrequency > 0, "PR frequency readable");
  // Bursts latch without touching the announce counters.
  assert.strictEqual(stats.announceBurstCount, 0);
  assert.strictEqual(stats.heldAnnounceDrops, 0);
});

test("held-announce cap drops and releases are counted", () => {
  const iface = new StubInterface();
  iface.icMaxHeldAnnounces = 2;
  const fake = (name) => ({
    hops: 1,
    destinationHash: new TextEncoder().encode(name.padEnd(16, ".")),
  });

  iface.holdAnnounce(fake("a"));
  iface.holdAnnounce(fake("b"));
  iface.holdAnnounce(fake("c")); // beyond cap → dropped
  assert.strictEqual(iface.heldAnnounceDrops, 1);
  assert.strictEqual(iface.getStats().heldAnnounces, 2);

  // Quiet + release gate open → one release counted.
  iface.created = Date.now() - 3 * 60 * 60 * 1000; // established
  iface.icHeldRelease = nowSec() - 1;
  iface.iaFreqDeque = [];
  const released = iface.processHeldAnnounces();
  assert.ok(released);
  assert.strictEqual(iface.heldAnnounceReleases, 1);
  assert.strictEqual(iface.getStats().heldAnnounces, 1);
});

test("broadcasting an announce counts sentAnnounce on the interfaces", async () => {
  const transport = new TransportCore();
  const iface = new StubInterface();
  transport.addInterface(iface);

  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(
    "stats.announce",
    DestType.SINGLE,
    identity,
    layer,
  );
  await dest.announce();

  transport.broadcast(layer.packets[0]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  transport.broadcast(layer.packets[0]);
  assert.strictEqual(iface.oaFreqDeque.length, 2, "one sample per broadcast");
  const stats = iface.getStats();
  assert.strictEqual(stats.outgoingAnnounceFrequency > 0, true);
  // And announce ingress tracking feeds the other direction.
  assert.strictEqual(stats.incomingAnnounceFrequency, 0, "nothing received");
});
