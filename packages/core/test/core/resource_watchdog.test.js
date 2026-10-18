/**
 * Resource transfer watchdog (Python `Resource.__watchdog_job` parity).
 *
 * The JS Resource previously had no watchdog at all: a stalled transfer on a
 * link whose peer keeps answering keepalives (alive at the link layer, wedged
 * at the application layer) never completed, never timed out, and never
 * released its buffers — the accumulated received parts on the receiver, the
 * payload plus encrypted part slices on the sender. Such links never go
 * stale, so every retried sync cycle pinned another stalled transfer,
 * compounding into multi-GB heap growth during sync-failure storms (the
 * propagation/RFed OOM class).
 *
 * The watchdog bounds both sides: sender advertisement retries then cancel;
 * receiver part re-requests then cancel; a cancelled/failed transfer
 * unregisters from its link and drops its buffers. A failed §11 request also
 * cancels its stalled oversized RESPONSE transfer outright.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Allow, Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Resource, ResourceStatus } from "../../src/core/resource.js";
import { Link } from "../../src/transport/link.js";

/**
 * Paired mock transports: sendPacket forwards to the peer, which routes to
 * its local Link/Destination. Real handshakes complete end-to-end.
 */
class MockTransport {
  constructor() {
    this.links = new Map();
    this.destinations = new Map();
    this.peer = null;
    /** @type {Packet[]} */
    this.receivedPackets = [];
    /** Drops outbound packets matching these contexts. */
    this.dropContexts = new Set();
  }
  addLink(hash, link) {
    this.links.set(
      link.linkId ? bufferHex(link.linkId) : bufferHex(hash),
      link,
    );
  }
  removeLink(hash) {
    this.links.delete(bufferHex(hash));
  }
  addDestination(hash, dest) {
    this.destinations.set(bufferHex(hash), dest);
  }
  bindLocalDestination(dest) {
    this.destinations.set(bufferHex(dest.destinationHash), dest);
  }
  establishmentTimeout() {
    return 15;
  }
  requestPathAuto() {
    return Promise.resolve(true);
  }
  requestPath() {
    return Promise.resolve(true);
  }
  expirePath() {}
  async sendPacket(packet) {
    this.receivedPackets.push(packet);
    if (this.dropContexts.has(packet.contextByte)) return true;
    if (this.peer) {
      // Defer to a microtask, like a real network's async delivery: routing
      // synchronously here would let a peer's reply re-enter this link's RX
      // queue while the handler that produced it is still running — a
      // circular wait the sequential queue can never unwind.
      const p = this.peer;
      Promise.resolve().then(() => p._route(packet));
    }
    return true;
  }
  async _route(packet) {
    const dh = bufferHex(packet.destinationHash);
    if (this.links.has(dh)) {
      await this.links.get(dh).receive(packet, this);
    } else if (this.destinations.has(dh)) {
      const dest = this.destinations.get(dh);
      if (packet.packetType === PacketType.LINKREQUEST) {
        const link = await Link.accept(dest, this, packet);
        this.addLink(link.linkId, link);
        await dest.dispatchEvent(new CustomEvent("link", { detail: { link } }));
      }
    }
  }
}

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));
/** Stable hex key for mock maps. */
function bufferHex(bytes) {
  let out = "";
  for (const b of bytes) out += HEX[b];
  return out;
}

/** Establishes a real A→B link over paired mocks and returns both sides. */
async function establishPair() {
  const a = new MockTransport();
  const b = new MockTransport();
  a.peer = b;
  b.peer = a;

  const identityA = await Identity.generate();
  const identityB = await Identity.generate();
  const destB = await Destination.create(
    "test.service",
    Direction.IN,
    DestType.SINGLE,
    identityB,
    /** @type {any} */ ({ transport: b }),
  );
  b.addDestination(destB.destinationHash, destB);
  destB.addEventListener("link_request", async (event) => {
    const link = await destB.acceptLink(
      /** @type {any} */ (event).detail.packet,
      null,
    );
    b.addLink(link.linkId, link);
  });

  const destA = await Destination.create(
    "test.service",
    Direction.OUT,
    DestType.SINGLE,
    identityB,
    /** @type {any} */ ({ transport: a }),
  );
  const linkA = await Link.initiate(destA, /** @type {any} */ (a));
  await linkA.whenActive(5000);
  const linkB = b.links.get(bufferHex(linkA.linkId));
  return { a, b, linkA, linkB };
}

