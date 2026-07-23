/**
 * Inbound packet-hash dedup ring (Transport.packet_hashlist / packet_filter),
 * a Python-reference behaviour ported for work doc #16.
 *
 * A leaf drops a non-announce packet whose hash it has already seen, except for
 * contexts that legitimately recur or carry their own sequencing. Announces
 * are exempt (their replay protection is the RoutingTable random_blob check).
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { TransportCore } from "../../src/transport/transport.js";
import { toHex } from "../../src/utils/encoding.js";

/**
 * @param {Uint8Array} destinationHash
 * @param {Uint8Array} [payload]
 */
function dataPacket(destinationHash, payload = new Uint8Array([1, 2, 3])) {
  return new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: destinationHash,
    contextByte: ContextType.NONE,
    payload,
  });
}

/** Minimal local-destination stub that counts receives. */
function countingDest() {
  let receives = 0;
  return {
    receive: async () => {
      receives++;
    },
    get count() {
      return receives;
    },
  };
}

describe("TransportCore — inbound packet-hash dedup", () => {
  test("a duplicate DATA packet is dropped (delivered once)", async () => {
    const transport = new TransportCore();
    const destHash = crypto.getRandomValues(new Uint8Array(16));
    const dest = countingDest();
    transport.localDestinations.set(toHex(destHash), dest);

    await transport._routeIncomingPacket(dataPacket(destHash), null);
    await transport._routeIncomingPacket(dataPacket(destHash), null);

    assert.strictEqual(dest.count, 1, "duplicate dropped, delivered once");
    assert.strictEqual(transport.packetHashlist.size, 1, "hash remembered");
  });

  test("bypass contexts (CHANNEL) are not dedup'd", async () => {
    const transport = new TransportCore();
    const destHash = crypto.getRandomValues(new Uint8Array(16));
    const dest = countingDest();
    transport.localDestinations.set(toHex(destHash), dest);

    const mk = () =>
      new Packet({
        packetType: PacketType.DATA,
        destinationType: DestType.SINGLE,
        destinationHash: destHash,
        contextByte: ContextType.CHANNEL,
        payload: new Uint8Array([1]),
      });
    await transport._routeIncomingPacket(mk(), null);
    await transport._routeIncomingPacket(mk(), null);

    assert.strictEqual(dest.count, 2, "CHANNEL packets bypass the hashlist");
  });

  test("distinct packets are both delivered", async () => {
    const transport = new TransportCore();
    const destHash = crypto.getRandomValues(new Uint8Array(16));
    const dest = countingDest();
    transport.localDestinations.set(toHex(destHash), dest);

    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([1])),
      null,
    );
    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([2])),
      null,
    );

    assert.strictEqual(dest.count, 2);
  });

  test("the ring rotates (prev ← current) once it exceeds maxsize/2", async () => {
    const transport = new TransportCore();
    transport.hashlistMaxsize = 4;
    const destHash = crypto.getRandomValues(new Uint8Array(16));
    transport.localDestinations.set(toHex(destHash), countingDest());

    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([1])),
      null,
    );
    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([2])),
      null,
    );
    assert.strictEqual(transport.packetHashlist.size, 2);
    assert.strictEqual(transport.packetHashlistPrev.size, 0);

    // A 3rd distinct hash: size(3) > 4/2 ⇒ rotate.
    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([3])),
      null,
    );
    assert.strictEqual(transport.packetHashlist.size, 0, "current cleared");
    assert.strictEqual(
      transport.packetHashlistPrev.size,
      3,
      "previous generation retained",
    );
  });

  test("a hash rotated into the prev set still counts as a duplicate", async () => {
    const transport = new TransportCore();
    transport.hashlistMaxsize = 4;
    const destHash = crypto.getRandomValues(new Uint8Array(16));
    const dest = countingDest();
    transport.localDestinations.set(toHex(destHash), dest);

    // Fill enough distinct packets to force a rotation, then resend the 1st.
    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([1])),
      null,
    );
    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([2])),
      null,
    );
    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([3])),
      null,
    );
    assert.strictEqual(transport.packetHashlistPrev.size, 3);

    // [1] now lives only in prev — it must still be dropped.
    await transport._routeIncomingPacket(
      dataPacket(destHash, new Uint8Array([1])),
      null,
    );
    assert.strictEqual(dest.count, 3, "the prev-set duplicate was dropped");
  });
});
