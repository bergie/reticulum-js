import assert from "node:assert";
import net from "node:net";
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
import { kissFrame } from "../../src/transport/kiss-framer.js";

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
  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port,
    autoReconnect: false,
  });

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

// ------------------------------------------------------------------
// Reconnection (initiator only), matching the Python reference TCPClientInterface
// ------------------------------------------------------------------

/**
 * Reserves an ephemeral port and releases it, so nothing is listening on it
 * and a dial fails fast with ECONNREFUSED.
 * @returns {Promise<number>}
 */
function getClosedPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (
        s.address()
      );
      s.close(() => resolve(port));
    });
  });
}

test("TCP client reconnects after the remote end drops", async () => {
  const rawServer = net.createServer();
  /** @type {import('node:net').Socket[]} */
  const accepted = [];
  rawServer.on("connection", (socket) => {
    accepted.push(socket);
    // Drop only the first connection to force a reconnect; leave later ones.
    if (accepted.length === 1) {
      setImmediate(() => socket.destroy());
    }
  });
  await new Promise((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (
    rawServer.address()
  ).port;

  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port,
    reconnectWait: 0.05,
    connectTimeout: 2,
  });

  let connectCount = 0;
  let disconnectedCount = 0;
  const reconnectingDetails = [];
  client.addEventListener("connected", () => {
    connectCount++;
  });
  client.addEventListener("disconnected", () => {
    disconnectedCount++;
  });
  client.addEventListener("reconnecting", (event) => {
    reconnectingDetails.push(event.detail);
  });

  await client.connect();
  assert.strictEqual(connectCount, 1);

  // After the drop: disconnected -> reconnecting -> connected.
  await new Promise((resolve) => {
    const check = () => {
      if (connectCount >= 2) resolve();
    };
    client.addEventListener("connected", check);
    check();
  });

  assert.strictEqual(connectCount, 2, "client should reconnect");
  assert.ok(disconnectedCount >= 1, "disconnected should fire on drop");
  assert.ok(client.isOpen, "client should be back online");
  assert.ok(reconnectingDetails.length >= 1, "reconnecting event should fire");
  assert.strictEqual(reconnectingDetails[0].attempt, 1);
  assert.strictEqual(reconnectingDetails[0].waitSeconds, 0.05);

  await client.disconnect();
  for (const s of accepted) s.destroy();
  await new Promise((resolve) => rawServer.close(resolve));
});

test("TCP client reconnects in the background after a first failed dial", async () => {
  // Start a server AFTER the first dial fails, so the background reconnect
  // is what finally establishes the link (mirrors Python initial_connect).
  const portHolder = await getClosedPort();
  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port: portHolder,
    reconnectWait: 0.1,
    connectTimeout: 1,
  });

  // First dial fails (nothing listening) -> rejects, but reconnects in bg.
  await assert.rejects(() => client.connect());
  assert.ok(!client.isOpen);

  // Now bring the server up so the next reconnect attempt can succeed.
  const rawServer = net.createServer();
  rawServer.on("connection", () => {});
  await new Promise((resolve) =>
    rawServer.listen(portHolder, "127.0.0.1", resolve),
  );

  await new Promise((resolve) => {
    const check = () => {
      if (client.isOpen) resolve();
    };
    client.addEventListener("connected", check);
    check();
  });
  assert.ok(client.isOpen, "background reconnect should establish the link");

  await client.disconnect();
  await new Promise((resolve) => rawServer.close(resolve));
});

test("TCP client gives up after maxReconnectTries and fires closed", async () => {
  const port = await getClosedPort();
  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port,
    reconnectWait: 0.02,
    connectTimeout: 1,
    maxReconnectTries: 2,
  });

  let reconnectingCount = 0;
  client.addEventListener("reconnecting", () => {
    reconnectingCount++;
  });

  await assert.rejects(() => client.connect());

  await new Promise((resolve) => {
    client.addEventListener("closed", () => resolve());
  });

  assert.ok(!client.isOpen, "stays offline after exhaustion");
  assert.strictEqual(
    reconnectingCount,
    2,
    "one reconnecting event per allowed attempt",
  );
});

test("TCP client disconnect() cancels a pending reconnect backoff", async () => {
  const port = await getClosedPort();
  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port,
    reconnectWait: 5, // long backoff we can interrupt
    connectTimeout: 1,
  });

  let reconnectingCount = 0;
  client.addEventListener("reconnecting", () => {
    reconnectingCount++;
  });

  await assert.rejects(() => client.connect());
  // The loop dispatches `reconnecting` synchronously before its first sleep.
  assert.strictEqual(reconnectingCount, 1);

  let closedCount = 0;
  client.addEventListener("closed", () => {
    closedCount++;
  });

  await client.disconnect();
  assert.strictEqual(closedCount, 1, "deliberate disconnect fires closed once");

  // No further reconnect attempts after cancellation.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(reconnectingCount, 1);
});

