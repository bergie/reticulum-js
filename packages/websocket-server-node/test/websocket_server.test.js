import assert from "node:assert";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "@reticulum/core/src/core/packet.js";
import { WebSocketClientInterface } from "@reticulum/core/src/interfaces/websocket.js";
import { WebSocketServerInterface } from "../src/index.js";

/**
 * @file websocket_server.test.js
 * @description Smoke tests for the ws-backed `WebSocketServerInterface`. Node
 *   has no native WebSocket server, so these exercise the real `ws` stack this
 *   package exists to provide to @reticulum/core. The `ssl` tests terminate TLS
 *   with a self-signed certificate (the browser-use-case: an HTTPS page can only
 *   open `wss://`).
 */

/**
 * Whether `openssl` is available, for generating the self-signed test cert.
 * When false, the TLS tests are skipped.
 */
const opensslAvailable = (() => {
  try {
    execSync("openssl version", { stdio: "ignore" });
    return true;
  } catch (_e) {
    return false;
  }
})();

/**
 * Generates a self-signed certificate (CN=localhost, SAN includes 127.0.0.1)
 * into a temp dir and returns its paths plus a cleanup helper.
 * @returns {{ certFile: string, keyFile: string, cleanup: () => void }}
 */
function generateSelfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rns-wss-"));
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");
  execSync(
    "openssl req -x509 -newkey rsa:2048 " +
      `-keyout "${keyFile}" -out "${certFile}" ` +
      '-days 1 -nodes -subj "/CN=localhost" ' +
      '-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
    { stdio: "ignore" },
  );
  return {
    certFile,
    keyFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Path to the Python reference TLS WebSocket client fixture. */
const FIXTURE_CLIENT = new URL("fixtures/ws_client_tls.py", import.meta.url)
  .pathname;

/**
 * Whether the Python toolchain needed for the integration test is available.
 * When false, the Python-interop test is skipped.
 */
const pythonAvailable = (() => {
  try {
    execSync('python3 -c "import websockets, RNS"', { stdio: "ignore" });
    return true;
  } catch (_e) {
    return false;
  }
})();

/** Builds a minimal valid RNS DATA packet. */
function buildTestPacket(payload) {
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

test("WebSocketServerInterface schema documents its options", () => {
  const schema = WebSocketServerInterface.getConfigurationSchema();
  assert.strictEqual(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.strictEqual(schema.type, "object");
  assert.ok(schema.properties.listenIp);
  assert.ok(schema.properties.listenPort);
  assert.ok(schema.properties.framing);
  assert.ok(schema.properties.ssl, "schema documents ssl");
  assert.ok(schema.properties.certFile, "schema documents certFile");
  assert.ok(schema.properties.keyFile, "schema documents keyFile");
  assert.strictEqual(schema.properties.ssl.default, false);
  // No reconnect options (server interfaces don't dial).
  assert.ok(!schema.properties.autoReconnect);
  assert.deepStrictEqual(schema.required, ["listenPort"]);
  assert.strictEqual(schema.properties.listenIp.default, "0.0.0.0");
});

test("WebSocketServerInterface declares the nominal ~10 Mbit/s bitrate", () => {
  const iface = new WebSocketServerInterface({ listenPort: 0 });
  assert.equal(iface.bitrate, 10000000);
});

test("WebSocketServer spawns a client per connection that inherits its bitrate", async () => {
  const server = new WebSocketServerInterface({ listenPort: 0 });
  // Custom rate to prove inheritance rather than a hardcoded default.
  server.bitrate = 4200000;
  await server.connect();
  const port = /** @type {any} */ (server.server).address().port;

  const spawned = new Promise((resolve) => {
    server.addEventListener("connection", (event) => resolve(event.detail));
  });

  const client = new WebSocketClientInterface({ host: "127.0.0.1", port });
  await client.connect();

  const spawnedClient = /** @type {WebSocketClientInterface} */ (await spawned);
  assert.ok(
    spawnedClient instanceof WebSocketClientInterface,
    "spawned interface must be a WebSocketClientInterface",
  );
  assert.equal(
    spawnedClient.bitrate,
    4200000,
    "spawned client must inherit the server's bitrate",
  );
  assert.ok(server.clients >= 1, "server tracks the spawned client");

  await client.disconnect();
  await server.disconnect();
  assert.equal(server.online, false, "disconnect clears online state");
});

// ------------------------------------------------------------------
// TLS / wss:// (the browser secure-context use case)
// ------------------------------------------------------------------

test("WebSocketServer ssl requires both certFile and keyFile", () => {
  // Mirrors the Python reference validation.
  assert.throws(
    () => new WebSocketServerInterface({ listenPort: 0, ssl: true }),
    /certFile and keyFile/,
  );
  assert.throws(
    () =>
      new WebSocketServerInterface({ listenPort: 0, ssl: true, certFile: "x" }),
    /certFile and keyFile/,
  );
  assert.throws(
    () =>
      new WebSocketServerInterface({ listenPort: 0, ssl: true, keyFile: "x" }),
    /certFile and keyFile/,
  );
});

test("WebSocketServer certFile/keyFile require ssl to be enabled", () => {
  // Providing either credential without ssl would silently do nothing.
  assert.throws(
    () => new WebSocketServerInterface({ listenPort: 0, certFile: "x" }),
    /SSL must be enabled/,
  );
  assert.throws(
    () => new WebSocketServerInterface({ listenPort: 0, keyFile: "x" }),
    /SSL must be enabled/,
  );
});

test("WebSocketServer with ssl terminates TLS and accepts a wss:// client", {
  timeout: 15000,
}, async () => {
  if (!opensslAvailable) return; // skip silently when openssl is absent

  const { certFile, keyFile, cleanup } = generateSelfSignedCert();
  // The self-signed test cert isn't in the system trust store, so let the
  // client skip verification for this test only.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const server = new WebSocketServerInterface({
      listenPort: 0,
      ssl: true,
      certFile,
      keyFile,
    });
    assert.equal(server.ssl, true);
    await server.connect();
    assert.ok(server.tlsServer, "TLS server is tracked for shutdown");
    const port = /** @type {any} */ (server.server).address().port;

    const spawned = new Promise((resolve) => {
      server.addEventListener("connection", (event) => resolve(event.detail));
    });

    const client = new WebSocketClientInterface({
      host: "127.0.0.1",
      port,
      ssl: true,
    });
    assert.strictEqual(client.url, `wss://127.0.0.1:${port}`);
    await client.connect();
    assert.ok(client.isOpen, "wss:// client connects to the TLS server");

    const spawnedClient = /** @type {WebSocketClientInterface} */ (
      await spawned
    );
    assert.ok(
      spawnedClient instanceof WebSocketClientInterface,
      "server spawns a client for the wss:// connection",
    );

    await client.disconnect();
    await server.disconnect();
    assert.equal(server.tlsServer, null, "disconnect clears the TLS server");
    assert.equal(server.online, false);
  } finally {
    cleanup();
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
});

test("Python reference client interoperates with the JS TLS server over wss://", {
  timeout: 30000,
}, async () => {
  if (!opensslAvailable || !pythonAvailable) return; // skip when tooling absent

  const { certFile, keyFile, cleanup } = generateSelfSignedCert();
  try {
    const server = new WebSocketServerInterface({
      listenPort: 0,
      ssl: true,
      certFile,
      keyFile,
    });
    await server.connect();
    const port = /** @type {any} */ (server.server).address().port;

    // Wire up the echo *before* spawning the Python client, attaching the
    // packet handler inside the connection handler so there's no window for
    // the inbound packet to arrive before we're listening for it.
    const replyPacket = buildTestPacket("pong from js");
    const replied = new Promise((resolve, reject) => {
      server.addEventListener("connection", (event) => {
        /** @type {WebSocketClientInterface} */
        const spawnedClient = event.detail;
        spawnedClient.addEventListener("packet", () => {
          spawnedClient.send(replyPacket).then(resolve).catch(reject);
        });
      });
    });

    // Spawn the Python reference client against our TLS server.
    const child = spawn(
      "python3",
      [FIXTURE_CLIENT, "127.0.0.1", String(port)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));

    const code = await new Promise((resolve) => {
      child.on("exit", resolve);
    });
    await replied;

    const stdout = Buffer.concat(out).toString("utf8");
    const stderr = Buffer.concat(err).toString("utf8");
    assert.strictEqual(
      code,
      0,
      `Python client exited ${code}. stdout: ${stdout}\nstderr: ${stderr}`,
    );
    assert.ok(
      stdout.includes("RECEIVED b'pong from js'"),
      `Python client did not decode the JS reply. stdout: ${stdout}`,
    );
    assert.ok(
      stdout.includes("OK"),
      `Python client did not confirm: ${stdout}`,
    );

    await server.disconnect();
  } finally {
    cleanup();
  }
});
