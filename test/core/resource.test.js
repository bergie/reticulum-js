/**
 * Resource fragmentation protocol tests (PROTOCOL-SPEC.md §10).
 *
 * Covers sender preparation (encrypt-whole-then-slice, hashmap, integrity
 * material), the SDU/HASHMAP_MAX_LEN sizing, and end-to-end single-segment
 * transfers over a loopback link pair — including a large transfer that
 * exceeds HASHMAP_MAX_LEN parts (exercising RESOURCE_HMU), optional bz2
 * compression via an injected module, map_hash-based placement, and
 * advertisement rejection.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Resource, ResourceStatus } from "../../src/core/resource.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";

/**
 * Loopback transport. Delivery is deferred to a separate microtask so that
 * inbound packets never process re-entrantly inside the sender's send() call —
 * mirroring real network latency and avoiding rxQueue deadlocks on the
 * synchronous event loop.
 */
class MockTransport {
  constructor() {
    /** @type {Packet[]} */
    this.receivedPackets = [];
    /** @type {Map<string, Link>} */
    this.links = new Map();
    /** @type {Map<string, Destination>} */
    this.destinations = new Map();
    this.peer = null;
  }
  /** @param {Uint8Array} hash @param {Link} link */
  addLink(hash, link) {
    this.links.set(toHex(hash), link);
  }
  removeLink(hash) {
    this.links.delete(toHex(hash));
  }
  /** @param {Uint8Array} hash @param {Destination} dest */
  addDestination(hash, dest) {
    this.destinations.set(toHex(hash), dest);
  }
  /** @param {Packet} packet */
  async sendPacket(packet) {
    this.receivedPackets.push(packet);
    if (this.peer) {
      const peer = this.peer;
      Promise.resolve()
        .then(() => peer._route(packet))
        .catch((err) => {
          // Surface routing errors without crashing the process.
          console.error(
            "MockTransport route error:",
            String(err).slice(0, 120),
          );
        });
    }
    return true;
  }
  /** @param {Packet} packet */
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.links.has(dh)) {
      await this.links.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      const dest = this.destinations.get(dh);
      if (packet.packetType === PacketType.LINKREQUEST) {
        const link = await Link.accept(dest, this, packet);
        this.addLink(link.linkId, link);
      }
    }
  }
}

/**
 * @returns {Promise<{ initiator: Link, responder: Link, tInit: MockTransport, tResp: MockTransport }>}
 */
async function makePair() {
  const responderIdentity = await Identity.generate();
  const transportI = new MockTransport();
  const transportR = new MockTransport();
  transportI.peer = transportR;
  transportR.peer = transportI;

  const responderDest = await Destination.create(
    "responder",
    Direction.IN,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: transportR }),
  );
  transportR.addDestination(responderDest.destinationHash, responderDest);

  const initiatorDest = await Destination.create(
    "responder",
    Direction.OUT,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: transportI }),
  );

  const initiator = await Link.initiate(initiatorDest, transportI);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const responder = [...transportR.links.values()][0];
    if (
      initiator.status === LinkStatus.ACTIVE &&
      responder &&
      responder.status === LinkStatus.ACTIVE
    ) {
      return { initiator, responder, tInit: transportI, tResp: transportR };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

/**
 * Runs a full sender→receiver transfer and asserts the reassembled data.
 * @param {object} opts
 * @param {number} opts.size
 * @param {boolean} [opts.compress]
 */
async function runTransfer({ size, compress = false }) {
  const { initiator, responder } = await makePair();

  /** @type {any} */
  let bz2;
  if (compress) {
    bz2 = {
      // Toy RLE that only round-trips for buffers of identical bytes.
      compress: (/** @type {Uint8Array} */ data) =>
        new Uint8Array([
          data[0],
          data.length & 0xff,
          (data.length >> 8) & 0xff,
        ]),
      decompress: (/** @type {Uint8Array} */ compressed) => {
        const len = compressed[1] | (compressed[2] << 8);
        return new Uint8Array(len).fill(compressed[0]);
      },
    };
    responder.bz2 = bz2;
  }

  const payload = new Uint8Array(size).fill(size & 0xff || 7);
  const resource = new Resource({ data: payload, link: initiator, bz2 });
  await resource.advertise();
  assert.strictEqual(resource.status, ResourceStatus.ADVERTISED);

  /** @type {Resource|null} */
  let incoming = null;
  responder.addEventListener("resource", (event) => {
    incoming = /** @type {CustomEvent} */ (event).detail.resource;
  });

  await Promise.all([
    resource.whenComplete(),
    new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (incoming && incoming.status === ResourceStatus.COMPLETE) {
          clearInterval(poll);
          resolve(incoming);
        } else if (
          incoming &&
          (incoming.status === ResourceStatus.FAILED ||
            incoming.status === ResourceStatus.CORRUPT ||
            incoming.status === ResourceStatus.REJECTED)
        ) {
          clearInterval(poll);
          reject(new Error(`incoming failed: ${incoming.status}`));
        }
      }, 5);
      setTimeout(() => {
        clearInterval(poll);
        reject(new Error("transfer timed out"));
      }, 5000);
    }),
  ]);

  assert.ok(incoming, "responder must have accepted an incoming resource");
  assert.strictEqual(incoming.status, ResourceStatus.COMPLETE);
  assert.deepStrictEqual(
    Array.from(/** @type {Uint8Array} */ (incoming.data)),
    Array.from(payload),
  );
}

