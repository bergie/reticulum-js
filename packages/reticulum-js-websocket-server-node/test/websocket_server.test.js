import assert from "node:assert";
import { test } from "node:test";
import { WebSocketClientInterface } from "reticulum-js/src/interfaces/websocket.js";
import { WebSocketServerInterface } from "../src/index.js";

/**
 * @file websocket_server.test.js
 * @description Smoke tests for the ws-backed `WebSocketServerInterface`. Node
 *   has no native WebSocket server, so these exercise the real `ws` stack this
 *   package exists to provide to reticulum-js.
 */

test("WebSocketServerInterface schema documents its options", () => {
  const schema = WebSocketServerInterface.getConfigurationSchema();
  assert.strictEqual(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.strictEqual(schema.type, "object");
  assert.ok(schema.properties.listenIp);
  assert.ok(schema.properties.listenPort);
  assert.ok(schema.properties.framing);
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
