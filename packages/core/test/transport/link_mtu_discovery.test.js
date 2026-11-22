/**
 * Link MTU discovery parity (RNS LINK_MTU_DISCOVERY).
 *
 * Python's link MTU discovery: the initiator asks
 * `Transport.next_hop_interface_hw_mtu(dest)` for the path-egress interface's
 * hardware MTU and signals it in the LINKREQUEST; the responder adopts it
 * (`validate_request`), echoes it in the LRPROOF (`prove`), and the initiator
 * confirms it into `link.mtu` (`validate_proof`). With discovery unavailable
 * the initiator signals the protocol MTU (500).
 *
 * The JS wire protocol always supported all three legs; these tests pin the
 * initiator-side discovery proposal (`TransportCore.LINK_MTU_DISCOVERY` +
 * `TransportCore.nextHopHwMtu`) and the end-to-end upgrade.
 *
 * @module test/transport/link_mtu_discovery
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType, PacketType } from "../../src/core/packet.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { TransportCore } from "../../src/transport/transport.js";
import { toHex } from "../../src/utils/encoding.js";

/**
 * Mock transport that doubles as a tiny router, mirroring the one from
 * link_spec.test.js, plus an optional `nextHopHwMtu` for discovery.
 */
class MockTransport {
  constructor({ hwMtu = null } = {}) {
    /** @type {PacketType extends never ? never : any[]} */
    this.receivedPackets = [];
    /** @type {Map<string, any>} */
    this.links = new Map();
    /** @type {Map<string, any>} */
    this.destinations = new Map();
    this.peer = null;
    if (hwMtu != null) this.nextHopHwMtu = () => hwMtu;
  }
  /** @param {Uint8Array} hash @param {any} link */
  addLink(hash, link) {
    this.links.set(toHex(hash), link);
  }
  /** @param {Uint8Array} hash */
  removeLink(hash) {
    this.links.delete(toHex(hash));
  }
  /** @param {Uint8Array} hash @param {any} dest */
  addDestination(hash, dest) {
    this.destinations.set(toHex(hash), dest);
  }
  /** @param {any} packet */
  async sendPacket(packet) {
    this.receivedPackets.push(packet);
    if (this.peer) await this.peer._route(packet);
    return true;
  }
  /**
   * Local dispatch: link table first, then destinations (accepting LINKREQUESTs).
   * @param {any} packet
   */
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
 * Decodes the 3-byte MTU/mode signalling trailer from a LINKREQUEST-shaped
 * payload (initiator keys at [0:64], signalling at [64:67]).
 * @param {any} packet
 * @returns {{ mtu: number, mode: number }}
 */
function signallingFromLr(packet) {
  const s = packet.payload;
  return {
    mtu: (((s[64] << 16) + (s[65] << 8) + s[66]) & 0x1fffff) >>> 0,
    mode: (s[64] & 0xe0) >> 5,
  };
}

/**
 * Wires two mock transports back-to-back and completes a full handshake.
 * @param {Object} [options]
 * @param {number|null} [options.hwMtu] - Value the initiator transport's
 *   nextHopHwMtu reports (null = method absent).
 * @returns {Promise<{ initiator: any, responder: any, lrPacket: any }>}
 */
async function makePair({ hwMtu } = {}) {
  const responderIdentity = await Identity.generate();
  const transportI = new MockTransport({ hwMtu });
  const transportR = new MockTransport();
  transportI.peer = transportR;
  transportR.peer = transportI;

  const responderDest = await Destination.create(
    "mtu-peer",
    Direction.IN,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: transportR }),
  );
  transportR.addDestination(responderDest.destinationHash, responderDest);
  const initiatorDest = await Destination.create(
    "mtu-peer",
    Direction.OUT,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: transportI }),
  );

  const initiator = await Link.initiate(initiatorDest, transportI);
  for (let i = 0; i < 100; i++) {
    if (initiator.status === LinkStatus.ACTIVE) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const responder = [...transportR.links.values()][0];
  return {
    initiator,
    responder,
    lrPacket: transportI.receivedPackets.find(
      (p) => p.packetType === PacketType.LINKREQUEST,
    ),
  };
}

test("the initiator signals the next hop's hardware MTU and both ends upgrade", async () => {
  const { initiator, responder, lrPacket } = await makePair({ hwMtu: 16384 });

  // The LINKREQUEST proposes the discovered MTU (and the AES-256 mode).
  const signalled = signallingFromLr(lrPacket);
  assert.strictEqual(signalled.mtu, 16384);
  assert.strictEqual(signalled.mode, Link.MODE_AES256_CBC);

  // Responder adopted the proposal; initiator confirmed it from the LRPROOF.
  assert.ok(responder, "responder link established");
  assert.strictEqual(responder.mtu, 16384);
  assert.strictEqual(initiator.mtu, 16384);
  assert.strictEqual(initiator.status, LinkStatus.ACTIVE);
});

test("an unknown next-hop MTU signals the protocol MTU (500)", async () => {
  const { initiator, responder, lrPacket } = await makePair({});
  assert.strictEqual(signallingFromLr(lrPacket).mtu, 500);
  assert.strictEqual(initiator.mtu, 500);
  assert.ok(responder, "responder link established");
  assert.strictEqual(responder.mtu, 500);
});

test("discovery disabled signals the protocol MTU even when the path has an MTU", async () => {
  const original = TransportCore.LINK_MTU_DISCOVERY;
  TransportCore.LINK_MTU_DISCOVERY = false;
  try {
    const { initiator, responder, lrPacket } = await makePair({
      hwMtu: 16384,
    });
    assert.strictEqual(signallingFromLr(lrPacket).mtu, 500);
    assert.strictEqual(initiator.mtu, 500);
    assert.ok(responder, "responder link established");
    assert.strictEqual(responder.mtu, 500);
  } finally {
    TransportCore.LINK_MTU_DISCOVERY = original;
  }
});

test("TransportCore.nextHopHwMtu reads the route egress interface", () => {
  const transport = new TransportCore();
  const dest = new Uint8Array(16).fill(0xab);

  // No route → null.
  assert.strictEqual(transport.nextHopHwMtu(dest), null);

  // Route through an interface without a usable hwMtu → null. Each update
  // carries a fresh random blob: a repeated blob is a replay and the routing
  // table correctly rejects it, keeping the older interface.
  transport.routingTable.addOrUpdateRoute(dest, {
    nextHop: dest,
    hops: 1,
    viaInterface: { name: "plain", bitrate: 62500 },
    randomBlob: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  });
  assert.strictEqual(transport.nextHopHwMtu(dest), null);

  transport.routingTable.addOrUpdateRoute(dest, {
    nextHop: dest,
    hops: 1,
    viaInterface: { name: "fast", bitrate: 10_000_000, hwMtu: 16384 },
    randomBlob: new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
  });
  assert.strictEqual(transport.nextHopHwMtu(dest), 16384);
});
