import assert from "node:assert";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { HttpPostClientInterface } from "../../src/interfaces/http.js";
import { base64ToBytes, bytesToBase64 } from "../../src/utils/encoding.js";

/**
 * @file http.js
 * @description Tests for the HTTP POST client interface.
 *
 * Spins up a minimal in-process HTTP exchange server (no external deps) that
 * implements the Reticulum-post `/register` + `/exchange` protocol, then
 * exercises the client: registration, outbound delivery, inbound delivery,
 * adaptive poll interval, and 401 → re-register recovery.
 */

/**
 * @typedef {Object} MockInterface
 * @property {string} sessionToken
 * @property {Uint8Array[]} inbound   packets queued for delivery to the client
 * @property {Uint8Array[]} received  packets the client has posted
 * @property {number} exchangeCount
 */

/**
 * @typedef {Object} MockServer
 * @property {Map<string, MockInterface>} interfaces
 * @property {number} interval the idle_exchange_interval_ms returned
 * @property {() => Promise<void>} close
 */

/**
 * Minimal HTTP exchange server for testing.
 *
 * Implements `POST /v1/interfaces/register` and
 * `POST /v1/interfaces/exchange` with in-memory per-interface state. The
 * `interval` field is mutable so tests can exercise the adaptive poll update.
 * @param {number} port
 * @param {number} [initialInterval=1000]
 * @returns {Promise<MockServer>}
 */
function startExchangeServer(port, initialInterval = 1000) {
  /** @type {Map<string, MockInterface>} */
  const interfaces = new Map();
  const state = { interval: initialInterval };

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    /** @type {Record<string, any>} */
    let json = {};
    try {
      json = body ? JSON.parse(body) : {};
    } catch (_e) {
      // ignore malformed body
    }

    if (req.method === "POST" && req.url === "/v1/interfaces/register") {
      const interfaceId = `iface-${randomBytes(4).toString("hex")}`;
      const sessionToken = `sess-${randomBytes(8).toString("hex")}`;
      interfaces.set(interfaceId, {
        sessionToken,
        inbound: [],
        received: [],
        exchangeCount: 0,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          interface_id: interfaceId,
          session_token: sessionToken,
          max_batch_packets: 64,
          max_packet_bytes: 500,
          idle_exchange_interval_ms: state.interval,
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === "/v1/interfaces/exchange") {
      const iface = interfaces.get(json.interface_id);
      if (!iface || iface.sessionToken !== json.session_token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid interface credentials" }));
        return;
      }
      iface.exchangeCount++;
      for (const b64 of json.packets || []) {
        iface.received.push(base64ToBytes(b64));
      }
      const delivery = iface.inbound.splice(0);
      /** @type {Record<string, any>} */
      const resp = {
        delivery_packets: delivery.map((b) => bytesToBase64(b)),
        idle_exchange_interval_ms: state.interval,
      };
      if (delivery.length > 0) {
        resp.delivery_batch_id = `srv-${iface.exchangeCount}`;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        interfaces,
        get interval() {
          return state.interval;
        },
        set interval(v) {
          state.interval = v;
        },
        close: () => new Promise((resolve) => server.close(() => resolve())),
      }),
    );
  });
}

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

/** Resolves with the first (and typically only) registered mock interface. */
function firstInterface(/** @type {MockServer} */ mock) {
  const entry = Array.from(mock.interfaces.values())[0];
  assert.ok(entry, "server should have a registered interface");
  return entry;
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

test("HTTP client registers and fires the connected event", async () => {
  const port = 14001;
  const mock = await startExchangeServer(port);
  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });

  let connectedFired = false;
  client.addEventListener("connected", () => {
    connectedFired = true;
  });

  await client.connect();
  assert.ok(client.isOpen);
  assert.ok(client.isRegistered);
  assert.ok(connectedFired, "connected event should fire");
  assert.ok(mock.interfaces.size === 1, "one interface registered server-side");

  await client.disconnect();
  await mock.close();
});

test("HTTP client sends packets as base64 over /exchange", async () => {
  const port = 14002;
  const mock = await startExchangeServer(port);
  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });
  await client.connect();

  const packet = buildTestPacket("outbound check");
  const expected = packet.serialize();

  const writer = client.writable.getWriter();
  await writer.write(packet);
  writer.releaseLock();

  const iface = firstInterface(mock);
  await waitFor(() => iface.received.length > 0);

  assert.equal(iface.received.length, 1);
  assert.deepEqual(
    Array.from(iface.received[0]),
    Array.from(expected),
    "server should receive exactly the raw packet bytes",
  );

  await client.disconnect();
  await mock.close();
});

test("HTTP client receives delivery packets via polling", async () => {
  const port = 14003;
  const mock = await startExchangeServer(port);
  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });
  await client.connect();

  // Queue an inbound packet on the server side; the next poll delivers it.
  const inbound = buildTestPacket("from server").serialize();
  firstInterface(mock).inbound.push(inbound);

  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for packet")),
      2000,
    );
    client.addEventListener("packet", (event) => {
      clearTimeout(timer);
      resolve(event.detail.packet);
    });
  });

  assert.ok(received);
  assert.deepEqual(new TextDecoder().decode(received.payload), "from server");

  await client.disconnect();
  await mock.close();
});

test("HTTP client honors the register-time poll interval", async () => {
  const port = 14004;
  const mock = await startExchangeServer(port, 777);
  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });

  await client.connect();
  // The register response overrides the client default.
  assert.equal(client._pollIntervalMs, 777);

  await client.disconnect();
  await mock.close();
});

test("HTTP client adapts its poll interval from /exchange responses", async () => {
  const port = 14005;
  const mock = await startExchangeServer(port, 1000);
  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });
  await client.connect();
  assert.equal(client._pollIntervalMs, 1000);

  // Change the server-advertised interval, then force an exchange by sending.
  mock.interval = 333;
  const writer = client.writable.getWriter();
  await writer.write(buildTestPacket("trigger"));
  writer.releaseLock();

  await waitFor(() => client._pollIntervalMs === 333);
  assert.equal(client._pollIntervalMs, 333);

  await client.disconnect();
  await mock.close();
});

test("HTTP client re-registers after a 401 auth failure", async () => {
  const port = 14006;
  const mock = await startExchangeServer(port);
  const client = new HttpPostClientInterface({
    baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 50,
  });
  await client.connect();
  const originalId = client._interfaceId;
  assert.ok(originalId);

  // Simulate the server revoking the session: the stored token no longer
  // matches, so the next exchange 401s and the client must re-register.
  firstInterface(mock).sessionToken = "revoked";

  // Trigger an exchange; it will fail and the client should recover.
  const writer = client.writable.getWriter();
  await writer.write(buildTestPacket("after revoke"));
  writer.releaseLock();

  await waitFor(() => client._interfaceId !== originalId, { timeout: 3000 });
  assert.notEqual(client._interfaceId, originalId);
  assert.ok(client.isRegistered, "client should be registered again");

  await client.disconnect();
  await mock.close();
});

test("HTTP client configuration schema and naming", () => {
  const schema = HttpPostClientInterface.getConfigurationSchema();
  assert.equal(schema.title, "HTTP POST Client Interface");
  assert.ok(schema.properties.baseUrl);

  const a = new HttpPostClientInterface({
    baseUrl: "https://node.example.com/reticulum/",
  });
  // Trailing slash is stripped.
  assert.equal(a.baseUrl, "https://node.example.com/reticulum");
  assert.match(a.name, /http-client-node\.example\.com/);
  assert.ok(!a.isOpen);
});