test("sender watchdog retries the advertisement, then cancels and releases", async () => {
  const { a, b, linkA, linkB } = await establishPair();
  try {
    // The peer never requests parts: drop RESOURCE_REQ at the receiver's
    // transport so the sender's advertisement hangs.
    b.dropContexts.add(ContextType.RESOURCE_REQ);

    const resource = new Resource({
      data: new Uint8Array(4096).fill(7),
      link: linkA,
    });
    await resource.advertise();
    assert.equal(linkA.outgoingResources.size, 1);
    const sentBefore = a.receivedPackets.filter(
      (p) => p.contextByte === ContextType.RESOURCE_ADV,
    ).length;
    assert.equal(sentBefore, 1);

    // Backdate the advertisement send past the adv timeout (rtt≈0 → floor
    // 0.5s → timeout = 0.5*6 + 1s grace ≈ 4s) and tick the watchdog.
    resource.advSentAt = Date.now() - 10_000;
    resource.lastActivity = resource.advSentAt;
    linkA._watchdogJob();

    // First stall → bounded advertisement retry (not a cancel).
    await new Promise((r) => setTimeout(r, 50));
    const sentAfter = a.receivedPackets.filter(
      (p) => p.contextByte === ContextType.RESOURCE_ADV,
    ).length;
    assert.ok(sentAfter > sentBefore, "watchdog must retry the advertisement");

    // Drain the retries: each stalled window consumes one retry (the retry's
    // async re-advertise overwrites advSentAt, so wait for it to settle before
    // backdating the next window).
    let guard = 0;
    while (resource.retriesLeft > 0 && guard++ < 60) {
      resource.advSentAt = Date.now() - 10_000;
      resource.lastActivity = resource.advSentAt;
      linkA._watchdogJob();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(resource.retriesLeft, 0, "retries must drain to zero");

    // One more stalled window with no retries left → cancel.
    resource.advSentAt = Date.now() - 10_000;
    resource.lastActivity = resource.advSentAt;
    linkA._watchdogJob();

    await assert.rejects(
      () => resource.whenComplete(),
      /cancel/i,
      "the resource must fail once retries are exhausted",
    );
    assert.equal(
      linkA.outgoingResources.size,
      0,
      "the cancelled transfer must leave the link's map",
    );
    assert.equal(
      resource.parts.length,
      0,
      "the cancelled sender must drop its part slices",
    );
    assert.equal(resource.data, undefined, "and its payload");
  } finally {
    await linkA.teardown().catch(() => {});
  }
});

test("receiver watchdog re-requests stalled parts, then cancels and releases", async () => {
  const { a, b, linkA, linkB } = await establishPair();
  try {
    // Deliver the advertisement, then drop every RESOURCE part in flight —
    // the receiver accepts the transfer but no part ever lands.
    a.dropContexts.add(ContextType.RESOURCE);

    const resource = new Resource({
      data: new Uint8Array(4096).fill(3),
      link: linkA,
    });
    await resource.advertise();

    // Let the receiver accept + send its first part request.
    await new Promise((r) => setTimeout(r, 100));
    const incoming = [...linkB.incomingResources.values()][0];
    assert.ok(incoming, "receiver accepted the transfer");
    assert.ok(incoming.outstanding > 0, "receiver has outstanding parts");

    const reqsBefore = b.receivedPackets.length;

    // Backdate receiver activity past the stall window and tick.
    incoming.lastActivity = Date.now() - 120_000;
    linkB._watchdogJob();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(
      b.receivedPackets.length > reqsBefore ||
        incoming.retriesLeft < Resource.MAX_RETRIES,
      "the stalled receiver must re-request parts (or consume a retry)",
    );

    // Exhaust retries → cancel → unregistered + buffers dropped.
    incoming.lastActivity = Date.now() - 120_000;
    for (let i = 0; i < Resource.MAX_RETRIES + 2; i++) {
      linkB._watchdogJob();
      incoming.lastActivity = Date.now() - 120_000;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(
      linkB.incomingResources.size,
      0,
      "the cancelled receiver transfer must leave the link's map",
    );
    assert.equal(incoming.parts.length, 0, "received parts must be dropped");
    assert.equal(incoming.status, ResourceStatus.FAILED);
  } finally {
    await linkA.teardown().catch(() => {});
  }
});

test("a timed-out REQUEST cancels its stalled oversized RESPONSE transfer", async () => {
  const { a, b, linkA, linkB } = await establishPair();
  try {
    // Oversized response via a request handler; parts never make it to the
    // requester (dropped on the responder's outbound), so the transfer stalls
    // and the request times out.
    b.dropContexts.add(ContextType.RESOURCE);
    const destB = [...b.destinations.values()][0];
    await destB.registerRequestHandler("/slow", {
      responseGenerator: async () => new Uint8Array(64 * 1024).fill(9),
    });

    const promise = linkA.request("/slow", null, { timeout: 400 });
    await assert.rejects(promise, /timed out/);

    // The failed request must take its half-transferred response with it.
    assert.equal(linkA.pendingRequests.size, 0);
    assert.equal(
      linkA.incomingResources.size,
      0,
      "the stalled response transfer must be cancelled with its request",
    );

    // The responder's outgoing copy is bounded by its own watchdog: backdate
    // its activity past the whole retry window and tick — it must cancel,
    // unregister and drop its payload + part slices.
    const responseResource = [...linkB.outgoingResources.values()][0];
    assert.ok(responseResource, "responder holds the response transfer");
    responseResource.lastActivity = Date.now() - 10 * 60_000;
    linkB._watchdogJob();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      linkB.outgoingResources.size,
      0,
      "the responder's stalled transfer must be watchdog-cancelled",
    );
    assert.equal(responseResource.parts.length, 0, "part slices dropped");
    assert.equal(responseResource.data, undefined, "payload dropped");
  } finally {
    await linkA.teardown().catch(() => {});
  }
});