test("TCP server-spawned (adopted) socket never reconnects on close", async () => {
  const rawServer = net.createServer();
  /** @type {import('node:net').Socket | null} */
  let accepted = null;
  rawServer.on("connection", (socket) => {
    accepted = socket;
  });
  await new Promise((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (
    rawServer.address()
  ).port;

  // Dial from a raw socket so we can hand the accepted socket to the client.
  const dialer = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve) => dialer.once("connect", resolve));
  // Wait until the server has actually accepted the connection.
  await new Promise((resolve) => {
    const check = () => (accepted ? resolve() : setImmediate(check));
    check();
  });
  assert.ok(accepted);

  const adopted = new TCPClientInterface({ socket: accepted });
  await adopted.connect();
  assert.strictEqual(adopted.initiator, false);
  assert.strictEqual(adopted.autoReconnect, true); // default, but ignored for non-initiator

  let closed = false;
  let reconnecting = false;
  adopted.addEventListener("closed", () => {
    closed = true;
  });
  adopted.addEventListener("reconnecting", () => {
    reconnecting = true;
  });

  // Drop the connection from the peer side.
  dialer.destroy();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(closed, "adopted socket fires closed on remote drop");
  assert.ok(!reconnecting, "adopted socket must never reconnect");

  await new Promise((resolve) => rawServer.close(resolve));
});

test("TCP client applies TCP_NODELAY and keepalive on the dialed socket", async () => {
  // Node does not expose portable getters for SO_KEEPALIVE / TCP_NODELAY, so
  // this is a smoke test: connect to a real server and assert the option
  // tuning runs without breaking the socket. The i2pTunneled flag selects the
  // longer probe interval and must be stored on the interface.
  const rawServer = net.createServer();
  rawServer.on("connection", () => {});
  await new Promise((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (
    rawServer.address()
  ).port;

  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port,
    autoReconnect: false,
    i2pTunneled: true,
  });
  await client.connect();
  assert.ok(client.socket, "socket should be set");
  assert.strictEqual(
    typeof client.socket.setNoDelay,
    "function",
    "socket supports setNoDelay",
  );
  assert.strictEqual(
    typeof client.socket.setKeepAlive,
    "function",
    "socket supports setKeepAlive",
  );
  assert.ok(client.socket.writable, "socket is writable after tuning");
  assert.strictEqual(client.i2pTunneled, true);

  await client.disconnect();
  await new Promise((resolve) => rawServer.close(resolve));
});

test("TCP client defaults match the Python reference", () => {
  const client = new TCPClientInterface({ host: "127.0.0.1", port: 1 });
  assert.strictEqual(client.autoReconnect, true);
  assert.strictEqual(client.reconnectWait, 5);
  assert.strictEqual(client.maxReconnectTries, Number.POSITIVE_INFINITY);
  assert.strictEqual(client.connectTimeout, 5);
  assert.strictEqual(client.initiator, true);
  assert.strictEqual(client.framing, "hdlc", "default framing is HDLC");
});

// ------------------------------------------------------------------
// KISS framing (framing: "kiss"), mirroring the Python kiss_framing option
// ------------------------------------------------------------------

test("TCP client with framing: 'kiss' emits KISS frames on the wire", async () => {
  const payload = new TextEncoder().encode("KISS over TCP");
  const packet = new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: 0,
    payload,
  });
  const expectedFrame = kissFrame(packet.serialize());

  // Raw server captures the exact bytes the client writes and echoes a KISS
  // frame back so the inbound unframer is exercised too.
  /** @type {number[]} */
  const seen = [];
  const rawServer = net.createServer((socket) => {
    socket.on("data", (data) => {
      for (const b of data) seen.push(b);
      socket.write(expectedFrame);
    });
  });
  await new Promise((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (
    rawServer.address()
  ).port;

  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port,
    framing: "kiss",
    autoReconnect: false,
  });
  assert.strictEqual(client.framing, "kiss");
  await client.connect();

  const inboundPacket = new Promise((resolve) => {
    client.addEventListener("packet", (event) => resolve(event.detail.packet));
  });

  const writer = client.writable.getWriter();
  await writer.write(packet);
  writer.releaseLock();

  // Outbound: the wire bytes must be a KISS frame (FEND | CMD_DATA | … | FEND),
  // not an HDLC (0x7E) frame.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(seen[0], 0xc0, "frame starts with FEND");
  assert.strictEqual(seen[1] & 0x0f, 0x00, "command byte is CMD_DATA");
  assert.strictEqual(seen[seen.length - 1], 0xc0, "frame ends with FEND");
  assert.deepStrictEqual(seen, Array.from(expectedFrame));

  // Inbound: the echoed KISS frame decodes back into the same packet.
  const received = await inboundPacket;
  assert.ok(received, "KISS-framed echo should decode to a packet");
  assert.deepStrictEqual(
    new TextDecoder().decode(received.payload),
    "KISS over TCP",
  );

  await client.disconnect();
  await new Promise((resolve) => rawServer.close(resolve));
});

test("TCP server propagates framing to spawned client interfaces", async () => {
  const port = 12399;
  const server = new TCPServerInterface({ port, framing: "kiss" });
  assert.strictEqual(server.framing, "kiss");

  const connectionPromise = new Promise((resolve) => {
    server.addEventListener("connection", (event) => resolve(event.detail));
  });
  await server.connect();

  const client = new TCPClientInterface({
    host: "127.0.0.1",
    port,
    framing: "kiss",
    autoReconnect: false,
  });
  await client.connect();

  const spawned = /** @type {TCPClientInterface} */ (await connectionPromise);
  assert.strictEqual(spawned.framing, "kiss", "spawned client inherits kiss");

  await client.disconnect();
  await server.disconnect();
});
