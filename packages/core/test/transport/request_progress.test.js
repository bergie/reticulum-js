/**
 * Transfer progress tests for Resource-backed REQUEST/RESPONSE (§10 + §11).
 *
 * `Link.request()` accepts an `onProgress` callback that receives
 * `{ direction, loaded, total, segmentIndex, segmentTotal }` while the
 * oversized request and/or response body transfers as Resource(s) —
 * per-segment positions for split transfers, since segments transfer
 * strictly one at a time.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Allow, Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";
import { Resource } from "../../src/core/resource.js";
import {
  Link,
  LinkStatus,
  ResourceResponse,
} from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";

class LoopbackTransport {
  constructor() {
    /** @type {Map<string, Link>} */
    this.links = new Map();
    /** @type {Map<string, Destination>} */
    this.destinations = new Map();
    this.sent = [];
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
  /** @param {import("../../src/core/packet.js").Packet} packet */
  async sendPacket(packet) {
    this.sent.push(packet);
    if (this.peer) {
      const peer = this.peer;
      Promise.resolve()
        .then(() => peer._route(packet))
        .catch((err) =>
          console.error("route error:", String(err).slice(0, 120)),
        );
    }
    return true;
  }
  /** @param {import("../../src/core/packet.js").Packet} packet */
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
 * @returns {Promise<{ initiator: Link, responderDest: Destination }>}
 */
async function makeEstablishedPair() {
  const responderIdentity = await Identity.generate();
  const tI = new LoopbackTransport();
  const tR = new LoopbackTransport();
  tI.peer = tR;
  tR.peer = tI;

  const responderDest = await Destination.create(
    "responder",
    Direction.IN,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: tR }),
  );
  tR.addDestination(responderDest.destinationHash, responderDest);

  const initiatorDest = await Destination.create(
    "responder",
    Direction.OUT,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: tI }),
  );

  const initiator = await Link.initiate(initiatorDest, tI);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const responder = [...tR.links.values()][0];
    if (
      initiator.status === LinkStatus.ACTIVE &&
      responder &&
      responder.status === LinkStatus.ACTIVE
    ) {
      return { initiator, responderDest };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

/** Deterministic pseudo-random payload. @param {number} size */
function payload(size) {
  const out = new Uint8Array(size);
  let state = 0x1234abcd;
  for (let i = 0; i < size; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

describe("Request/response transfer progress", () => {
  test("response progress reports byte positions", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();
    const data = payload(4000); // multi-part single-segment resource
    await responderDest.registerRequestHandler("/prog/download", {
      allow: Allow.ALL,
      responseGenerator: async () => data,
    });

    /** @type {any[]} */
    const events = [];
    const response = await initiator.request("/prog/download", null, {
      timeout: 20000,
      onProgress: (info) => events.push(info),
    });
    assert.ok(response instanceof Uint8Array);

    assert.ok(events.length > 1, "progress events arrived");
    for (const e of events) {
      assert.equal(e.direction, "response");
      assert.equal(e.segmentIndex, 1);
      assert.equal(e.segmentTotal, 1);
      assert.ok(e.loaded >= 0 && e.loaded <= e.total);
    }
    // Monotonic within rounding.
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].loaded >= events[i - 1].loaded);
    }
    // The total is the envelope's logical (uncompressed) size — the msgpack
    // wrapper adds a little overhead over the raw payload. The last event
    // is complete.
    assert.ok(events[0].total >= data.length);
    assert.equal(
      events[events.length - 1].loaded,
      events[events.length - 1].total,
    );
  });

  test("request progress reports the upload direction", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();
    await responderDest.registerRequestHandler("/prog/upload", {
      allow: Allow.ALL,
      responseGenerator: async () => "ok",
    });

    /** @type {any[]} */
    const events = [];
    const response = await initiator.request("/prog/upload", payload(4000), {
      timeout: 20000,
      onProgress: (info) => events.push(info),
    });
    assert.strictEqual(response, "ok");

    const upload = events.filter((e) => e.direction === "request");
    assert.ok(upload.length > 1, "upload progress events arrived");
    // No download events: the response fits a single packet.
    assert.equal(events.length, upload.length);
    // The msgpack envelope is slightly larger than the raw payload.
    assert.ok(upload[0].total >= 4000);
    assert.equal(
      upload[upload.length - 1].loaded,
      upload[upload.length - 1].total,
    );
  });

  test("split responses report per-segment positions", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();
    const data = payload(2 * Resource.MAX_EFFICIENT_SIZE + 300 * 1024);
    await responderDest.registerRequestHandler("/prog/split", {
      allow: Allow.ALL,
      responseGenerator: async () =>
        new ResourceResponse(data, new Map([[1, 0]])),
    });

    /** @type {any[]} */
    const events = [];
    const response = await initiator.request("/prog/split", null, {
      timeout: 30000,
      onProgress: (info) => events.push(info),
    });
    assert.strictEqual(response.length, data.length);

    // All three segments reported, in order.
    const segmentIndices = [...new Set(events.map((e) => e.segmentIndex))];
    assert.deepEqual(segmentIndices, [1, 2, 3]);
    assert.equal(events[0].segmentTotal, 3);
    // First two segments are full segments; the last is the remainder. The
    // metadata prefix travels inside segment 1, so the last segment carries
    // the data remainder plus any prefix overshoot.
    assert.equal(events[0].total, Resource.MAX_EFFICIENT_SIZE);
    const lastTotal = events[events.length - 1].total;
    assert.ok(
      lastTotal >= data.length - 2 * Resource.MAX_EFFICIENT_SIZE &&
        lastTotal <= data.length - 2 * Resource.MAX_EFFICIENT_SIZE + 10,
    );
    // Each segment reaches completion.
    for (const idx of [1, 2, 3]) {
      const ofSegment = events.filter((e) => e.segmentIndex === idx);
      assert.equal(
        ofSegment[ofSegment.length - 1].loaded,
        ofSegment[ofSegment.length - 1].total,
        `segment ${idx} completed`,
      );
    }
  });
});
