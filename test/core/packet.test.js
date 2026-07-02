import { Packet, PacketType, HeaderType, DestType } from '../../src/core/packet.js';
import assert from 'node:assert';

async function testPacket() {
    console.log("Testing Packet...");

    // Test HEADER_1 DATA packet
    const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const destHash = new Uint8Array(16).fill(0xAA);
    const packet1 = new Packet({
        headerType: HeaderType.HEADER_1,
        hops: 5,
        transportType: 0,
        destinationType: DestType.SINGLE,
        packetType: PacketType.DATA,
        contextFlag: false,
        destinationHash: destHash,
        contextByte: 0,
        payload: payload
    });

    const serialized1 = packet1.serialize();
    assert.strictEqual(serialized1.length, 2 + 16 + 4); // flags + hops + destHash + payload
    assert.strictEqual(serialized1[0] & 0x0F, PacketType.DATA);
    assert.strictEqual(serialized1[1], 5);

    const deserialized1 = Packet.deserialize(serialized1);
    assert.strictEqual(deserialized1.headerType, HeaderType.HEADER_1);
    assert.strictEqual(deserialized1.hops, 5);
    assert.strictEqual(deserialized1.packetType, PacketType.DATA);
    assert.deepStrictEqual(deserialized1.destinationHash, destHash);
    assert.deepStrictEqual(deserialized1.payload, payload);

    // Test HEADER_2 ANNOUNCE packet
    const transportId = new Uint8Array(16).fill(0xBB);
    const packet2 = new Packet({
        headerType: HeaderType.HEADER_2,
        hops: 2,
        transportType: 1,
        destinationType: DestType.SINGLE,
        packetType: PacketType.ANNOUNCE,
        contextFlag: true,
        destinationHash: destHash,
        contextByte: 0x0B,
        payload: payload,
        transportId: transportId
    });

    const serialized2 = packet2.serialize();
    assert.strictEqual(serialized2.length, 2 + 16 + 16 + 1 + 4); // flags + hops + transportId + destHash + context + payload
    assert.strictEqual(serialized2[0] & 0x40, 0x40); // headerType bit
    assert.strictEqual(serialized2[0] & 0x10, 0x10); // transportType bit
    assert.strictEqual(serialized2[0] & 0x20, 0x20); // contextFlag bit
    assert.strictEqual(serialized2[0] & 0x0F, PacketType.ANNOUNCE);

    const deserialized2 = Packet.deserialize(serialized2);
    assert.strictEqual(deserialized2.headerType, HeaderType.HEADER_2);
    assert.strictEqual(deserialized2.hops, 2);
    assert.strictEqual(deserialized2.transportType, 1);
    assert.strictEqual(deserialized2.packetType, PacketType.ANNOUNCE);
    assert.strictEqual(deserialized2.contextFlag, true);
    assert.strictEqual(deserialized2.contextByte, 0x0B);
    assert.deepStrictEqual(deserialized2.transportId, transportId);
    assert.deepStrictEqual(deserialized2.destinationHash, destHash);
    assert.deepStrictEqual(deserialized2.payload, payload);

    console.log("Packet tests passed!");
}

testPacket().catch(err => {
    console.error("Tests failed!");
    console.error(err);
    process.exit(1);
});
