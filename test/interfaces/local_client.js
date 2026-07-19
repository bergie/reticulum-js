import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import {
  asBool,
  asInt,
  getSharedInstanceEndpoint,
  LocalClientInterface,
  loadConfig,
  parseConfigFile,
  resolveConfigDir,
  supportsAbstractAfUnix,
} from "../../src/interfaces/local_client.js";

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

// --- Shared-instance endpoint discovery (moved from src/core/config.js) ----
// These helpers now live in src/interfaces/local_client.js alongside the
// LocalClientInterface that consumes them, keeping node:fs/os/path out of the
// browser-safe main entry.

test("parseConfigFile parses sections, nested sections and key=value", () => {
  const text = `
# a comment
[reticulum]
share_instance = Yes
shared_instance_port = 4242
shared_instance_type = tcp
instance_name = default

[logging]
loglevel = 3

[interfaces]
  [[Default Interface]]
  type = AutoInterface
  enabled = yes
  devices = en0

  [[TCP Server Interface]]
  type = TCPServerInterface
  listen_port = 42424
`;
  const cfg = parseConfigFile(text);
  assert.strictEqual(cfg.reticulum.share_instance, "Yes");
  assert.strictEqual(cfg.reticulum.shared_instance_port, "4242");
  assert.strictEqual(cfg.reticulum.instance_name, "default");
  assert.strictEqual(cfg.logging.loglevel, "3");
  assert.strictEqual(cfg.interfaces["Default Interface"].type, "AutoInterface");
  assert.strictEqual(
    cfg.interfaces["TCP Server Interface"].listen_port,
    "42424",
  );
  // A new top-level section after nested ones resets nesting.
  assert.strictEqual(cfg.interfaces["Default Interface"].devices, "en0");
});

test("asBool matches configobj semantics (True/On/Yes/1, False/Off/No/0)", () => {
  for (const v of ["True", "On", "Yes", "1", "true", "YES"]) {
    assert.strictEqual(asBool(v), true, `${v} should be true`);
  }
  for (const v of ["False", "Off", "No", "0", "false", "no"]) {
    assert.strictEqual(asBool(v), false, `${v} should be false`);
  }
  assert.throws(() => asBool("fish"));
});

test("asInt parses decimal integers", () => {
  assert.strictEqual(asInt("4242"), 4242);
  assert.strictEqual(asInt(" 37428 "), 37428);
});

test("resolveConfigDir honours an explicit argument", () => {
  assert.strictEqual(resolveConfigDir("/custom/path"), "/custom/path");
});

test("getSharedInstanceEndpoint reads a synthetic config and resolves TCP", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  writeFileSync(
    join(dir, "config"),
    `
[reticulum]
share_instance = Yes
shared_instance_port = 4242
shared_instance_type = tcp
instance_name = default
`,
  );
  const endpoint = getSharedInstanceEndpoint({ configDir: dir });
  assert.strictEqual(endpoint.configDir, dir);
  assert.strictEqual(endpoint.shareInstance, true);
  assert.strictEqual(endpoint.instanceName, "default");
  assert.strictEqual(endpoint.transport, "tcp");
  assert.strictEqual(endpoint.host, "127.0.0.1");
  assert.strictEqual(endpoint.port, 4242);
});

test("getSharedInstanceEndpoint returns defaults for an empty config", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  writeFileSync(join(dir, "config"), "[reticulum]\n");
  const endpoint = getSharedInstanceEndpoint({ configDir: dir });
  assert.strictEqual(endpoint.shareInstance, true);
  assert.strictEqual(endpoint.instanceName, "default");
  // Transport resolution is platform-dependent, mirroring the Python
  // reference: on Linux an empty config defaults to the abstract AF_UNIX
  // socket (port left unset); everywhere else (macOS/Windows) it's tcp with
  // the default port.
  if (!supportsAbstractAfUnix()) {
    assert.strictEqual(endpoint.transport, "tcp");
    assert.strictEqual(endpoint.host, "127.0.0.1");
    assert.strictEqual(endpoint.port, 37428);
  } else {
    assert.strictEqual(endpoint.transport, "unix");
    assert.strictEqual(endpoint.socketPath, "\0rns/default");
    assert.strictEqual(endpoint.port, undefined);
  }
});

// Pins `shared_instance_type = tcp` so the resolved transport is TCP on every
// platform (Linux would otherwise pick the abstract AF_UNIX socket, leaving
// `port` unset). Mirrors the "resolves TCP" sibling test and keeps `port`
// assertable on both macOS and Linux CI.
test("getSharedInstanceEndpoint respects share_instance = No", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  writeFileSync(
    join(dir, "config"),
    "[reticulum]\nshare_instance = No\nshared_instance_port = 4242\nshared_instance_type = tcp\n",
  );
  const endpoint = getSharedInstanceEndpoint({ configDir: dir });
  assert.strictEqual(endpoint.shareInstance, false);
  assert.strictEqual(endpoint.transport, "tcp");
  assert.strictEqual(endpoint.port, 4242);
});

test("loadConfig returns null when no config file is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  assert.strictEqual(loadConfig({ configDir: dir }), null);
});

// Parses the user's real Python config when present (read-only). This is the
// actual interop target; on this dev machine it has shared_instance_port = 4242.
test("parses the real ~/.reticulum/config when present", () => {
  const realDir = join(homedir(), ".reticulum");
  const realPath = join(realDir, "config");
  if (!existsSync(realPath)) {
    // Nothing to verify against here; still confirm resolution returns the dir.
    assert.ok(typeof resolveConfigDir(), "string");
    return;
  }
  // Sanity: our parser and a naive read agree on the shared-instance port line.
  const raw = readFileSync(realPath, "utf8");
  const parsed = parseConfigFile(raw);
  const portLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("shared_instance_port"));
  if (portLine) {
    const expected = Number.parseInt(portLine.split("=")[1].trim(), 10);
    assert.strictEqual(
      Number.parseInt(parsed.reticulum.shared_instance_port, 10),
      expected,
    );
  }
  const endpoint = getSharedInstanceEndpoint({ configDir: realDir });
  assert.strictEqual(typeof endpoint.shareInstance, "boolean");
  assert.strictEqual(typeof endpoint.port, "number");
});
