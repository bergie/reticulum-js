import assert from "node:assert";
import net from "node:net";
import { test } from "node:test";
import {
  ContextType,
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "@reticulum/core/src/core/packet.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import {
  BackboneClientInterface,
  BackboneInterface,
  getFastFlappingState,
  resetFastFlappingState,
} from "../../src/interfaces/backbone.js";

/**
 * Builds a minimal valid DATA packet for stream round-trip tests.
 * @param {string} payload
 */
function buildTestPacket(payload) {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: ContextType.NONE,
    payload: new TextEncoder().encode(payload),
  });
}

/**
 * Resolves once `predicate` holds, rejecting after `ms` deadline.
 * @template T
 * @param {() => boolean} predicate
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
function waitFor(predicate, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve(undefined);
      if (Date.now() - started > ms)
        return reject(new Error("waitFor deadline exceeded"));
      setTimeout(check, 10);
    };
    check();
  });
}

test("backbone listener spawns clients that exchange packets over HDLC", async () => {
  const server = new BackboneInterface({ listenPort: 0 });
  await server.connect();
  assert.ok(server.isOpen);
  assert.strictEqual(
    server.bindPort,
    /** @type {any} */ (server.server).address().port,
    "ephemeral port should be reflected in bindPort",
  );

  const connectionPromise = new Promise((resolve) => {
    server.addEventListener("connection", (event) => resolve(event.detail));
  });

  const client = new BackboneClientInterface({
    host: "127.0.0.1",
    port: server.bindPort,
  });
  await client.connect();
  assert.ok(client.isOpen);

  const spawned = /** @type {BackboneClientInterface} */ (
    await connectionPromise
  );
  assert.ok(spawned, "listener should have spawned a client interface");
  assert.strictEqual(
    spawned.initiator,
    false,
    "spawned client never reconnects",
  );
  assert.strictEqual(server.clients, 1);
  assert.strictEqual(spawned.parentInterface, server);

  // Backbone profile: both sides run the 1 Gbit/s bitrate guess with MTU
  // autoconfiguration (bitrate >= 1 Gbit/s => 512 KiB HW MTU).
  assert.strictEqual(server.bitrate, 1_000_000_000);
  assert.strictEqual(spawned.bitrate, server.bitrate);
  assert.strictEqual(spawned.hwMtu, 524288);

  // Listener-side supportsDiscovery: backbone interfaces participate in
  // interface discovery (Python `supports_discovery`).
  assert.strictEqual(server.supportsDiscovery, true);

  // Client -> listener
  const writer = client.writable.getWriter();
  await writer.write(buildTestPacket("Hello backbone!"));
  writer.releaseLock();
  const received = await new Promise((resolve) => {
    spawned.addEventListener("packet", (event) => resolve(event.detail.packet));
  });
  assert.strictEqual(
    new TextDecoder().decode(received.payload),
    "Hello backbone!",
  );

  // Listener -> client
  const spawnedWriter = spawned.writable.getWriter();
  await spawnedWriter.write(buildTestPacket("Hello client!"));
  spawnedWriter.releaseLock();
  const echoed = await new Promise((resolve) => {
    client.addEventListener("packet", (event) => resolve(event.detail.packet));
  });
  assert.strictEqual(new TextDecoder().decode(echoed.payload), "Hello client!");

  await client.disconnect();
  await server.disconnect();
  assert.strictEqual(server.clients, 0);
});

test("backbone client defaults match the Python reference", () => {
  const client = new BackboneClientInterface({ host: "127.0.0.1", port: 1 });
  assert.strictEqual(client.autoReconnect, true);
  assert.strictEqual(client.reconnectWait, 5);
  assert.strictEqual(client.maxReconnectTries, Number.POSITIVE_INFINITY);
  assert.strictEqual(client.connectTimeout, 5);
  assert.strictEqual(client.initiator, true);
  // BackboneClientInterface.BITRATE_GUESS is 100 Mbit/s in the reference;
  // MTU autoconfiguration gives 16 KiB at that rate (the table is `>` 100M,
  // so exactly 100M falls to the next tier).
  assert.strictEqual(client.bitrate, 100_000_000);
  assert.strictEqual(client.hwMtu, 16384);
  // The Python reference caps the pre-autoconfiguration HW_MTU at 1 MiB.
  assert.strictEqual(
    BackboneInterface.getConfigurationSchema().title,
    "Backbone Interface",
  );
});

