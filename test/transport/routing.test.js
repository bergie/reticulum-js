/**
 * End-to-end path routing through TransportCore (milestone A: a leaf that can
 * reach destinations multiple hops away behind other transport nodes).
 *
 * Covers:
 *   - a received ANNOUNCE populates the path table (hasPath / hopsTo / nextHop);
 *   - a direct (HEADER_1) announce ⇒ 1 hop, next hop = destination hash;
 *   - a transport-rebroadcast (HEADER_2) announce ⇒ N hops, next hop = transportId;
 *   - sendPacket to a >1-hop destination injects HEADER_2 + TRANSPORT + nextHop;
 *   - sendPacket to a 1-hop destination transmits the packet unchanged;
 *   - the logical (HEADER_1) packet hash/receipt are preserved across injection.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  HeaderType,
  Packet,
  PacketType,
  TransportType,
} from "../../src/core/packet.js";
import { TransportCore } from "../../src/transport/transport.js";
import { bytesEqual } from "../../src/utils/encoding.js";

/** Captures broadcast announce packets in place of a real interface layer. */
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

/** Builds a real announce (serialize → deserialize) as it would arrive on the wire. */
async function buildDirectAnnounce(appName) {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(appName, DestType.SINGLE, identity, layer);
  await dest.announce();
  const arriving = Packet.deserialize(layer.packets[0].serialize());
  return {
    packet: arriving,
    identity,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
  };
}

/**
 * Builds an announce as it would arrive after transiting one transport node:
 * the node rebroadcasts it as HEADER_2 with its own transport_id and hop count
 * already incremented to 1 (Transport.py inbound increments again on receive,
 * so the destination ends up 2 hops away).
 */
async function buildTransitedAnnounce(appName) {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(appName, DestType.SINGLE, identity, layer);
  await dest.announce();
  const direct = layer.packets[0];
  const transportId = crypto.getRandomValues(new Uint8Array(16));
  const rebroadcast = new Packet({
    headerType: HeaderType.HEADER_2,
    hops: 1,
    transportType: TransportType.TRANSPORT,
    destinationType: direct.destinationType,
    packetType: direct.packetType,
    contextFlag: direct.contextFlag,
    destinationHash: direct.destinationHash,
    contextByte: direct.contextByte,
    payload: direct.payload,
    transportId,
  });
  const arriving = Packet.deserialize(rebroadcast.serialize());
  return {
    packet: arriving,
    identity,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
    transportId,
  };
}

/** A minimal interface that records every packet written to its framer. */
function capturingInterface(name) {
  /** @type {Packet[]} */
  const written = [];
  const iface = Object.assign(new EventTarget(), {
    name,
    _packetWriter: {
      /** @param {Packet} pkt */
      write: async (pkt) => {
        written.push(pkt);
      },
    },
  });
  return { iface, written };
}

describe("TransportCore — announce populates the path table", () => {
  test("a transport-rebroadcast announce is learned as a multi-hop path", async () => {
    const transport = new TransportCore();
    const { iface } = capturingInterface("eth0");
    transport.addInterface(iface);

    const { packet, destinationHash, transportId } =
      await buildTransitedAnnounce("test.multihop.learn");

    await transport._routeIncomingPacket(packet, iface);

    assert.ok(transport.hasPath(destinationHash), "path should be known");
    assert.strictEqual(transport.hopsTo(destinationHash), 2);
    assert.ok(
      bytesEqual(transport.nextHop(destinationHash), transportId),
      "next hop should be the transport node id",
    );
  });

  test("a direct announce is learned as a 1-hop path via the destination itself", async () => {
    const transport = new TransportCore();
    const { iface } = capturingInterface("eth0");
    transport.addInterface(iface);

    const { packet, destinationHash } =
      await buildDirectAnnounce("test.direct.learn");

    await transport._routeIncomingPacket(packet, iface);

    assert.strictEqual(transport.hopsTo(destinationHash), 1);
    assert.ok(
      bytesEqual(transport.nextHop(destinationHash), destinationHash),
      "direct announce ⇒ next hop is the destination hash",
    );
  });
});

