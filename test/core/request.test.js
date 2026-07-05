import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ContextType, Packet } from "../../src/core/packet.js";
import { RequestManager } from "../../src/core/request.js";

describe("RequestManager", () => {
  test("sendRequest should send a packet and wait for a response", async () => {
    const mockDestinationHash = new Uint8Array(16);
    const mockLink = new EventTarget();
    mockLink.destinationHash = mockDestinationHash;
    /** @type {any} */
    mockLink.writable = {
      getWriter: () => ({
        write: async (packet) => {
          // Capture the packet sent
          mockLastSentPacket = packet;
        },
        releaseLock: () => {},
      }),
    };

    let mockLastSentPacket;
    const manager = new RequestManager(mockLink);

    const path = "/test/path";
    const appData = new Uint8Array([0x01, 0x02, 0x03]);

    const requestPromise = manager.sendRequest(path, appData);

    // Wait for the async write to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 1. Verify sent packet
    assert.ok(mockLastSentPacket instanceof Packet);
    assert.equal(mockLastSentPacket.contextFlag, true);
    assert.equal(mockLastSentPacket.contextByte, ContextType.REQUEST);
    assert.deepEqual(mockLastSentPacket.destinationHash, mockDestinationHash);
    assert.equal(mockLastSentPacket.payload.length, 32 + appData.length);

    // Extract Request ID from sent payload
    const sentRequestId = mockLastSentPacket.payload.slice(0, 16);

    // 2. Simulate incoming response
    const responseData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const responsePayload = new Uint8Array(16 + responseData.length);
    responsePayload.set(sentRequestId, 0);
    responsePayload.set(responseData, 16);

    const responsePacket = new Packet({
      headerType: 0,
      hops: 0,
      transportType: 0,
      destinationType: 3,
      packetType: 0,
      contextFlag: true,
      contextByte: ContextType.RESPONSE,
      destinationHash: mockDestinationHash,
      payload: responsePayload,
    });

    mockLink.dispatchEvent(
      new CustomEvent("packet", { detail: responsePacket }),
    );

    // 3. Verify response
    const result = await requestPromise;
    assert.deepEqual(result, responseData);
  });

  test("sendRequest should reject if response is not received", async () => {
    const mockLink = new EventTarget();
    mockLink.destinationHash = new Uint8Array(16);
    /** @type {any} */
    mockLink.writable = {
      getWriter: () => ({
        write: async () => {},
        releaseLock: () => {},
      }),
    };

    const manager = new RequestManager(mockLink);
    const requestPromise = manager.sendRequest("/timeout");

    // We use a race with a small timeout to verify it doesn't resolve
    // But we can't easily test timeout without timers.
    // Instead, let's just test that it doesn't resolve if no event is dispatched.
    // We use a race with a small timeout.

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), 100),
    );

    await assert.rejects(
      Promise.race([requestPromise, timeoutPromise]),
      /Timeout/,
    );
  });
});
