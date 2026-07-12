import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ContextType, Packet } from "../../src/core/packet.js";
import { Resource, ResourceStatus } from "../../src/core/resource.js";
import { ResourceAdvertisement } from "../../src/core/resource_advertisement.js";

describe("Resource", () => {
  test("prepareSender with Uint8Array data", async () => {
    const data = new Uint8Array(100);
    const resource = new Resource({ data });

    assert.equal(resource.totalSize, 100);
    assert.equal(resource.totalParts, 1);
    assert.equal(resource.size, 1);
    assert.deepEqual(resource.parts[0], data);
  });

  test("prepareSender with bz2 compression", async () => {
    const data = new TextEncoder().encode("hello world".repeat(100));
    const bz2 = {
      compress: (content) => {
        // Mock compression: just return it as is, but we want to test the flow
        return new Uint8Array([0x1, ...content]);
      },
      decompress: (compressed, originalLen) => {
        return compressed.slice(1);
      },
    };
    const resource = new Resource({
      data: new Uint8Array(data),
      bz2,
      autoCompress: true,
    });

    assert.ok(resource.compressed);
    assert.equal(resource.uncompressedSize, data.length);
    assert.deepEqual(
      resource.parts[0],
      new Uint8Array([0x1, ...data.slice(0, 1024 - 128 - 1)]),
    );
  });

  test("getProgress returns correct value", () => {
    const resource = new Resource({
      data: new Uint8Array(100),
    });
    resource.totalParts = 4;
    resource.receivedCount = 1;
    assert.equal(resource.getProgress(), 0.25);

    resource.receivedCount = 4;
    assert.equal(resource.getProgress(), 1.0);
  });

  test("advertise sends correct packet", async () => {
    const mockLink = {
      linkId: new Uint8Array(16).fill(0xaa),
      mtu: 1024,
      send: async (packet) => {
        resource.lastSentPacket = packet;
      },
    };

    const resource = new Resource({
      data: new Uint8Array(100),
      link: mockLink,
    });
    resource.hash = new Uint8Array(32).fill(0x01);
    resource.randomHash = new Uint8Array(16).fill(0x02);
    resource.originalHash = new Uint8Array(32).fill(0x03);

    await resource.advertise();

    assert.ok(resource.lastSentPacket instanceof Packet);
    assert.equal(resource.lastSentPacket.contextFlag, true);
    assert.equal(resource.lastSentPacket.contextByte, ContextType.RESOURCE_ADV);
    assert.deepEqual(resource.lastSentPacket.destinationHash, mockLink.linkId);
  });

  test("accept creates a correctly configured resource", () => {
    const mockLink = {
      registerIncomingResource: () => {},
    };
    const adv = new ResourceAdvertisement({
      t: 100,
      d: 100,
      n: 1,
      h: new Uint8Array(32).fill(0x01),
      r: new Uint8Array(16).fill(0x02),
      o: new Uint8Array(32).fill(0x03),
      i: 1,
      l: 1,
    });
    const advPacket = new Packet({
      headerType: 0,
      hops: 0,
      transportType: 0,
      destinationType: 3,
      packetType: 0,
      contextFlag: true,
      contextByte: ContextType.RESOURCE_ADV,
      destinationHash: new Uint8Array(16),
      payload: adv.pack(),
    });

    const resource = Resource.accept(mockLink, advPacket);

    assert.ok(resource instanceof Resource);
    assert.equal(resource.status, ResourceStatus.TRANSFERRING);
    assert.equal(resource.totalSize, 100);
    assert.equal(resource.totalParts, 1);
    assert.deepEqual(resource.hash, adv.h);
    assert.deepEqual(resource.randomHash, adv.r);
    assert.deepEqual(resource.originalHash, adv.o);
    assert.equal(resource.segmentIndex, 1);
    assert.equal(resource.isResponse, true);
  });

  test("accept with bz2 decompression", async () => {
    const originalData = new TextEncoder().encode("hello world");
    const compressedData = new Uint8Array([0x1, ...originalData]);
    const bz2 = {
      compress: (content) => compressedData,
      decompress: (compressed, originalLen) => compressed.slice(1),
    };

    const mockLink = {
      registerIncomingResource: () => {},
    };
    const adv = new ResourceAdvertisement({
      t: compressedData.length,
      d: originalData.length,
      n: 1,
      h: new Uint8Array(32).fill(0x01),
      r: new Uint8Array(16).fill(0x02),
      o: new Uint8Array(32).fill(0x03),
      i: 1,
      l: 1,
      f: 0b00000010, // c=1 (is_compressed)
    });
    const advPacket = new Packet({
      headerType: 0,
      hops: 0,
      transportType: 0,
      destinationType: 3,
      packetType: 0,
      contextFlag: true,
      contextByte: ContextType.RESOURCE_ADV,
      destinationHash: new Uint8Array(16),
      payload: adv.pack(),
    });

    const resource = Resource.accept(mockLink, advPacket, { bz2 });

    assert.ok(resource instanceof Resource);
    assert.ok(resource.compressed);
    assert.equal(resource.uncompressedSize, originalData.length);

    // Simulate receiving the part
    const partPacket = new Packet({
      payload: compressedData,
    });
    resource.receivePart(partPacket);

    // Wait for assembly (it's async)
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(resource.status, ResourceStatus.COMPLETE);
    assert.deepEqual(resource.data, originalData);
  });
});
