import assert from "node:assert";
import net from "node:net";
import { test } from "node:test";
import { getSharedInstanceEndpoint } from "../../src/core/config.js";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { LocalClientInterface } from "../../src/interfaces/local_client.js";

/**
 * Builds a minimal PLAIN DATA packet for round-trip framing tests.
 * @param {string} text
 * @returns {Packet}
 */
function makePacket(text) {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: 0,
    payload: new TextEncoder().encode(text),
  });
}

/**
 * Spins up a raw TCP server that adopts each accepted socket into a
 * {@link LocalClientInterface} (exactly how the daemon side will wrap inbound
 * connections), resolving once it is listening.
 * @param {{ onConnection?: (iface: LocalClientInterface) => void }} [handlers]
 * @returns {Promise<{ server: import('node:net').Server, port: number }>}
 */
function startAdoptingServer(handlers = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const iface = new LocalClientInterface({
        socket,
        name: "server-side",
      });
      iface.connect();
      handlers.onConnection?.(iface);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = /** @type {import('node:net').AddressInfo} */ (
        server.address()
      ).port;
      resolve({ server, port });
    });
  });
}

test("LocalClientInterface round-trips packets over a loopback socket", async () => {
  const { server, port } = await startAdoptingServer();
  const client = new LocalClientInterface({ port });

  /** @type {Promise<LocalClientInterface>} */
  const serverSide = new Promise((resolve) => {
    server.removeAllListeners("connection");
    server.on("connection", (socket) => {
      const iface = new LocalClientInterface({ socket, name: "server-side" });
      iface.connect();
      resolve(iface);
    });
  });

  await client.connect();
  assert.ok(client.isOpen);
  assert.strictEqual(client.isConnectedToSharedInstance, true);

  const serverIface = await serverSide;
  assert.strictEqual(serverIface.initiator, false);
  assert.strictEqual(serverIface.isConnectedToSharedInstance, false);

  // client -> server
  const clientWriter = client.writable.getWriter();
  await clientWriter.write(makePacket("Hello shared instance!"));
  clientWriter.releaseLock();

  const fromClient = await new Promise((resolve) => {
    serverIface.addEventListener("packet", (event) =>
      resolve(/** @type {any} */ (event).detail.packet),
    );
  });
  assert.strictEqual(
    new TextDecoder().decode(fromClient.payload),
    "Hello shared instance!",
  );

  // server -> client
  const serverWriter = serverIface.writable.getWriter();
  await serverWriter.write(makePacket("Hello back!"));
  serverWriter.releaseLock();

  const fromServer = await new Promise((resolve) => {
    client.addEventListener("packet", (event) =>
      resolve(/** @type {any} */ (event).detail.packet),
    );
  });
  assert.strictEqual(
    new TextDecoder().decode(fromServer.payload),
    "Hello back!",
  );

  await client.disconnect();
  await serverIface.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test("LocalClientInterface reconnects after the remote end drops", async () => {
  /** @type {import('node:net').Socket[]} */
  const accepted = [];
  const { server, port } = await new Promise((resolve) => {
    const server = net.createServer((socket) => {
      accepted.push(socket);
      // Drop only the first connection to force a reconnect.
      if (accepted.length === 1) setImmediate(() => socket.destroy());
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: /** @type {import('node:net').AddressInfo} */ (server.address())
          .port,
      }),
    );
  });

  const client = new LocalClientInterface({
    port,
    reconnectWait: 0.05,
    connectTimeout: 2,
  });

  let connectCount = 0;
  client.addEventListener("connected", () => {
    connectCount++;
  });

  await client.connect();
  assert.strictEqual(connectCount, 1);

  // After the drop the client should reconnect within the backoff window.
  await new Promise((resolve) => {
    const check = () => {
      if (connectCount >= 2) resolve(undefined);
    };
    client.addEventListener("connected", check);
    check();
  });
  assert.strictEqual(connectCount, 2, "client should reconnect after a drop");
  assert.ok(client.isOpen);

  await client.disconnect();
  for (const s of accepted) s.destroy();
  await new Promise((resolve) => server.close(resolve));
});

test("LocalClientInterface adopted (server-spawned) socket never reconnects", async () => {
  const { server, port } = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: /** @type {import('node:net').AddressInfo} */ (server.address())
          .port,
      }),
    );
  });

  /** @type {import('node:net').Socket | null} */
  let accepted = null;
  server.on("connection", (socket) => {
    accepted = socket;
  });

  const dialer = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve) => dialer.once("connect", resolve));
  await new Promise((resolve) => {
    const check = () => (accepted ? resolve(undefined) : setImmediate(check));
    check();
  });
  assert.ok(accepted);

  const adopted = new LocalClientInterface({ socket: accepted });
  await adopted.connect();
  assert.strictEqual(adopted.initiator, false);

  let closed = false;
  let reconnecting = false;
  adopted.addEventListener("closed", () => {
    closed = true;
  });
  adopted.addEventListener("reconnecting", () => {
    reconnecting = true;
  });

  dialer.destroy();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(closed, "adopted socket fires closed on remote drop");
  assert.ok(!reconnecting, "adopted socket must never reconnect");

  await new Promise((resolve) => server.close(resolve));
});

test("LocalClientInterface defaults match the Python reference", () => {
  const client = new LocalClientInterface({ port: 1 });
  assert.strictEqual(client.host, "127.0.0.1");
  assert.strictEqual(client.autoReconnect, true);
  assert.strictEqual(client.reconnectWait, 8, "RECONNECT_WAIT = 8");
  assert.strictEqual(client.maxReconnectTries, Number.POSITIVE_INFINITY);
  assert.strictEqual(client.connectTimeout, 5);
  assert.strictEqual(client.initiator, true);
  assert.strictEqual(client.isConnectedToSharedInstance, true);
});

// Opt-in live interop against a running Python rnsd (or our own daemon).
// Skipped by default so `npm test` stays hermetic; run with RNS_LIVE_INTEROP=1.
// Connects to the discovered shared-instance socket and asserts it comes online
// without rnsd rejecting the HDLC stream.
test("live interop with a running shared instance (set RNS_LIVE_INTEROP=1)", {
  skip: process.env.RNS_LIVE_INTEROP !== "1",
}, async () => {
  const endpoint = getSharedInstanceEndpoint();
  assert.strictEqual(
    endpoint.shareInstance,
    true,
    "share_instance must be enabled in ~/.reticulum/config",
  );

  const iface = new LocalClientInterface({
    host: endpoint.host,
    port: endpoint.port,
    socketPath: endpoint.socketPath,
    connectTimeout: 3,
    name: "interop-probe",
  });
  await iface.connect();
  assert.ok(iface.isOpen, "should come online against the running instance");
  assert.strictEqual(iface.isConnectedToSharedInstance, true);

  await iface.disconnect();
});
