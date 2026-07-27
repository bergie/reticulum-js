import assert from "node:assert";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "@reticulum/core/src/core/packet.js";
import { HttpPostClientInterface } from "@reticulum/core/src/interfaces/http.js";
import {
  HttpPostPeerInterface,
  HttpPostServerInterface,
} from "../../src/interfaces/http_server.js";

/**
 * @file http_server.js
 * @description Tests for the HTTP POST server interface (PHP router
 *   replacement).
 *
 * Uses the real {@link HttpPostClientInterface} against a real
 * {@link HttpPostServerInterface} for a client ↔ server loopback, plus
 * direct-fetch checks for auth failure and idle-peer reaping.
 */

/** Builds a minimal valid RNS DATA packet. */
function buildTestPacket(payload = "Hello over HTTP!") {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: 0,
    payload: new TextEncoder().encode(payload),
  });
}

/** Waits until `predicate()` is truthy, polling every `ms`. */
async function waitFor(predicate, { timeout = 2000, ms = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
}

test("HTTP server spawns a peer per client and transfers packets both ways", async () => {
  const port = 14101;
  const server = new HttpPostServerInterface({
    listenPort: port,
    listenIp: "127.0.0.1",
    idleExchangeIntervalMs: 50,
    peerIdleTimeoutMs: 60000,
  });
  /** @type {HttpPostPeerInterface[]} */
  const peers = [];
  server.addEventListener("connection", (event) => {
    peers.push(/** @type {any} */ (event).detail);
  });
  await server.connect();
  assert.ok(server.isOpen);

  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });
  await client.connect();

  await waitFor(() => peers.length === 1);
  const peer = peers[0];
  assert.ok(peer instanceof HttpPostPeerInterface);
  assert.equal(server.clients, 1);

  // --- client → server ---
  const writer = client.writable.getWriter();
  await writer.write(buildTestPacket("to server"));
  writer.releaseLock();

  const receivedAtServer = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting at server")),
      2000,
    );
    peer.addEventListener("packet", (event) => {
      clearTimeout(timer);
      resolve(/** @type {any} */ (event).detail.packet);
    });
  });
  assert.deepEqual(
    new TextDecoder().decode(receivedAtServer.payload),
    "to server",
  );

  // --- server → client: write to the peer's writable as Transport would ---
  const peerWriter = peer.writable.getWriter();
  await peerWriter.write(buildTestPacket("to client"));
  peerWriter.releaseLock();

  const receivedAtClient = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting at client")),
      2000,
    );
    client.addEventListener("packet", (event) => {
      clearTimeout(timer);
      resolve(/** @type {any} */ (event).detail.packet);
    });
  });
  assert.deepEqual(
    new TextDecoder().decode(receivedAtClient.payload),
    "to client",
  );

  await client.disconnect();
  await server.disconnect();
});

test("HTTP server reaps peers that stop polling", async () => {
  const port = 14102;
  const server = new HttpPostServerInterface({
    listenPort: port,
    listenIp: "127.0.0.1",
    idleExchangeIntervalMs: 50,
    peerIdleTimeoutMs: 300,
  });
  /** @type {HttpPostPeerInterface[]} */
  const peers = [];
  server.addEventListener("connection", (event) => {
    peers.push(/** @type {any} */ (event).detail);
  });
  await server.connect();

  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });
  await client.connect();
  await waitFor(() => peers.length === 1);
  assert.equal(server.clients, 1);

  let peerClosed = false;
  peers[0].addEventListener("closed", () => {
    peerClosed = true;
  });

  // Stop the client polling; the server should reap the idle peer.
  await client.disconnect();

  await waitFor(() => server.clients === 0, { timeout: 3000 });
  assert.equal(server.clients, 0);
  assert.ok(peerClosed, "reaped peer should dispatch a closed event");

  await server.disconnect();
});