describe("TransportCore.sendPacket — transport header injection", () => {
  test(">1 hop: rewrites to HEADER_2 / TRANSPORT with the next hop as transportId", async () => {
    const transport = new TransportCore();
    const { iface, written } = capturingInterface("eth0");
    transport.addInterface(iface, true);
    const {
      packet: announce,
      destinationHash,
      transportId,
    } = await buildTransitedAnnounce("test.multihop.send");
    await transport._routeIncomingPacket(announce, iface);

    const data = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.SINGLE,
      destinationHash,
      contextByte: ContextType.NONE,
      payload: new Uint8Array([1, 2, 3]),
    });
    const logicalHash = await data.getHash();

    await transport.sendPacket(data);

    assert.strictEqual(written.length, 1);
    const sent = written[0];
    assert.strictEqual(sent.headerType, HeaderType.HEADER_2);
    assert.strictEqual(sent.transportType, TransportType.TRANSPORT);
    assert.ok(bytesEqual(sent.transportId, transportId));
    assert.ok(bytesEqual(sent.destinationHash, destinationHash));

    // The framer would emit the HEADER_2 flag (0x40) and TRANSPORT flag (0x10).
    const flags = sent.serialize()[0];
    assert.strictEqual(flags & 0x40, 0x40, "HEADER_2 flag set on the wire");
    assert.strictEqual(flags & 0x10, 0x10, "TRANSPORT flag set on the wire");

    // The original logical packet is untouched and its hash is preserved, so a
    // returning PROOF resolves against the HEADER_1 hash.
    assert.strictEqual(data.headerType, HeaderType.HEADER_1);
    assert.ok(bytesEqual(await data.getHash(), logicalHash));
  });

  test("1 hop: transmits the packet unchanged (HEADER_1) on the path interface", async () => {
    const transport = new TransportCore();
    const { iface, written } = capturingInterface("eth0");
    transport.addInterface(iface, true);
    const { packet: announce, destinationHash } =
      await buildDirectAnnounce("test.direct.send");
    await transport._routeIncomingPacket(announce, iface);

    const data = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.SINGLE,
      destinationHash,
      contextByte: ContextType.NONE,
      payload: new Uint8Array([9, 9]),
    });
    await transport.sendPacket(data);

    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0], data, "original packet transmitted as-is");
    assert.strictEqual(written[0].headerType, HeaderType.HEADER_1);
  });

  test("no known path: falls back to the default interface", async () => {
    const transport = new TransportCore();
    const { iface, written } = capturingInterface("eth0");
    transport.addInterface(iface, true);

    const data = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.SINGLE,
      destinationHash: crypto.getRandomValues(new Uint8Array(16)),
      contextByte: ContextType.NONE,
      payload: new Uint8Array([0]),
    });
    await transport.sendPacket(data);

    assert.strictEqual(written.length, 1);
  });
});

describe("TransportCore — path-query API", () => {
  test("hasPath / hopsTo / nextHop reflect the learned path", async () => {
    const transport = new TransportCore();
    const { iface } = capturingInterface("eth0");
    transport.addInterface(iface);
    const { packet, destinationHash, transportId } =
      await buildTransitedAnnounce("test.api");
    await transport._routeIncomingPacket(packet, iface);

    assert.ok(transport.hasPath(destinationHash));
    assert.strictEqual(transport.hopsTo(destinationHash), 2);
    assert.ok(bytesEqual(transport.nextHop(destinationHash), transportId));

    const unknown = crypto.getRandomValues(new Uint8Array(16));
    assert.strictEqual(transport.hasPath(unknown), false);
    assert.strictEqual(transport.hopsTo(unknown), null);
    assert.strictEqual(transport.nextHop(unknown), null);
  });
});
