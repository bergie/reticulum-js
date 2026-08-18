/**
 * Tests for `path?` request / response (SPEC.md §7.1 / §7.2 — leaf minimum).
 *
 * Covers the well-known request destination hash, the request-payload layout,
 * tag-based dedup, tagless-request rejection, and the branch-1 response (a
 * local destination answers with a PATH_RESPONSE announce).
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
import { bytesEqual, toHex } from "../../src/utils/encoding.js";

/** Captures broadcast packets (announces / path-responses). */
class CapturingLayer {
  constructor() {
    /** @type {Packet[]} */
    this.packets = [];
    this.useImplicitProof = true;
  }
  /** @param {Packet} pkt */
  broadcast(pkt) {
    this.packets.push(pkt);
  }
}

/**
 * @param {Uint8Array} targetHash
 * @param {Uint8Array} tag
 * @returns {Uint8Array} leaf-form path? payload: target(16) || tag(16).
 */
function leafPayload(targetHash, tag) {
  const p = new Uint8Array(32);
  p.set(targetHash, 0);
  p.set(tag, 16);
  return p;
}

test("the path-request destination hash is the well-known constant", async () => {
  const transport = new TransportCore();
  const hash = await transport._pathRequestDestHash();
  assert.strictEqual(
    toHex(hash),
    "6b9f66014d9853faab220fba47d02761",
    "every node must resolve rnstransport.path.request identically",
  );
});

test("requestPath emits a DATA packet to the path-request dest with target || tag(16)", async () => {
  const transport = new TransportCore();
  /** @type {Packet[]} */ const captured = [];
  transport.broadcast = (/** @type {Packet} */ pkt) => captured.push(pkt);

  const target = crypto.getRandomValues(new Uint8Array(16));
  await transport.requestPath(target);

  assert.strictEqual(captured.length, 1);
  const pkt = captured[0];
  assert.strictEqual(pkt.packetType, PacketType.DATA);
  assert.strictEqual(pkt.destinationType, DestType.PLAIN);
  assert.strictEqual(pkt.contextByte, ContextType.NONE);
  assert.ok(
    bytesEqual(
      /** @type {Uint8Array} */ (pkt.destinationHash),
      await transport._pathRequestDestHash(),
    ),
  );
  assert.strictEqual(pkt.payload.length, 32, "leaf form is target(16)+tag(16)");
  assert.ok(bytesEqual(pkt.payload.slice(0, 16), target));
  // The tag half must be non-zero random bytes.
  assert.notDeepStrictEqual(
    Array.from(pkt.payload.slice(16, 32)),
    new Array(16).fill(0),
  );
});

test("requestPath rejects a non-16-byte destination hash", async () => {
  const transport = new TransportCore();
  await assert.rejects(
    () => transport.requestPath(new Uint8Array(10)),
    /16-byte destination hash/,
  );
});

test("a path request for a local destination triggers a PATH_RESPONSE announce", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );
  const transport = new TransportCore();
  transport.bindLocalDestination(dest);

  const tag = crypto.getRandomValues(new Uint8Array(16));
  const req = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    contextByte: ContextType.NONE,
    payload: leafPayload(/** @type {Uint8Array} */ (dest.destinationHash), tag),
  });
  await transport._handlePathRequest(req, null);

  assert.strictEqual(layer.packets.length, 1, "one path-response announce");
  const resp = layer.packets[0];
  assert.strictEqual(resp.packetType, PacketType.ANNOUNCE);
  assert.strictEqual(resp.contextByte, ContextType.PATH_RESPONSE);
  assert.ok(
    bytesEqual(
      /** @type {Uint8Array} */ (resp.destinationHash),
      /** @type {Uint8Array} */ (dest.destinationHash),
    ),
  );
});

test("a retransmitted path request with the same tag is deduped", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );
  const transport = new TransportCore();
  transport.bindLocalDestination(dest);

  const tag = crypto.getRandomValues(new Uint8Array(16));
  const req = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    contextByte: ContextType.NONE,
    payload: leafPayload(/** @type {Uint8Array} */ (dest.destinationHash), tag),
  });
  await transport._handlePathRequest(req, null);
  layer.packets.length = 0;
  await transport._handlePathRequest(req, null); // identical tag

  assert.strictEqual(
    layer.packets.length,
    0,
    "duplicate (target, tag) must not trigger a second announce",
  );
});