test("HTTP server rejects /exchange with unknown credentials (401)", async () => {
  const port = 14103;
  const server = new HttpPostServerInterface({
    listenPort: port,
    listenIp: "127.0.0.1",
  });
  await server.connect();

  const resp = await fetch(`http://127.0.0.1:${port}/v1/interfaces/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      interface_id: "iface-does-not-exist",
      session_token: "sess-bogus",
      packets: [],
    }),
  });
  assert.equal(resp.status, 401);
  const body = await resp.json();
  assert.match(body.error, /credentials/i);

  await server.disconnect();
});

test("HTTP server configuration schema and naming", () => {
  const schema = HttpPostServerInterface.getConfigurationSchema();
  assert.equal(schema.title, "HTTP POST Server Interface");
  assert.deepEqual(schema.required, ["listenPort"]);

  const s = new HttpPostServerInterface({ listenPort: 8080 });
  assert.match(s.name, /http-server-0\.0\.0\.0:8080/);
  assert.ok(!s.isOpen);
  assert.throws(() => s.readable, /not implemented/);
});

/** Registers a peer via the server's /register endpoint and returns credentials. */
async function registerPeer(baseUrl, name) {
  const resp = await fetch(`${baseUrl}/v1/interfaces/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return /** @type {any} */ (await resp.json());
}

test("HTTP server rejects an oversized request body with 413 (before auth/parsing)", async () => {
  const port = 14104;
  const server = new HttpPostServerInterface({
    listenPort: port,
    listenIp: "127.0.0.1",
    maxRequestBodyBytes: 256,
  });
  await server.connect();

  const big = JSON.stringify({
    interface_id: "x",
    session_token: "y",
    packets: ["A".repeat(5000)],
  });
  const resp = await fetch(`http://127.0.0.1:${port}/v1/interfaces/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: big,
  });
  assert.equal(resp.status, 413);
  const body = await resp.json();
  assert.match(body.error, /too large/i);

  await server.disconnect();
});

test("HTTP server caps inbound packets at maxBatchPackets and skips oversized entries", async () => {
  const port = 14105;
  // maxPacketBytes=500 → max entry ≈ 1000 base64 chars; maxBatchPackets=4.
  const server = new HttpPostServerInterface({
    listenPort: port,
    listenIp: "127.0.0.1",
    maxBatchPackets: 4,
    maxPacketBytes: 500,
  });
  /** @type {HttpPostPeerInterface[]} */
  const peers = [];
  server.addEventListener("connection", (e) =>
    peers.push(/** @type {any} */ (e).detail),
  );
  await server.connect();
  const baseUrl = `http://127.0.0.1:${port}`;

  const creds = await registerPeer(baseUrl, "capped-peer");
  await waitFor(() => peers.length === 1);
  const peer = peers[0];

  /** @type {import("@reticulum/core/src/core/packet.js").Packet[]} */
  const received = [];
  peer.addEventListener("packet", (e) =>
    received.push(/** @type {any} */ (e).detail.packet),
  );

  // Build 10 tiny valid packets (over the maxBatchPackets=4 cap) plus one
  // oversized base64 entry that must be skipped entirely.
  const p = buildTestPacket("p");
  const serialized = Buffer.from(p.serialize()).toString("base64");
  const oversized = "B".repeat(2000); // well over maxPacketBytes*2
  const resp = await fetch(`${baseUrl}/v1/interfaces/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      interface_id: creds.interface_id,
      session_token: creds.session_token,
      packets: [
        serialized,
        serialized,
        serialized,
        serialized,
        serialized,
        serialized,
        serialized,
        serialized,
        serialized,
        serialized,
        oversized,
      ],
    }),
  });
  assert.equal(resp.status, 200);

  // Give the peer's inbound loop a tick to enqueue packets.
  await waitFor(() => received.length >= 4, { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 50));
  // Exactly maxBatchPackets survive the inbound cap; the oversized entry is
  // dropped before ever reaching base64ToBytes.
  assert.equal(received.length, 4);

  await server.disconnect();
});
