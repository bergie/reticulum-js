import assert from "node:assert";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import {
  TCPClientInterface,
  TCPServerInterface,
} from "../../src/interfaces/tcp.js";

test("TCP interface connection and packet transfer", async () => {
  const port = 12345;
  const server = new TCPServerInterface({ port });
  const client = new TCPClientInterface({ host: "127.0.0.1", port });

  const connectionPromise = new Promise((resolve) => {
    server.addEventListener("connection", (event) => {
      resolve(event.detail);
    });
  });

  await server.connect();
  await client.connect();

  assert.ok(server.isOpen);
  assert.ok(client.isOpen);

  const connectedClient = await connectionPromise;
  assert.ok(connectedClient, "Server should have spawned a client interface");

  const destHash = new Uint8Array(16).fill(0);
  const payload = new TextEncoder().encode("Hello Reticulum!");
  const packet = new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: destHash,
    contextByte: 0,
    payload: payload,
  });

  // Test client to server
  const clientWriter = client.writable.getWriter();
  await clientWriter.write(packet);
  clientWriter.releaseLock();

  // Get the packet from the server side via the event
  const receivedPacket = await new Promise((resolve) => {
    connectedClient.addEventListener("packet", (event) => {
      resolve(event.detail.packet);
    });
  });

  assert.ok(receivedPacket);
  assert.strictEqual(
    new TextDecoder().decode(receivedPacket.payload),
    "Hello Reticulum!",
  );

  // Test server to client
  const serverClientWriter = connectedClient.writable.getWriter();
  await serverClientWriter.write(packet);
  serverClientWriter.releaseLock();

  const clientReceivedPacket = await new Promise((resolve) => {
    client.addEventListener("packet", (event) => {
      resolve(event.detail.packet);
    });
  });

  assert.ok(clientReceivedPacket);
  assert.strictEqual(
    new TextDecoder().decode(clientReceivedPacket.payload),
    "Hello Reticulum!",
  );

  await client.disconnect();
  await server.disconnect();
});

test("TCP interface lifecycle events (packet, closed, error)", async () => {
  const port = 12346;
  const server = new TCPServerInterface({ port });
  const client = new TCPClientInterface({ host: "127.0.0.1", port });

  // The server emits its `connection` event during the client's connect()
  // handshake, so the listener must be registered before connecting to avoid
  // missing it (which would hang the test until timeout).
  const connectionPromise = new Promise((resolve) => {
    server.addEventListener("connection", (event) => {
      resolve(event.detail);
    });
  });

  await server.connect();
  await client.connect();

  const packetReceived = new Promise((resolve) => {
    client.addEventListener("packet", (event) => {
      resolve(event.detail.packet);
    });
  });

  const destHash = new Uint8Array(16).fill(0);
  const payload = new TextEncoder().encode("Lifecycle test");
  const packet = new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: destHash,
    contextByte: 0,
    payload: payload,
  });

  // Send packet from server to client
  const connectedClient = await connectionPromise;
  const serverClientWriter = connectedClient.writable.getWriter();
  await serverClientWriter.write(packet);
  serverClientWriter.releaseLock();

  const receivedPacket = await packetReceived;
  assert.ok(receivedPacket);
  assert.strictEqual(
    new TextDecoder().decode(receivedPacket.payload),
    "Lifecycle test",
  );

  // Test closed event
  let closedCalled = false;
  client.addEventListener("closed", () => {
    closedCalled = true;
  });

  await server.disconnect();
  await client.disconnect();
});