test("a tagless path request (16-byte payload) is dropped", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );
  const transport = new TransportCore();
  transport.bindLocalDestination(dest);

  const tagless = new Uint8Array(16); // target only, no tag
  tagless.set(/** @type {Uint8Array} */ (dest.destinationHash), 0);
  const req = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    contextByte: ContextType.NONE,
    payload: tagless,
  });
  await transport._handlePathRequest(req, null);
  assert.strictEqual(layer.packets.length, 0);
});

test("a leaf does not answer a path request for a destination it doesn't own", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );
  const transport = new TransportCore();

  const foreignTarget = crypto.getRandomValues(new Uint8Array(16));
  const tag = crypto.getRandomValues(new Uint8Array(16));
  const req = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    contextByte: ContextType.NONE,
    payload: leafPayload(foreignTarget, tag),
  });
  await transport._handlePathRequest(req, null);
  assert.strictEqual(
    layer.packets.length,
    0,
    "leaf can't fulfil foreign requests",
  );
});

test("the transport-form (48-byte) payload is parsed with transport_id + tag", async () => {
  // §7.2.1: len > 32 → [16:32] is transport_id (ignored on a leaf), tag at [32:48].
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );
  const transport = new TransportCore();
  transport.bindLocalDestination(dest);

  const transportId = crypto.getRandomValues(new Uint8Array(16));
  const tag = crypto.getRandomValues(new Uint8Array(16));
  const payload = new Uint8Array(48);
  payload.set(/** @type {Uint8Array} */ (dest.destinationHash), 0);
  payload.set(transportId, 16);
  payload.set(tag, 32);
  const req = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    contextByte: ContextType.NONE,
    payload,
  });
  await transport._handlePathRequest(req, null);
  assert.strictEqual(layer.packets.length, 1, "tag is present → respond");
});

test("end-to-end: A requests a path, B answers, A receives a validated announce", async () => {
  // Two transports wired back-to-back via a loopback interface pair.
  const transportA = new TransportCore();
  const transportB = new TransportCore();

  const ifaceA = Object.assign(new EventTarget(), {
    name: "a-b",
    _packetWriter: {
      write: async (/** @type {Packet} */ pkt) => {
        setImmediate(() => transportB._routeIncomingPacket(pkt, ifaceA));
      },
    },
  });
  const ifaceB = Object.assign(new EventTarget(), {
    name: "b-a",
    _packetWriter: {
      write: async (/** @type {Packet} */ pkt) => {
        setImmediate(() => transportA._routeIncomingPacket(pkt, ifaceB));
      },
    },
  });
  transportA.addInterface(ifaceA, true);
  transportB.addInterface(ifaceB, true);

  // B owns the target destination.
  const identityB = await Identity.generate();
  const destB = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identityB,
    /** @type {any} */ ({
      broadcast: (/** @type {Packet} */ pkt) => transportB.broadcast(pkt),
      useImplicitProof: true,
    }),
  );
  transportB.bindLocalDestination(destB);

  /** @type {any} */
  let received = null;
  transportA.addEventListener("announce", (event) => {
    received = /** @type {CustomEvent} */ (event).detail;
  });

  // A asks for a path to B.
  await transportA.requestPath(
    /** @type {Uint8Array} */ (destB.destinationHash),
  );

  // Let the async request → response → announce round-trip complete.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(received, "A should receive B's path-response announce");
  assert.ok(
    bytesEqual(received.destinationHash, destB.destinationHash),
    "the announce must be for B's destination",
  );
  assert.ok(
    bytesEqual(received.identity.identityHash, identityB.identityHash),
    "A must learn B's identity from the announce",
  );
});

// ---------------------------------------------------------------------
// Ingress burst control + path-response cache (work doc #31 steps 1–2,
// mirroring the Python reference's ingress control and path_responses)
// ---------------------------------------------------------------------