test("backbone listener requires a port", () => {
  assert.throws(() => new BackboneInterface({}), /No TCP port configured/);
  // The `port` alias is accepted, matching the Python config option.
  const server = new BackboneInterface({ port: 0 });
  assert.strictEqual(server.bindPort, 0);
});

test("backbone client reconnects after the remote end drops", async () => {
  const rawServer = net.createServer();
  /** @type {import('node:net').Socket[]} */
  const accepted = [];
  rawServer.on("connection", (socket) => {
    accepted.push(socket);
    // Drop only the first connection to force a reconnect.
    if (accepted.length === 1) {
      setImmediate(() => socket.destroy());
    }
  });
  await new Promise((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (
    rawServer.address()
  ).port;

  const client = new BackboneClientInterface({
    host: "127.0.0.1",
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

  await waitFor(() => connectCount >= 2);
  assert.ok(client.isOpen, "client should be back online");

  await client.disconnect();
  for (const s of accepted) s.destroy();
  await new Promise((resolve) => rawServer.close(resolve));
});

test("backbone listener-spawned client never reconnects on close", async () => {
  const server = new BackboneInterface({ listenPort: 0 });
  await server.connect();

  const connectionPromise = new Promise((resolve) => {
    server.addEventListener("connection", (event) => resolve(event.detail));
  });

  // Dial with a raw socket so we can drop it from the peer side.
  const dialer = net.createConnection({
    host: "127.0.0.1",
    port: server.bindPort,
  });
  await new Promise((resolve) => dialer.once("connect", resolve));

  const spawned = /** @type {BackboneClientInterface} */ (
    await connectionPromise
  );
  let closed = false;
  spawned.addEventListener("closed", () => {
    closed = true;
  });

  dialer.destroy();
  await waitFor(() => closed);
  assert.ok(closed, "spawned client fires closed on remote drop");
  assert.strictEqual(server.clients, 0, "spawned client is removed");

  await server.disconnect();
});

test("transport auto-registers listener-spawned backbone clients", async () => {
  const server = new BackboneInterface({ listenPort: 0 });
  await server.connect();

  const transport = new TransportCore();
  transport.addInterface(server, true);

  const client = new BackboneClientInterface({
    host: "127.0.0.1",
    port: server.bindPort,
  });
  await client.connect();

  // The spawned client is auto-registered via attachTransport (the Python
  // reference registers spawned interfaces with Transport at spawn time).
  await waitFor(() =>
    transport.interfaces.has(server.spawnedInterfaces.values().next().value),
  );
  assert.strictEqual(transport.interfaces.size, 2, "server + spawned client");

  await client.disconnect();
  await server.disconnect();
});

// ------------------------------------------------------------------
// Fast-flapping protection
// ------------------------------------------------------------------

test("fast-flapping connections are blocked after the grace count", async () => {
  resetFastFlappingState();
  const server = new BackboneInterface({
    listenPort: 0,
    fastFlappingThreshold: 20,
    fastFlappingGrace: 3,
    // Sub-minute expiry so the unblocking leg of the test completes fast.
    fastFlappingBlockTime: 0.02, // minutes => ~1.2 s
  });
  await server.connect();

  /** @type {Promise<void>[]} */
  const cleanups = [];
  /**
   * Dials, waits for the listener to spawn an interface, then drops the
   * connection immediately — a fast flap.
   * @returns {Promise<void>}
   */
  const flap = async () => {
    const spawnedPromise = new Promise((resolve) => {
      server.addEventListener("connection", (event) => resolve(event.detail), {
        once: true,
      });
    });
    const dialer = net.createConnection({
      host: "127.0.0.1",
      port: server.bindPort,
    });
    cleanups.push(new Promise((resolve) => dialer.once("close", resolve)));
    await spawnedPromise;
    dialer.destroy();
    // Let the spawned interface notice the drop and record the flap.
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  let connectionCount = 0;
  server.addEventListener("connection", () => {
    connectionCount++;
  });

  // Three flapping connections: flap counts 1..3, still within grace —
  // the reference blocks only once flaps exceed the grace count.
  for (let i = 0; i < 3; i++) {
    await flap();
  }
  assert.strictEqual(server.blockedIpCount, 0, "still within grace");
  const entry = getFastFlappingState().get("127.0.0.1");
  assert.ok(entry && entry[2] === 3, "flaps recorded under the remote IP");

  // The fourth flap pushes the count beyond grace: the IP is now blocked.
  await flap();
  assert.strictEqual(server.blockedIpCount, 1, "blocked after grace exceeded");

  // The next dial is refused: the listener destroys the socket before
  // spawning an interface.
  const before = connectionCount;
  const blockedDial = net.createConnection({
    host: "127.0.0.1",
    port: server.bindPort,
  });
  await new Promise((resolve) => {
    blockedDial.once("close", resolve);
    blockedDial.once("error", () => {});
  });
  assert.strictEqual(
    connectionCount,
    before,
    "blocked dial spawns no interface",
  );

  // After the (short) block time, connections are accepted again.
  await waitFor(() => server.blockedIpCount === 0, 5000);
  const freshDial = net.createConnection({
    host: "127.0.0.1",
    port: server.bindPort,
  });
  cleanups.push(new Promise((resolve) => freshDial.once("close", resolve)));
  await new Promise((resolve) => freshDial.once("connect", resolve));
  await new Promise((resolve) => {
    const check = () =>
      connectionCount >= before + 1 ? resolve() : setTimeout(check, 10);
    check();
  });

  freshDial.destroy();
  await Promise.all(cleanups);
  await server.disconnect();
  resetFastFlappingState();
}, 15000);

test("fast-flapping protection can be disabled", async () => {
  resetFastFlappingState();
  const server = new BackboneInterface({
    listenPort: 0,
    blockFastFlapping: false,
    fastFlappingThreshold: 20,
    fastFlappingGrace: 1,
  });
  await server.connect();
  assert.strictEqual(server.blockedIpList.length, 0);
  assert.strictEqual(server.blockedIpCount, 0);

  // Rapid flaps: with blocking disabled, connections keep being accepted.
  let connectionCount = 0;
  server.addEventListener("connection", () => {
    connectionCount++;
  });
  for (let i = 0; i < 3; i++) {
    const dialer = net.createConnection({
      host: "127.0.0.1",
      port: server.bindPort,
    });
    await new Promise((resolve) => dialer.once("connect", resolve));
    dialer.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(connectionCount, 3, "all flapping connections accepted");
  assert.strictEqual(server.blockedIpCount, 0);

  await server.disconnect();
  resetFastFlappingState();
});

// ------------------------------------------------------------------
// MTU autoconfiguration (optimiseMtu, work doc #34 / Python optimise_mtu)
// ------------------------------------------------------------------

test("optimiseMtu maps the Python reference bitrate table", async () => {
  const { Interface } = await import("@reticulum/core/src/interfaces/base.js");
  const cases = [
    [1_000_000_000, 524288],
    [1_500_000_000, 524288],
    [800_000_000, 262144],
    [500_000_000, 131072],
    [300_000_000, 65536],
    [150_000_000, 32768],
    [50_000_000, 16384],
    [7_000_000, 8192],
    [3_000_000, 4096],
    [1_500_000, 2048],
    [100_000, 1024],
    [62_500, null],
    [5, null],
  ];
  for (const [bitrate, expected] of cases) {
    const iface = new Interface();
    iface.name = `mtu-test-${bitrate}`;
    iface.autoconfigureMtu = true;
    iface.bitrate = bitrate;
    iface.optimiseMtu();
    assert.strictEqual(
      iface.hwMtu,
      expected,
      `bitrate ${bitrate} should give HW MTU ${expected}`,
    );
  }
  // Autoconfiguration off: no-op, keeps whatever the subclass set.
  const fixed = new Interface();
  fixed.bitrate = 1_000_000_000;
  fixed.hwMtu = 1234;
  fixed.optimiseMtu();
  assert.strictEqual(fixed.hwMtu, 1234);
});

test("backbone clients autoconfigure MTU from the inherited bitrate", async () => {
  const server = new BackboneInterface({ listenPort: 0 });
  await server.connect();
  const connectionPromise = new Promise((resolve) => {
    server.addEventListener("connection", (event) => resolve(event.detail));
  });
  const client = new BackboneClientInterface({
    host: "127.0.0.1",
    port: server.bindPort,
  });
  await client.connect();
  const spawned = /** @type {BackboneClientInterface} */ (
    await connectionPromise
  );
  // Parent's 1 Gbit/s guess flows to the spawned client, which re-runs MTU
  // autoconfiguration at the reference spawn site.
  assert.strictEqual(spawned.bitrate, 1_000_000_000);
  assert.strictEqual(spawned.hwMtu, 524288);

  await client.disconnect();
  await server.disconnect();
});

// ------------------------------------------------------------------
// Schema
// ------------------------------------------------------------------

test("backbone schemas document their options", async () => {
  const serverSchema = BackboneInterface.getConfigurationSchema();
  assert.strictEqual(serverSchema.title, "Backbone Interface");
  assert.ok(serverSchema.properties.listenIp);
  assert.ok(serverSchema.properties.listenPort);
  assert.ok(serverSchema.properties.port);
  assert.ok(serverSchema.properties.device);
  assert.ok(serverSchema.properties.preferIpv6);
  assert.ok(serverSchema.properties.blockFastFlapping);
  assert.ok(serverSchema.properties.fastFlappingThreshold);
  assert.ok(serverSchema.properties.fastFlappingGrace);
  assert.ok(serverSchema.properties.fastFlappingBlockTime);
  assert.deepStrictEqual(serverSchema.required, ["listenPort"]);

  const clientSchema = BackboneClientInterface.getConfigurationSchema();
  assert.strictEqual(clientSchema.title, "Backbone Client Interface");
  assert.ok(clientSchema.properties.host);
  assert.ok(clientSchema.properties.port);
  assert.ok(clientSchema.properties.preferIpv6);
  assert.ok(clientSchema.properties.autoReconnect);
  assert.deepStrictEqual(clientSchema.required, ["host", "port"]);
  // The internal `socket` adoption option is deliberately excluded.
  assert.ok(!clientSchema.properties.socket);

  // Every declared option carries a description (house schema rule).
  for (const schema of [serverSchema, clientSchema]) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      assert.ok(
        /** @type {any} */ (prop).description,
        `${schema.title}.${key} should have a description`,
      );
    }
  }
});

test("backbone interfaces are registered in the interface registry", async () => {
  const { getInterface } = await import("../../src/interfaces/registry.js");
  assert.strictEqual(getInterface("backbone"), BackboneInterface);
  assert.strictEqual(getInterface("backbone-client"), BackboneClientInterface);
});

// ------------------------------------------------------------------
// IFAC-protected backbone peering (round-trip through the seal/open path)
// ------------------------------------------------------------------

test("IFAC-protected backbone link drops packets from a non-IFAC peer", async () => {
  const server = new BackboneInterface({
    listenPort: 0,
    networkName: "interop-net",
    passphrase: "shared-secret",
  });
  await server.connect();

  const connectionPromise = new Promise((resolve) => {
    server.addEventListener("connection", (event) => resolve(event.detail));
  });

  // A matching client: the sealed packets pass IFAC verification on the
  // spawned interface.
  const client = new BackboneClientInterface({
    host: "127.0.0.1",
    port: server.bindPort,
    networkName: "interop-net",
    passphrase: "shared-secret",
  });
  await client.connect();
  const spawned = /** @type {BackboneClientInterface} */ (
    await connectionPromise
  );
  assert.strictEqual(spawned.ifacNetname, "interop-net");
  assert.strictEqual(spawned.ifacNetkey, "shared-secret");

  const writer = client.writable.getWriter();
  await writer.write(buildTestPacket("sealed hello"));
  writer.releaseLock();
  const received = await new Promise((resolve) => {
    spawned.addEventListener("packet", (event) => resolve(event.detail.packet));
  });
  assert.strictEqual(
    new TextDecoder().decode(received.payload),
    "sealed hello",
    "IFAC-sealed packets pass verification",
  );

  await client.disconnect();
  await server.disconnect();
});

test("backbone client keeps transmitting across a drop and reconnect", async () => {
  // Regression pattern from the TCP tests: after a reconnect, the transport
  // must still reach the remote end over the new connection.
  /** @type {import('node:net').Socket[]} */
  const accepted = [];
  let connectionCount = 0;
  const rawServer = net.createServer((socket) => {
    const connection = ++connectionCount;
    accepted.push(socket);
    socket.on("data", () => {
      // We only care that bytes flow again after the reconnect.
      if (connection === 2) socket.dataSeen = true;
    });
  });
  await new Promise((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import('node:net').AddressInfo} */ (
    rawServer.address()
  ).port;

  const client = new BackboneClientInterface({
    host: "127.0.0.1",
    port,
    reconnectWait: 0.05,
    connectTimeout: 2,
  });
  await client.connect();
  const transport = new TransportCore();
  transport.addInterface(client, true);

  try {
    const mkData = () =>
      new Packet({
        packetType: PacketType.DATA,
        destinationType: DestType.PLAIN,
        destinationHash: crypto.getRandomValues(new Uint8Array(16)),
        contextByte: ContextType.NONE,
        payload: new Uint8Array([1, 2, 3]),
      });

    // Pre-drop: the broadcast reaches rnsd over the first connection.
    transport.broadcast(mkData());
    await waitFor(() => connectionCount === 1 && accepted[0] != null);

    // Connectivity lost: rnsd drops our connection.
    accepted[0].destroy();
    await waitFor(() => connectionCount >= 2, "client should reconnect");
    assert.ok(client.isOpen, "client should be back online");

    // Connectivity regained: the transport must still reach rnsd over the new
    // connection. Regression: the stale packet writer used to leave the
    // interface permanently silenced for the transport.
    transport.broadcast(mkData());
    await waitFor(
      () => /** @type {any} */ (accepted[1]).dataSeen === true,
      "post-reconnect broadcast should arrive on the new connection",
    );
    assert.ok(
      /** @type {any} */ (accepted[1]).dataSeen === true,
      "post-reconnect broadcast should arrive on the new connection",
    );
  } finally {
    await client.disconnect();
    for (const s of accepted) s.destroy();
    await new Promise((resolve) => rawServer.close(resolve));
  }
});

test("backbone listener without a listenIp binds to all interfaces by default", async () => {
  const server = new BackboneInterface({ listenPort: 0 });
  assert.strictEqual(server.bindIp, "0.0.0.0");
  await server.connect();
  // The listener is reachable on loopback.
  const probe = net.createConnection({
    host: "127.0.0.1",
    port: server.bindPort,
  });
  await new Promise((resolve) => probe.once("connect", resolve));
  probe.destroy();
  await server.disconnect();
});

test("backbone interface stringifies like the Python reference", () => {
  const server = new BackboneInterface({
    name: "b1",
    listenIp: "127.0.0.1",
    listenPort: 4242,
  });
  assert.strictEqual(server.toString(), "BackboneInterface[b1/127.0.0.1:4242]");
  const client = new BackboneClientInterface({
    name: "c1",
    host: "127.0.0.1",
    port: 4242,
  });
  assert.strictEqual(client.toString(), "BackboneInterface[c1/127.0.0.1:4242]");
});