describe("Resource sizing (§10.2/§10.4)", () => {
  test("SDU = mtu - HEADER_MAXSIZE(35) - IFAC_MIN_SIZE(1) = 464 at mtu 500", async () => {
    const { initiator } = await makePair();
    const r = new Resource({ data: new Uint8Array(1), link: initiator });
    assert.strictEqual(r.sdu, 464);
    assert.strictEqual(r.hashmapMaxLen, 74);
  });

  test("sender slices into ceil(size/SDU) parts and builds a hashmap", async () => {
    const { initiator } = await makePair();
    const data = new Uint8Array(1000).fill(0x42);
    const r = new Resource({ data, link: initiator, autoCompress: false });
    await r.advertise();
    assert.strictEqual(r.totalParts, Math.ceil(r.totalSize / r.sdu));
    assert.strictEqual(r.hashmap.length, r.totalParts);
    assert.ok(r.hashmap.every((mh) => mh.length === 4));
    // integrity material over the uncompressed plaintext + salt
    const expectedHash = await Identity.fullHash(
      new Uint8Array([...data, .../** @type {Uint8Array} */ (r.randomHash)]),
    );
    assert.deepStrictEqual(Array.from(r.hash), Array.from(expectedHash));
  });

  test("hashmap collision guard regenerates the salt rather than emitting duplicates", async () => {
    // Two identical parts would collide on map_hash unless the salt rotates.
    const { initiator } = await makePair();
    const data = new Uint8Array(2000).fill(0x55); // > 1 part, all identical
    const r = new Resource({ data, link: initiator, autoCompress: false });
    await r.advertise();
    const seen = new Set(r.hashmap.map((h) => toHex(h)));
    assert.strictEqual(
      seen.size,
      r.hashmap.length,
      "map_hashes must be unique",
    );
  });
});

describe("Resource end-to-end transfer (§10)", () => {
  test("tiny payload (single part, < HASHMAP_MAX_LEN)", async () => {
    await runTransfer({ size: 100 });
  });

  test("medium payload (several parts, still < HASHMAP_MAX_LEN)", async () => {
    await runTransfer({ size: 5000 });
  });

  test("large payload (> HASHMAP_MAX_LEN parts, exercises RESOURCE_HMU)", async () => {
    // 50KB / SDU(464) ≈ 108 parts > 74 -> receiver must pull a hashmap update.
    await runTransfer({ size: 50_000 });
  });

  test("transfers with injected bz2 compression round-trip", async () => {
    await runTransfer({ size: 2000, compress: true });
  });

  test("parts are placed by map_hash index, not arrival order", async () => {
    // Build a sender in-process (no wire traffic) and a mirror receiver, then
    // deliver parts in REVERSE. Placement is by map_hash index lookup, so the
    // reassembled buffer must still be byte-correct regardless of order.
    const { initiator, responder } = await makePair();
    const payload = new Uint8Array(2000).fill(0x33);
    const sender = new Resource({
      data: payload,
      link: initiator,
      autoCompress: false,
    });
    await sender._prepareSender();

    const incoming = new Resource({ link: responder });
    incoming.status = ResourceStatus.TRANSFERRING;
    incoming.totalSize = sender.totalSize;
    incoming.uncompressedSize = sender.uncompressedSize;
    incoming.totalParts = sender.totalParts;
    incoming.hash = sender.hash;
    incoming.randomHash = sender.randomHash;
    incoming.parts = new Array(sender.totalParts).fill(null);
    incoming.hashmap = sender.hashmap.slice();
    incoming.receivedCount = 0;
    incoming.compressed = false;
    incoming.outstanding = sender.totalParts; // suppress auto requestNext

    for (let i = sender.totalParts - 1; i >= 0; i--) {
      await incoming.receivePart(/** @type {Uint8Array} */ (sender.parts[i]));
    }
    assert.strictEqual(incoming.status, ResourceStatus.COMPLETE);
    assert.deepStrictEqual(
      Array.from(/** @type {Uint8Array} */ (incoming.data)),
      Array.from(payload),
    );
  });
});

describe("Resource advertisement rejection (§10.9)", () => {
  test("an oversized advertisement is rejected and no transfer starts", async () => {
    const { initiator, responder } = await makePair();
    responder.maxResourceSize = 1000;

    const payload = new Uint8Array(5000).fill(0x99);
    const sender = new Resource({ data: payload, link: initiator });
    await sender.advertise();

    await assert.rejects(
      () =>
        Promise.race([
          sender.whenComplete(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 3000),
          ),
        ]),
      /rejected|failed/i,
      "sender should observe the rejection",
    );
    assert.strictEqual(responder.incomingResources.size, 0);
  });
});

describe("Resource progress + API", () => {
  test("getProgress reports 0..1 as parts arrive", async () => {
    const { initiator } = await makePair();
    const r = new Resource({ data: new Uint8Array(2000), link: initiator });
    r.totalParts = 4;
    r.receivedCount = 0;
    assert.strictEqual(r.getProgress(), 0);
    r.receivedCount = 2;
    assert.strictEqual(r.getProgress(), 0.5);
    r.receivedCount = 4;
    assert.strictEqual(r.getProgress(), 1);
  });

  test("advertisement packet has context RESOURCE_ADV and contextFlag false", async () => {
    const { initiator, tInit } = await makePair();
    tInit.receivedPackets.length = 0;

    const r = new Resource({ data: new Uint8Array(100), link: initiator });
    await r.advertise();
    // Give the deferred send a tick to append to receivedPackets.
    await new Promise((res) => setTimeout(res, 20));
    const adv = tInit.receivedPackets.find(
      (p) => p.contextByte === ContextType.RESOURCE_ADV,
    );
    assert.ok(adv, "must emit a RESOURCE_ADV");
    assert.strictEqual(
      adv.contextFlag,
      false,
      "contextFlag must be false (§2.1)",
    );
    assert.strictEqual(adv.packetType, PacketType.DATA);
    assert.strictEqual(adv.destinationType, DestType.LINK);
  });
});