/**
 * Builds a transport + owned destination whose path-response announces are
 * captured, plus a real `Interface` as the receiving interface.
 * @returns {Promise<{transport: TransportCore, dest: any, layer: CapturingLayer, iface: import("../../src/interfaces/base.js").Interface}>}
 */
async function prFixture() {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );
  const transport = new TransportCore();
  transport.bindLocalDestination(dest);
  const iface = new Interface();
  iface.name = "pr-fixture";
  return { transport, dest, layer, iface };
}

test("a latched PR ingress burst drops unique-tag path requests", async () => {
  const { transport, dest, layer, iface } = await prFixture();
  // Pre-latch a burst (activation just now — hold has not elapsed).
  iface.icPrBurstActive = true;
  iface.icPrBurstActivated = Date.now() / 1000;

  const tag = crypto.getRandomValues(new Uint8Array(16));
  const req = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    contextByte: ContextType.NONE,
    payload: leafPayload(/** @type {Uint8Array} */ (dest.destinationHash), tag),
  });
  await transport._handlePathRequest(req, iface);

  assert.strictEqual(layer.packets.length, 0, "burst → dropped, no response");
  // The PR still counted toward the frequency window before the drop.
  assert.strictEqual(iface.ipFreqDeque.length, 1);
});

test("a flood of unique-tag PRs latches the burst and bounds responses", async () => {
  const { transport, dest, layer, iface } = await prFixture();

  // Fire 10 unique-tag PRs back-to-back (the "75 PRs/s" pattern): a new
  // interface (age < 2 h) latches at > 3/s, so only the first few are
  // answered before the burst detector kicks in.
  for (let i = 0; i < 10; i++) {
    const tag = crypto.getRandomValues(new Uint8Array(16));
    const req = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.PLAIN,
      destinationHash: await transport._pathRequestDestHash(),
      contextByte: ContextType.NONE,
      payload: leafPayload(
        /** @type {Uint8Array} */ (dest.destinationHash),
        tag,
      ),
    });
    await transport._handlePathRequest(req, iface);
  }

  assert.strictEqual(iface.icPrBurstActive, true, "burst must latch");
  assert.ok(
    layer.packets.length < 10,
    `responses must be bounded by the burst detector (got ${layer.packets.length})`,
  );
  assert.ok(layer.packets.length >= 1, "early PRs are still answered");
});

test("a retransmitted PR reuses the cached announce payload (path_responses)", async () => {
  const { transport, dest, layer } = await prFixture();
  const tag = crypto.getRandomValues(new Uint8Array(16));

  const req = async () =>
    new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.PLAIN,
      destinationHash: await transport._pathRequestDestHash(),
      contextByte: ContextType.NONE,
      payload: leafPayload(
        /** @type {Uint8Array} */ (dest.destinationHash),
        tag,
      ),
    });

  await transport._handlePathRequest(await req(), null);
  assert.strictEqual(layer.packets.length, 1);
  assert.strictEqual(
    dest.pathResponses.size,
    1,
    "tagged response cached (Python path_responses)",
  );

  // Simulate the transport tag ring having overflowed (the scenario the
  // cache defends against): clear it so the same-tag PR is processed again.
  transport.discoveryPrTags.clear();
  await transport._handlePathRequest(await req(), null);

  assert.strictEqual(layer.packets.length, 2);
  assert.ok(
    bytesEqual(layer.packets[0].payload, layer.packets[1].payload),
    "same tag → cached announce payload retransmitted, no re-signing",
  );
});

test("path-response cache entries expire after PR_TAG_WINDOW", async () => {
  const { dest } = await prFixture();

  // Plant a stale entry and prune.
  dest.pathResponses.set("deadbeef", {
    time: Date.now() / 1000 - (Destination.PR_TAG_WINDOW + 5),
    announceData: new Uint8Array(1),
    hasRatchet: false,
  });
  dest._prunePathResponses();
  assert.strictEqual(dest.pathResponses.size, 0, "stale entry pruned");
});
