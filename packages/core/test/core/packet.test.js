import assert from "node:assert";
import {
  DestType,
  HeaderType,
  PATHFINDER_M,
  Packet,
  PacketType,
} from "../../src/core/packet.js";

async function testPacket() {
  console.log("Testing Packet...");

  // Test HEADER_1 DATA packet
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const destHash = new Uint8Array(16).fill(0xaa);
  const packet1 = new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 5,
    transportType: 0,
    destinationType: DestType.SINGLE,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: destHash,
    contextByte: 0,
    payload: payload,
  });

  const serialized1 = packet1.serialize();
  assert.strictEqual(serialized1.length, 2 + 16 + 1 + 4); // flags + hops + destHash + contextByte + payload
  assert.strictEqual(serialized1[0] & 0x0f, PacketType.DATA);
  assert.strictEqual(serialized1[1], 5);

  const deserialized1 = Packet.deserialize(serialized1);
  assert.strictEqual(deserialized1.headerType, HeaderType.HEADER_1);
  assert.strictEqual(deserialized1.hops, 5);
  assert.strictEqual(deserialized1.packetType, PacketType.DATA);
  assert.deepStrictEqual(deserialized1.destinationHash, destHash);
  assert.deepStrictEqual(deserialized1.payload, payload);

  // Test HEADER_2 ANNOUNCE packet
  const transportId = new Uint8Array(16).fill(0xbb);
  const packet2 = new Packet({
    headerType: HeaderType.HEADER_2,
    hops: 2,
    transportType: 1,
    destinationType: DestType.SINGLE,
    packetType: PacketType.ANNOUNCE,
    contextFlag: true,
    destinationHash: destHash,
    contextByte: 0x0b,
    payload: payload,
    transportId: transportId,
  });

  const serialized2 = packet2.serialize();
  assert.strictEqual(serialized2.length, 2 + 16 + 16 + 1 + 4); // flags + hops + transportId + destHash + context + payload
  assert.strictEqual(serialized2[0] & 0x40, 0x40); // headerType bit
  assert.strictEqual(serialized2[0] & 0x10, 0x10); // transportType bit
  assert.strictEqual(serialized2[0] & 0x20, 0x20); // contextFlag bit
  assert.strictEqual(serialized2[0] & 0x0f, PacketType.ANNOUNCE);

  const deserialized2 = Packet.deserialize(serialized2);
  assert.strictEqual(deserialized2.headerType, HeaderType.HEADER_2);
  assert.strictEqual(deserialized2.hops, 2);
  assert.strictEqual(deserialized2.transportType, 1);
  assert.strictEqual(deserialized2.packetType, PacketType.ANNOUNCE);
  assert.strictEqual(deserialized2.contextFlag, true);
  assert.strictEqual(deserialized2.contextByte, 0x0b);
  assert.deepStrictEqual(deserialized2.transportId, transportId);
  assert.deepStrictEqual(deserialized2.destinationHash, destHash);
  assert.deepStrictEqual(deserialized2.payload, payload);

  // --- Deserialize hardening (untrusted-input defenses) ---

  // A truncated HEADER_2 frame (between the old 19-byte floor and the real
  // 35-byte HEADER_2 minimum) used to be silently accepted: slice() clamps,
  // yielding a short destinationHash and an undefined contextByte. It must now
  // throw before any slicing.
  const truncatedH2 = new Uint8Array(20);
  truncatedH2[0] = 0x40; // HEADER_2 flag bit
  assert.throws(
    () => Packet.deserialize(truncatedH2),
    /too short/,
    "truncated HEADER_2 must be rejected",
  );

  // A HEADER_1 frame under its 19-byte minimum is rejected too.
  assert.throws(
    () => Packet.deserialize(new Uint8Array(10)),
    /too short/,
    "too-short HEADER_1 must be rejected",
  );

  // hop-count loop-prevention (mirrors Python PATHFINDER_M). A packet whose
  // hops have reached the ceiling is invalid and dropped at deserialize time.
  const tooManyHops = new Uint8Array(19);
  tooManyHops[0] = 0x00; // HEADER_1
  tooManyHops[1] = PATHFINDER_M; // hops == ceiling → invalid
  assert.throws(
    () => Packet.deserialize(tooManyHops),
    /Invalid hop count/,
    "hops >= PATHFINDER_M must be rejected",
  );

  // hops == PATHFINDER_M - 1 is the largest valid value and must be accepted.
  const maxHops = new Uint8Array(19);
  maxHops[1] = PATHFINDER_M - 1;
  assert.doesNotThrow(() => Packet.deserialize(maxHops));
  assert.strictEqual(Packet.deserialize(maxHops).hops, PATHFINDER_M - 1);

  console.log("Packet tests passed!");
}

testPacket().catch((err) => {
  console.error("Tests failed!");
  console.error(err);
  process.exit(1);
});
