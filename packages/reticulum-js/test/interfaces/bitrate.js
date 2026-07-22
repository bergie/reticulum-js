import assert from "node:assert";
import { test } from "node:test";
import { AutoInterfacePeer } from "../../src/interfaces/auto_peer.js";
import { Interface } from "../../src/interfaces/base.js";
import { HttpPostClientInterface } from "../../src/interfaces/http.js";
import {
  HttpPostPeerInterface,
  HttpPostServerInterface,
} from "../../src/interfaces/http_server.js";
import { LocalClientInterface } from "../../src/interfaces/local_client.js";
import {
  TCPClientInterface,
  TCPServerInterface,
} from "../../src/interfaces/tcp.js";
import {
  WebSocketClientInterface,
  WebSocketServerInterface,
} from "../../src/interfaces/websocket.js";

// Bitrate values mirror the Python reference (`self.bitrate` on
// `RNS.Interfaces.Interface` and each subclass). See work doc #19.

test("base Interface exposes the Python default bitrate (62500)", () => {
  // Concrete subclasses override this; the bare default must still match the
  // Python reference for parity/observability.
  const iface = new Interface();
  assert.equal(iface.bitrate, 62500);
});

test("each interface declares a Python-parity nominal bitrate", () => {
  const cases = [
    {
      name: "TCPClientInterface",
      iface: new TCPClientInterface({ host: "127.0.0.1", port: 1 }),
      expected: 10000000, // TCPClientInterface.BITRATE_GUESS
    },
    {
      name: "TCPServerInterface",
      iface: new TCPServerInterface({ port: 0 }),
      expected: 10000000, // TCPServerInterface.BITRATE_GUESS
    },
    {
      name: "LocalClientInterface",
      iface: new LocalClientInterface({ port: 1 }),
      expected: 1000000000, // RNS.Interfaces.LocalInterface (1 Gbit/s)
    },
    {
      name: "WebSocketClientInterface",
      iface: new WebSocketClientInterface({ url: "ws://example/" }),
      expected: 10000000, // JS-specific; TCP-backed, same guess as TCP
    },
    {
      name: "WebSocketServerInterface",
      iface: new WebSocketServerInterface({ listenPort: 0 }),
      expected: 10000000,
    },
    {
      name: "AutoInterfacePeer",
      iface: new AutoInterfacePeer({
        parent: /** @type {any} */ ({}),
        address: "::1",
        ifname: "lo",
      }),
      expected: 10000000, // AutoInterface.BITRATE_GUESS
    },
    {
      name: "HttpPostClientInterface",
      iface: new HttpPostClientInterface({ baseUrl: "http://example/" }),
      expected: 1000000, // JS-specific; conservative for base64/JSON HTTP
    },
    {
      name: "HttpPostServerInterface",
      iface: new HttpPostServerInterface({ listenPort: 0 }),
      expected: 1000000,
    },
    {
      name: "HttpPostPeerInterface",
      iface: new HttpPostPeerInterface({
        interfaceId: "iface-deadbeef",
        sessionToken: "sess-x",
      }),
      expected: 1000000,
    },
  ];

  for (const { name, iface, expected } of cases) {
    assert.equal(
      iface.bitrate,
      expected,
      `${name} should declare bitrate ${expected}`,
    );
  }
});

test("TCPServer spawns clients that inherit its bitrate", async () => {
  const server = new TCPServerInterface({ port: 0 });
  // Custom rate to prove inheritance rather than a hardcoded default.
  server.bitrate = 4200000;
  await server.connect();
  const port = /** @type {any} */ (server.server).address().port;

  const spawned = new Promise((resolve) => {
    server.addEventListener("connection", (event) => resolve(event.detail));
  });

  const client = new TCPClientInterface({ host: "127.0.0.1", port });
  await client.connect();

  const spawnedClient = /** @type {TCPClientInterface} */ (await spawned);
  assert.equal(
    spawnedClient.bitrate,
    4200000,
    "spawned client must inherit the server's bitrate",
  );

  await client.disconnect();
  await server.disconnect();
});
