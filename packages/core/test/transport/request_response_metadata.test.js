/**
 * File-with-metadata RESPONSE tests (§11.2 + §10.4 `x` flag).
 *
 * The reference implementation answers some requests with a file Resource
 * that carries separate response metadata: the raw payload rides the
 * Resource (no msgpack envelope), the request id travels in the
 * advertisement `q` field and the `x` flag announces a
 * `3-byte BE size ‖ msgpack(metadata)` prefix prepended to the
 * hashed/compressed/encrypted blob. rngit's `/git/fetch` uses this.
 *
 * The JS equivalents are `ResourceResponse` on the responder side and the
 * `onMetadata` option of `Link.request()` on the initiator side.
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
    /** @type {import("../../src/core/packet.js").Packet[]} */
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
 * @returns {Promise<{ initiator: Link, responder: Link, responderDest: Destination, tI: LoopbackTransport, tR: LoopbackTransport }>}
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
      return { initiator, responder, responderDest, tI, tR };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

// Wire-format fixture vector generated with the Python reference
// implementation's msgpack + struct packing:
//   metadata = {1: 0, "note": "rngit"}
//   prefix   = struct.pack(">I", len(packb(metadata)))[1:] + packb(metadata)
//   hex: 00000e 820100 a46e6f7465 a5726e6769 74
// Integer map keys need a `Map` on the wire (plain objects stringify keys).
const PYTHON_METADATA = new Map([
  [1, 0],
  ["note", "rngit"],
]);
const PYTHON_PREFIX_HEX = "00000e820100a46e6f7465a5726e676974";

/** Toy RLE bz2 stub that round-trips buffers of identical bytes. */
function toyBz2() {
  return {
    compress: (/** @type {Uint8Array} */ data) =>
      new Uint8Array([data[0], data.length & 0xff, (data.length >> 8) & 0xff]),
    decompress: (/** @type {Uint8Array} */ compressed) => {
      const len = compressed[1] | (compressed[2] << 8);
      return new Uint8Array(len).fill(compressed[0]);
    },
  };
}

describe("Resource metadata (§10.4 `x` flag)", () => {
  test("metadata prefix layout matches the reference wire format", () => {
    const resource = new Resource({
      data: new Uint8Array([0x50, 0x41, 0x43, 0x4b]), // "PACK"
      metadata: PYTHON_METADATA,
    });
    assert.strictEqual(resource.hasMetadata, true);
    assert.strictEqual(
      toHex(/** @type {Uint8Array} */ (resource.metadataPrefix)),
      PYTHON_PREFIX_HEX,
    );
  });

  test("small ResourceResponse delivers data plus metadata", async () => {
    const { initiator, responderDest, tR } = await makeEstablishedPair();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const metadata = new Map([[1, 0]]); // rngit IDX_RESULT_CODE = RES_OK
    await responderDest.registerRequestHandler("/git/fetch", {
      allow: Allow.ALL,
      responseGenerator: async () => new ResourceResponse(payload, metadata),
    });

    tR.sent.length = 0;
    /** @type {any[]} */
    const order = [];
    /** @type {any} */
    let gotMetadata;
    const response = await initiator.request("/git/fetch", null, {
      timeout: 20000,
      onMetadata: (md) => {
        order.push("metadata");
        gotMetadata = md;
      },
    });
    order.push("resolved");

    assert.ok(
      response instanceof Uint8Array,
      "metadata responses resolve with raw payload bytes",
    );
    assert.deepStrictEqual(Array.from(response), Array.from(payload));
    assert.strictEqual(gotMetadata[1], 0);
    assert.deepStrictEqual(order, ["metadata", "resolved"]);
    // File responses always ride the Resource pipeline, even when small.
    assert.ok(
      tR.sent.some((p) => p.contextByte === ContextType.RESOURCE_ADV),
      "expected a RESOURCE_ADV for the file response",
    );
  });

  test("large (multi-part) ResourceResponse delivers data plus metadata", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();
    const payload = new Uint8Array(6000);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const metadata = new Map([
      [1, 0],
      ["refs", 3],
    ]);
    await responderDest.registerRequestHandler("/git/fetch", {
      allow: Allow.ALL,
      responseGenerator: async () => new ResourceResponse(payload, metadata),
    });

    /** @type {any} */
    let gotMetadata;
    const response = await initiator.request("/git/fetch", null, {
      timeout: 20000,
      onMetadata: (md) => {
        gotMetadata = md;
      },
    });
    assert.ok(response instanceof Uint8Array);
    assert.strictEqual(response.length, payload.length);
    assert.deepStrictEqual(Array.from(response), Array.from(payload));
    assert.strictEqual(gotMetadata[1], 0);
    assert.strictEqual(gotMetadata.refs, 3);
  });

  test("compressed ResourceResponse keeps metadata separate from the payload", async () => {
    const { initiator, responder, responderDest } = await makeEstablishedPair();
    const bz2 = toyBz2();
    responder.bz2 = bz2;
    initiator.bz2 = bz2;

    const payload = new Uint8Array(500).fill(0x42);
    const metadata = new Map([[1, 0]]);
    await responderDest.registerRequestHandler("/git/fetch", {
      allow: Allow.ALL,
      responseGenerator: async () => new ResourceResponse(payload, metadata),
    });

    /** @type {any} */
    let gotMetadata;
    const response = await initiator.request("/git/fetch", null, {
      timeout: 20000,
      onMetadata: (md) => {
        gotMetadata = md;
      },
    });
    // The compressed transfer must reassemble to the exact original payload…
    assert.ok(response instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(response), Array.from(payload));
    // …with the metadata decoded from the (also compressed) prefix region.
    assert.strictEqual(gotMetadata[1], 0);
  });

  test("oversized envelope responses still work unchanged", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();
    const big = new Uint8Array(3000).fill(0x33);
    await responderDest.registerRequestHandler("/plain/big", {
      allow: Allow.ALL,
      responseGenerator: async () => big,
    });
    const response = await initiator.request("/plain/big", null, {
      timeout: 20000,
    });
    assert.ok(response instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(response), Array.from(big));
  });
});
