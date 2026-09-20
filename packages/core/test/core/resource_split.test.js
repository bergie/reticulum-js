/**
 * Multi-segment Resource tests (PROTOCOL-SPEC.md §10.3).
 *
 * Payloads over MAX_EFFICIENT_SIZE transfer as sequentially-advertised
 * segments: the sender advertises segment N+1 only after segment N's proof,
 * all segments share the first segment's hash (`o`), and the receiver
 * reassembles them before routing the transfer to the §11 machinery or the
 * `resource` event.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Allow, Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";
import {
  Resource,
  ResourceStatus,
  SplitResourceAssembler,
} from "../../src/core/resource.js";
import {
  Link,
  LinkStatus,
  ResourceResponse,
} from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";

class LoopbackTransport {
  /**
   * @param {{ all: { packet: any, dir: string }[] }} log - Shared send log
   *   across both transports, for cross-direction ordering assertions.
   */
  constructor(log) {
    this.log = log;
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
  /** @param {import("../../src/core/packet.js").Packet} packet */
  async sendPacket(packet) {
    this.log.all.push({ packet, dir: this.dir });
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
 * @returns {Promise<{ initiator: Link, responder: Link, responderDest: Destination, all: { packet: any, dir: string }[] }>}
 */
async function makePair() {
  const log = { all: [] };
  const tI = new LoopbackTransport(log);
  const tR = new LoopbackTransport(log);
  tI.dir = "i→r";
  tR.dir = "r→i";
  tI.peer = tR;
  tR.peer = tI;

  const responderIdentity = await Identity.generate();
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
      return { initiator, responder, responderDest, all: log.all };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

const MAX = Resource.MAX_EFFICIENT_SIZE;

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

/** Awaits the receiver-side assembled `resource` event. @param {Link} responder */
function awaitResource(responder) {
  return new Promise((resolve) => {
    const listener = (/** @type {any} */ event) => {
      responder.removeEventListener("resource", listener);
      resolve(event.detail.resource);
    };
    responder.addEventListener("resource", listener);
  });
}

describe("Multi-segment Resources (§10.3)", () => {
  test("splits at MAX_EFFICIENT_SIZE with reference-matching boundaries", async () => {
    const { initiator, responder } = await makePair();

    // total = MAX + 1 → exactly 2 segments; segment 2 carries a single byte.
    const data = payload(MAX + 1);
    const resource = new Resource({ data, link: initiator });
    await resource.advertise();
    assert.strictEqual(resource.split, true);
    assert.strictEqual(resource.totalSegments, 2);
    assert.strictEqual(resource.segmentIndex, 1);
    assert.ok(resource.originalHash);

    const incoming = await awaitResource(responder);
    assert.strictEqual(incoming.status, ResourceStatus.COMPLETE);
    assert.strictEqual(incoming.totalSegments, 2);
    assert.deepStrictEqual(
      Array.from(/** @type {Resource} */ (incoming).data),
      Array.from(data),
    );
  });

  test("a MAX_EFFICIENT_SIZE payload stays a single segment", async () => {
    const { initiator } = await makePair();
    const resource = new Resource({
      data: payload(Resource.MAX_EFFICIENT_SIZE),
      link: initiator,
    });
    await resource.advertise();
    assert.strictEqual(resource.split, false);
    assert.strictEqual(resource.totalSegments, 1);
  });

  test("multi-segment REQUEST round-trips through the §11 machinery", async () => {
    const { initiator, responderDest } = await makePair();

    /** @type {any} */
    let received = null;
    await responderDest.registerRequestHandler("/split/echo", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data) => {
        received = data;
        return "ok";
      },
    });

    // A request body well over one segment (3 segments).
    const big = payload(2 * MAX + 512 * 1024);
    const response = await initiator.request("/split/echo", big, {
      timeout: 30000,
    });
    assert.strictEqual(response, "ok");
    assert.ok(received instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(received), Array.from(big));
  });

  test("multi-segment RESPONSE with metadata reassembles for the requester", async () => {
    const { initiator, responderDest } = await makePair();
    const data = payload(2 * MAX + 300 * 1024); // 3 segments
    const metadata = new Map([[1, 0]]);
    await responderDest.registerRequestHandler("/split/fetch", {
      allow: Allow.ALL,
      responseGenerator: async () => new ResourceResponse(data, metadata),
    });

    /** @type {any} */
    let gotMetadata;
    const response = await initiator.request("/split/fetch", null, {
      timeout: 30000,
      onMetadata: (md) => {
        gotMetadata = md;
      },
    });
    assert.ok(response instanceof Uint8Array);
    assert.strictEqual(response.length, data.length);
    assert.deepStrictEqual(Array.from(response), Array.from(data));
    assert.strictEqual(gotMetadata[1], 0);
  });

  test("segments transfer strictly one at a time", async () => {
    const { initiator, responder, all } = await makePair();
    const resource = new Resource({
      data: payload(MAX + 1024),
      link: initiator,
    });
    const assembled = awaitResource(responder);
    await resource.advertise();
    await resource.whenComplete();
    await assembled;

    const advSeq = all
      .map((e, i) => ({ ...e, i }))
      .filter(
        (e) =>
          e.packet.contextByte === ContextType.RESOURCE_ADV && e.dir === "i→r",
      );
    const prfSeq = all
      .map((e, i) => ({ ...e, i }))
      .filter(
        (e) =>
          e.packet.contextByte === ContextType.RESOURCE_PRF && e.dir === "r→i",
      );
    assert.strictEqual(advSeq.length, 2, "one advertisement per segment");
    assert.ok(prfSeq.length >= 2, "one proof per segment");
    // Segment 2 is only advertised after segment 1 has been proven.
    assert.ok(prfSeq[0].i < advSeq[1].i);
  });

  test("SplitResourceAssembler enforces its total-size cap", async () => {
    const { responder } = await makePair();
    const segment = new Resource({ link: responder });
    segment.segmentIndex = 1;
    segment.totalSegments = 2;
    segment.originalHash = new Uint8Array(32).fill(1);
    segment.data = new Uint8Array(1000);
    segment.status = ResourceStatus.COMPLETE;

    const assembler = new SplitResourceAssembler(segment, {
      maxTotalSize: 1500,
    });
    // First segment fits; the second crosses the cap.
    assert.strictEqual(assembler.add(segment), null);
    const second = new Resource({ link: responder });
    second.segmentIndex = 2;
    second.data = new Uint8Array(1000);
    second.status = ResourceStatus.COMPLETE;
    assert.throws(() => assembler.add(second), /maximum total size/);
  });

  test("a torn-down link rejects the awaiting request", async () => {
    const { initiator, responder, responderDest, all } = await makePair();
    // 3 segments: the teardown lands between segment advertisements, where
    // the transfer can never have completed yet regardless of engine speed.
    const data = payload(2 * MAX + 512 * 1024);
    await responderDest.registerRequestHandler("/split/fetch", {
      allow: Allow.ALL,
      responseGenerator: async () =>
        new ResourceResponse(data, new Map([[1, 0]])),
    });

    const responsePromise = initiator.request("/split/fetch", null, {
      timeout: 30000,
    });
    // Wait for the second segment advertisement (i→r direction), then
    // tear the link down mid-transfer.
    // The response segments are advertised responder→initiator; wait for
    // the second segment advertisement, which lands mid-transfer by
    // construction (segment N+1 is only advertised after N's proof).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const advCount = all.filter(
        (e) =>
          e.dir === "r→i" && e.packet.contextByte === ContextType.RESOURCE_ADV,
      ).length;
      if (advCount >= 2) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await responder.teardown();
    await assert.rejects(responsePromise);
  });
});
