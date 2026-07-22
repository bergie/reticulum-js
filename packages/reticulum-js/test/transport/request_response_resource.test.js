/**
 * Resource-backed REQUEST/RESPONSE tests (PROTOCOL-SPEC.md §11.1 / §11.2).
 *
 * Exercises the §10↔§11 integration: when a REQUEST or RESPONSE exceeds the
 * Link MDU it is transferred as a Resource (adv flags `u`/`p`, `q=requestId`),
 * and the receiver re-feeds the assembled bytes through the §11 machinery.
 *
 * Uses a deferred-delivery loopback transport to avoid rxQueue re-entrancy
 * (the same reason a real network avoids it via latency).
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Allow, Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
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
 * @returns {Promise<{ initiator: Link, responder: Link, responderDest: Destination, tI: LoopbackTransport }>}
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
      return { initiator, responder, responderDest, tI };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

describe("Resource-backed REQUEST/RESPONSE (§11.1/§11.2)", () => {
  test("a RESPONSE larger than the MDU transfers via a Resource", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();

    // Server returns a body well over the 431-byte MDU.
    const big = new Uint8Array(4000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    await responderDest.registerRequestHandler("/page/big.mu", {
      allow: Allow.ALL,
      responseGenerator: async () => big,
    });

    const response = await initiator.request("/page/big.mu", null, {
      timeout: 20000,
    });
    assert.ok(
      response instanceof Uint8Array,
      "response must decode back to bytes",
    );
    assert.strictEqual(response.length, big.length);
    assert.deepStrictEqual(Array.from(response), Array.from(big));
  });

  test("a REQUEST larger than the MDU transfers via a Resource", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();

    /** @type {any} */
    let receivedData = null;
    await responderDest.registerRequestHandler("/page/echo.mu", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data) => {
        receivedData = data;
        return "ok";
      },
    });

    // A large `data` blob pushes the packed envelope over the MDU.
    const bigPayload = new Uint8Array(2000);
    for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = (i * 7) & 0xff;
    const response = await initiator.request("/page/echo.mu", bigPayload, {
      timeout: 20000,
    });
    assert.strictEqual(response, "ok");
    assert.ok(receivedData instanceof Uint8Array, "server received the bytes");
    assert.deepStrictEqual(Array.from(receivedData), Array.from(bigPayload));
  });

  test("both REQUEST and RESPONSE can be Resource-backed in one round trip", async () => {
    const { initiator, responderDest } = await makeEstablishedPair();
    const reqBytes = new Uint8Array(1500).fill(0xa1);
    const respBytes = new Uint8Array(3500).fill(0xb2);

    await responderDest.registerRequestHandler("/page/huge.mu", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data) => {
        // echo-back: prove the large REQUEST body arrived intact, return large.
        assert.deepStrictEqual(Array.from(data), Array.from(reqBytes));
        return respBytes;
      },
    });

    const response = await initiator.request("/page/huge.mu", reqBytes, {
      timeout: 20000,
    });
    assert.ok(response instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(response), Array.from(respBytes));
  });

  test("a small round trip still uses single packets after the wiring", async () => {
    const { initiator, responderDest, tI } = await makeEstablishedPair();
    await responderDest.registerRequestHandler("/page/small.mu", {
      allow: Allow.ALL,
      responseGenerator: async () => "tiny",
    });

    tI.sent.length = 0;
    const response = await initiator.request("/page/small.mu");
    assert.strictEqual(response, "tiny");
    // No Resource advertisement should have been emitted for a small round.
    const sawAdv = tI.sent.some(
      (p) => p.contextByte === ContextType.RESOURCE_ADV,
    );
    assert.strictEqual(sawAdv, false);
  });
});
