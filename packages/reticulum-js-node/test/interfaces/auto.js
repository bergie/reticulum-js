import assert from "node:assert";
import dgram from "node:dgram";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "reticulum-js/src/core/packet.js";
import { TransportCore } from "reticulum-js/src/transport/transport.js";
import { toHex } from "reticulum-js/src/utils/encoding.js";
import {
  AutoInterface,
  computeDiscoveryAddress,
  computeDiscoveryToken,
} from "../../src/interfaces/auto.js";
import { AutoInterfacePeer } from "../../src/interfaces/auto_peer.js";
import {
  AF_INET6,
  listAddresses,
  listInterfaces,
} from "../../src/utils/netinfo.js";

/**
 * Builds a minimal DATA packet with a text payload, for data-path tests.
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
 * Finds a loopback interface carrying the link-local address fe80::1 (lo0 on
 * macOS, lo on Linux when configured). The real end-to-end discovery tests use
 * it: two sockets on the same host share fe80::1, so we drive discovery from a
 * distinct source (::1) routed to it. Returns null when unavailable, in which
 * case those tests self-skip.
 * @returns {{ name: string; ll: string } | null}
 */
function findLoopback() {
  for (const name of listInterfaces()) {
    const v6 = listAddresses(name)[AF_INET6];
    if (!v6) continue;
    for (const a of v6) {
      if (a.addr === "fe80::1") return { name, ll: "fe80::1" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic derivation, verified against the Python reference.
// ---------------------------------------------------------------------------

test("computeDiscoveryAddress matches the Python reference for the default group", async () => {
  const groupId = new TextEncoder().encode("reticulum");
  // Computed from RNS.Identity.full_hash(b"reticulum") in the Python reference.
  assert.strictEqual(
    await computeDiscoveryAddress({ groupId }),
    "ff12:0:d70b:fb1c:16e4:5e39:485e:31e1",
  );
});

test("computeDiscoveryAddress honours scope and address-type nibbles", async () => {
  const groupId = new TextEncoder().encode("reticulum");
  // Site scope + permanent address type → ff05 prefix.
  assert.strictEqual(
    await computeDiscoveryAddress({
      groupId,
      scope: "5",
      multicastAddressType: "permanent",
    }),
    "ff05:0:d70b:fb1c:16e4:5e39:485e:31e1",
  );
});

test("computeDiscoveryToken matches the Python reference", async () => {
  const groupId = new TextEncoder().encode("reticulum");
  // full_hash(b"reticulum" + addr) from the Python reference:
  assert.strictEqual(
    toHex(await computeDiscoveryToken(groupId, "fe80::1")),
    "97b25576749ea936b0d8a8536ffaf442d157cf47d460dcf13c48b7bd18b6c163",
  );
  assert.strictEqual(
    toHex(await computeDiscoveryToken(groupId, "fe80::4b2:6c0b:c18f:272a")),
    "2c9285e95c57446a93fa82ba130425bc515fb796b1d33786ce731035131576ae",
  );
});

test("the discovery token is a full 32-byte SHA-256", async () => {
  const groupId = new TextEncoder().encode("reticulum");
  const token = await computeDiscoveryToken(groupId, "fe80::1");
  assert.strictEqual(token.length, 32);
});

// ---------------------------------------------------------------------------
// Interface adoption filtering (mirrors Python's per-interface skip chain).
// ---------------------------------------------------------------------------

test("adoption: allowed device bypasses the ignore lists (incl. loopback)", () => {
  const iface = new AutoInterface({ devices: ["lo0"] });
  assert.strictEqual(iface._isAdoptable("lo0"), true);
});

test("adoption: loopback is skipped unless explicitly allowed", () => {
  const iface = new AutoInterface();
  assert.strictEqual(iface._isAdoptable("lo0"), false);
  assert.strictEqual(iface._isAdoptable("lo"), false);
});

test("adoption: ignoredDevices and darwin ignores are respected", () => {
  const iface = new AutoInterface({ ignoredDevices: ["en7"] });
  assert.strictEqual(iface._isAdoptable("en7"), false);
  // awdl0 is in DARWIN_IGNORE_IFS and not allowed → skipped.
  if (process.platform === "darwin") {
    assert.strictEqual(iface._isAdoptable("awdl0"), false);
  }
});

test("adoption: a normal interface is adoptable by default", () => {
  const iface = new AutoInterface();
  assert.strictEqual(iface._isAdoptable("en42"), true);
});

// ---------------------------------------------------------------------------
// Peer tracking logic (addPeer / refreshPeer / self-echo).
// ---------------------------------------------------------------------------

test("addPeer spawns a peer and dispatches a 'connection' event", () => {
  const iface = new AutoInterface();
  iface.online = true;
  /** @type {any} */
  let seen = null;
  iface.addEventListener("connection", (/** @type {any} */ e) => {
    seen = e.detail;
  });
  iface.addPeer("fe80::abcd", "en0");
  assert.ok(seen, "a connection event fired");
  assert.strictEqual(seen.address, "fe80::abcd");
  assert.strictEqual(seen.ifname, "en0");
  assert.strictEqual(iface.peerCount, 1);
  assert.ok(iface.spawnedInterfaces["fe80::abcd"], "peer was spawned");
});

test("addPeer on a known peer refreshes it without a new event", () => {
  const iface = new AutoInterface();
  iface.online = true;
  let events = 0;
  iface.addEventListener("connection", () => events++);
  iface.addPeer("fe80::abcd", "en0");
  // Force an older lastHeard so refreshPeer is observable at second resolution.
  iface.peers["fe80::abcd"].lastHeard -= 10;
  iface.addPeer("fe80::abcd", "en0");
  assert.strictEqual(events, 1);
  assert.strictEqual(iface.peerCount, 1);
});

test("addPeer treats our own link-local as a multicast echo, not a peer", () => {
  const iface = new AutoInterface();
  iface.online = true;
  iface.linkLocalAddresses.push("fe80::1");
  iface.adoptedInterfaces.lo0 = "fe80::1";
  let events = 0;
  iface.addEventListener("connection", () => events++);
  iface.addPeer("fe80::1", "lo0");
  assert.strictEqual(events, 0);
  assert.strictEqual(iface.peerCount, 0);
  assert.strictEqual(typeof iface.multicastEchoes.lo0, "number");
  assert.strictEqual(typeof iface.initialEchoes.lo0, "number");
});

test("_onDiscoveryMessage authenticates a valid token and adds the peer", async () => {
  const groupId = new TextEncoder().encode("reticulum");
  const iface = new AutoInterface({ groupId: "reticulum" });
  iface.online = true;
  /** @type {any} */
  let seen = null;
  iface.addEventListener(
    "connection",
    (/** @type {any} */ e) => (seen = e.detail),
  );

  const token = await computeDiscoveryToken(groupId, "fe80::dead:beef");
  await iface._onDiscoveryMessage(
    token,
    { address: "fe80::dead:beef", port: 1 },
    "en0",
  );
  assert.ok(seen);
  assert.strictEqual(seen.address, "fe80::dead:beef");
});

test("_onDiscoveryMessage rejects a token with a wrong source address", async () => {
  const groupId = new TextEncoder().encode("reticulum");
  const iface = new AutoInterface({ groupId: "reticulum" });
  iface.online = true;
  let seen = null;
  iface.addEventListener(
    "connection",
    (/** @type {any} */ e) => (seen = e.detail),
  );

  // Valid token for fe80::1, but claims to arrive from a different source.
  const token = await computeDiscoveryToken(groupId, "fe80::1");
  await iface._onDiscoveryMessage(
    token,
    { address: "fe80::9999", port: 1 },
    "en0",
  );
  assert.strictEqual(seen, null);
  assert.strictEqual(iface.peerCount, 0);
});

test("_onDiscoveryMessage rejects a too-short / bogus datagram", async () => {
  const iface = new AutoInterface({ groupId: "reticulum" });
  iface.online = true;
  let events = 0;
  iface.addEventListener("connection", () => events++);
  await iface._onDiscoveryMessage(
    new Uint8Array([1, 2, 3]),
    { address: "fe80::1", port: 1 },
    "en0",
  );
  assert.strictEqual(events, 0);
});

test("_onDiscoveryMessage descopes a `%scope` source address before hashing", async () => {
  // Node reports link-local sources WITH a `%scope` suffix; peers compute the
  // token over the bare address. A token for the bare address must still
  // authenticate when the datagram arrives as `fe80::abcd%en0`.
  const groupId = new TextEncoder().encode("reticulum");
  const iface = new AutoInterface({ groupId: "reticulum" });
  iface.online = true;
  /** @type {any} */
  let seen = null;
  iface.addEventListener(
    "connection",
    (/** @type {any} */ e) => (seen = e.detail),
  );

  const token = await computeDiscoveryToken(groupId, "fe80::abcd");
  await iface._onDiscoveryMessage(
    token,
    { address: "fe80::abcd%en0", port: 1 },
    "en0",
  );
  assert.ok(seen);
  assert.strictEqual(seen.address, "fe80::abcd");
});

// ---------------------------------------------------------------------------
// Real end-to-end discovery over actual dgram sockets (loopback only).
// ---------------------------------------------------------------------------

test("real discovery: a unicast token from ::1 adds ::1 as a peer", async (t) => {
  const loopback = findLoopback();
  if (!loopback) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  // Use a non-default discovery port so we never collide with a running rnsd.
  const discoveryPort = 39201;
  const unicastPort = discoveryPort + 1;
  const iface = new AutoInterface({
    name: "auto-test",
    groupId: "reticulum",
    devices: [loopback.name],
    discoveryPort,
    announceInterval: 0.2,
  });
  await iface.connect();

  try {
    assert.ok(iface.isOpen);
    assert.strictEqual(iface.adoptedInterfaces[loopback.name], "fe80::1");

    const seen = new Promise((resolve) => {
      iface.addEventListener("connection", (/** @type {any} */ e) =>
        resolve(e.detail),
      );
    });

    // Send a valid token for source ::1 to the unicast discovery socket. ::1 is
    // a distinct address from our own fe80::1, so the receiver authenticates it
    // and adds ::1 as a peer (proven deliverable lo0 ::1 → fe80::1%lo0).
    const groupId = new TextEncoder().encode("reticulum");
    const token = await computeDiscoveryToken(groupId, "::1");
    const sender = dgram.createSocket({ type: "udp6" });
    await new Promise((res) => sender.on("listening", res).bind(0, "::1"));
    await new Promise((res) =>
      sender.send(
        Buffer.from(token),
        unicastPort,
        `fe80::1%${loopback.name}`,
        () => res(),
      ),
    );

    const detail = await Promise.race([
      seen,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("connection event timed out")), 1500),
      ),
    ]);
    sender.close();
    assert.strictEqual(detail.address, "::1");
    assert.strictEqual(detail.ifname, loopback.name);
  } finally {
    await iface.disconnect();
  }
});

test("real discovery: a bogus unicast token adds no peer", async (t) => {
  const loopback = findLoopback();
  if (!loopback) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const discoveryPort = 39203;
  const unicastPort = discoveryPort + 1;
  const iface = new AutoInterface({
    name: "auto-test-bogus",
    groupId: "reticulum",
    devices: [loopback.name],
    discoveryPort,
    announceInterval: 0.2,
  });
  await iface.connect();

  try {
    const sender = dgram.createSocket({ type: "udp6" });
    await new Promise((res) => sender.on("listening", res).bind(0, "::1"));
    await new Promise((res) =>
      sender.send(
        Buffer.alloc(32, 0xff), // 32 bytes of garbage, correct length
        unicastPort,
        `fe80::1%${loopback.name}`,
        () => res(),
      ),
    );
    sender.close();
    // Give the handler time to process and (not) fire.
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(iface.peerCount, 0);
  } finally {
    await iface.disconnect();
  }
});

test("real discovery: multicast announce is receivable by a peer listener", async (t) => {
  const loopback = findLoopback();
  if (!loopback) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const groupId = new TextEncoder().encode("reticulum");
  const mcastAddr = await computeDiscoveryAddress({ groupId });
  const discoveryPort = 39205;

  const iface = new AutoInterface({
    name: "auto-test-mcast",
    groupId: "reticulum",
    devices: [loopback.name],
    discoveryPort,
    announceInterval: 0.15,
  });
  await iface.connect();

  // A standalone listener joins the group on loopback and waits for the
  // announce token. It must equal SHA-256(group || fe80::1).
  const listener = dgram.createSocket({ type: "udp6", reuseAddr: true });
  await new Promise((res, rej) => {
    listener.once("error", rej);
    listener.on("listening", res);
    listener.bind(discoveryPort, "::");
  });
  listener.addMembership(mcastAddr, `fe80::1%${loopback.name}`);
  listener.setMulticastLoopback(true);

  try {
    const expectedToken = await computeDiscoveryToken(groupId, "fe80::1");
    const received = new Promise((resolve, reject) => {
      listener.on("message", (/** @type {Buffer} */ msg) => resolve(msg));
      setTimeout(
        () => reject(new Error("no multicast announce received")),
        2000,
      );
    });
    const msg = await received;
    assert.strictEqual(msg.length, 32);
    assert.strictEqual(toHex(new Uint8Array(msg)), toHex(expectedToken));
  } finally {
    await iface.disconnect();
    await new Promise((res) => listener.close(() => res()));
  }
});

// ---------------------------------------------------------------------------
// Phase 2: data path (AutoInterfacePeer) over real loopback sockets, plus
// dedup and transport auto-registration.
// ---------------------------------------------------------------------------

/** @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import("node:dgram").Socket} sock
 * @param {number} port
 * @param {string} addr
 * @returns {Promise<void>}
 */
function bindUdp(sock, port, addr) {
  return new Promise((res, rej) => {
    sock.once("error", rej);
    sock.on("listening", () => {
      sock.off("error", rej);
      res();
    });
    sock.bind(port, addr);
  });
}

/**
 * @param {import("node:dgram").Socket} sock
 * @param {Uint8Array | Buffer} data
 * @param {number} port
 * @param {string} addr
 * @returns {Promise<void>}
 */
function sendUdp(sock, data, port, addr) {
  return new Promise((res, rej) =>
    sock.send(data, port, addr, (e) => (e ? rej(e) : res())),
  );
}

/** @returns {Promise<never>} */
const rejectAfter = (ms, msg) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

/**
 * Spins up a loopback-connected AutoInterface with a spawned peer for the
 * distinct source `::1`, so the data path can be exercised on a single host.
 * Returns null (and the caller skips) when loopback fe80::1 is unavailable.
 * @param {string} label
 * @param {number} discoveryPort
 * @param {number} dataPort
 * @returns {Promise<{ iface: AutoInterface; peer: AutoInterfacePeer; loopback: { name: string; ll: string } } | null>}
 */
async function setupLoopbackPeer(label, discoveryPort, dataPort) {
  const loopback = findLoopback();
  if (!loopback) return null;
  const iface = new AutoInterface({
    name: label,
    groupId: "reticulum",
    devices: [loopback.name],
    discoveryPort,
    dataPort,
    announceInterval: 5, // quiet; these tests drive the data path directly
  });
  await iface.connect();
  iface.addPeer("::1", loopback.name);
  const peer = iface.spawnedInterfaces["::1"];
  return { iface, peer, loopback };
}

test("data path: an outbound packet is serialized and delivered over UDP", async (t) => {
  const setup = await setupLoopbackPeer("auto-data-out", 39221, 39481);
  if (!setup) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const { iface, peer } = setup;
  // Listener bound to ::1:dataPort stands in for the peer's data receiver.
  const listener = dgram.createSocket({ type: "udp6", reuseAddr: true });
  await bindUdp(listener, 39481, "::1");
  try {
    const got = new Promise((resolve) =>
      listener.on("message", (/** @type {Buffer} */ msg) => resolve(msg)),
    );
    const writer = peer.writable.getWriter();
    await writer.write(makePacket("hello-data"));
    writer.releaseLock();

    const raw = await Promise.race([
      got,
      rejectAfter(1500, "outbound packet not received"),
    ]);
    const pkt = Packet.deserialize(new Uint8Array(raw));
    assert.strictEqual(new TextDecoder().decode(pkt.payload), "hello-data");
  } finally {
    await new Promise((res) => listener.close(() => res()));
    await iface.disconnect();
  }
});

test("data path: an inbound datagram is deserialized and dispatched as 'packet'", async (t) => {
  const setup = await setupLoopbackPeer("auto-data-in", 39223, 39483);
  if (!setup) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const { iface, peer, loopback } = setup;
  const sender = dgram.createSocket({ type: "udp6" });
  await bindUdp(sender, 0, "::1");
  try {
    const got = new Promise((resolve) =>
      peer.addEventListener("packet", (/** @type {any} */ e) =>
        resolve(e.detail.packet),
      ),
    );
    const raw = makePacket("inbound-hello").serialize();
    await sendUdp(sender, raw, 39483, `fe80::1%${loopback.name}`);

    const pkt = await Promise.race([
      got,
      rejectAfter(1500, "inbound packet not dispatched"),
    ]);
    assert.strictEqual(new TextDecoder().decode(pkt.payload), "inbound-hello");
  } finally {
    sender.close();
    await iface.disconnect();
  }
});

test("data path: a repeated inbound datagram is dropped by the dedup deque", async (t) => {
  const setup = await setupLoopbackPeer("auto-data-dedup", 39225, 39485);
  if (!setup) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const { iface, peer, loopback } = setup;
  const sender = dgram.createSocket({ type: "udp6" });
  await bindUdp(sender, 0, "::1");
  try {
    let count = 0;
    peer.addEventListener("packet", () => count++);

    const raw = makePacket("dedup-me").serialize();
    await sendUdp(sender, raw, 39485, `fe80::1%${loopback.name}`);
    // Wait for the first to be fully processed (hash remembered) before
    // re-sending the identical bytes.
    await sleep(150);
    await sendUdp(sender, raw, 39485, `fe80::1%${loopback.name}`);
    await sleep(300);

    assert.strictEqual(count, 1);
  } finally {
    sender.close();
    await iface.disconnect();
  }
});

test("data path: a different inbound datagram is NOT dropped by the dedup deque", async (t) => {
  const setup = await setupLoopbackPeer("auto-data-nodedup", 39227, 39487);
  if (!setup) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const { iface, peer, loopback } = setup;
  const sender = dgram.createSocket({ type: "udp6" });
  await bindUdp(sender, 0, "::1");
  try {
    let count = 0;
    peer.addEventListener("packet", () => count++);

    await sendUdp(
      sender,
      makePacket("first").serialize(),
      39487,
      `fe80::1%${loopback.name}`,
    );
    await sendUdp(
      sender,
      makePacket("second").serialize(),
      39487,
      `fe80::1%${loopback.name}`,
    );
    await sleep(300);

    assert.strictEqual(count, 2);
  } finally {
    sender.close();
    await iface.disconnect();
  }
});

test("attachTransport auto-registers spawned peers, before and after attach", () => {
  const iface = new AutoInterface();
  iface.online = true;

  // Peer spawned BEFORE the transport is attached.
  iface.addPeer("fe80::aaaa", "en0");
  const peerA = iface.spawnedInterfaces["fe80::aaaa"];

  const transport = new TransportCore();
  transport.addInterface(iface); // triggers attachTransport on the iface
  assert.ok(
    transport.interfaces.has(peerA),
    "peer spawned before attach is registered",
  );
  assert.ok(transport.interfaces.has(iface), "parent iface is registered");

  // Peer spawned AFTER the transport is attached.
  iface.addPeer("fe80::bbbb", "en0");
  const peerB = iface.spawnedInterfaces["fe80::bbbb"];
  assert.ok(
    transport.interfaces.has(peerB),
    "peer spawned after attach is registered immediately",
  );
  assert.strictEqual(iface.peerCount, 2);
});

test("_onData routes an inbound datagram to the spawned peer after descoping the source", async () => {
  // Real peers send from link-local sources that Node reports WITH a `%scope`
  // suffix even on the (unicast) data socket. _onData must descope before the
  // spawned-interfaces lookup. We exercise that directly, without sockets.
  const iface = new AutoInterface();
  iface.online = true;
  iface.addPeer("fe80::abcd", "en0");
  const peer = iface.spawnedInterfaces["fe80::abcd"];

  const got = new Promise((resolve) =>
    peer.addEventListener("packet", (/** @type {any} */ e) =>
      resolve(e.detail.packet),
    ),
  );
  const raw = makePacket("routed-payload").serialize();
  iface._onData(raw, { address: "fe80::abcd%en0", port: 999 });

  const pkt = await Promise.race([
    got,
    rejectAfter(1000, "_onData did not route to the peer"),
  ]);
  assert.strictEqual(new TextDecoder().decode(pkt.payload), "routed-payload");
});

// ---------------------------------------------------------------------------
// Phase 3: lifecycle jobs (peer expiry, reverse-peering send, link-local
// rebind, multicast-echo watchdog).
// ---------------------------------------------------------------------------

test("peer jobs: a silent peer expires and its spawned interface is torn down", async () => {
  const iface = new AutoInterface({ peeringTimeout: 1 });
  iface.online = true;
  iface.addPeer("fe80::abcd", "en0");
  const peer = iface.spawnedInterfaces["fe80::abcd"];
  assert.ok(peer);
  // Make it silent for longer than peeringTimeout.
  iface.peers["fe80::abcd"].lastHeard = iface._now() - 100;
  await iface._runPeerJobs();
  assert.strictEqual(iface.peerCount, 0);
  assert.ok(!iface.spawnedInterfaces["fe80::abcd"], "spawned peer removed");
  assert.strictEqual(peer.online, false, "spawned peer was disconnected");
});

test("peer jobs: a recently-heard peer is NOT expired", async () => {
  const iface = new AutoInterface({ peeringTimeout: 22 });
  iface.online = true;
  iface.addPeer("fe80::abcd", "en0");
  await iface._runPeerJobs();
  assert.strictEqual(iface.peerCount, 1);
  assert.ok(iface.spawnedInterfaces["fe80::abcd"]);
  await iface.spawnedInterfaces["fe80::abcd"].disconnect();
});

test("peer jobs: sends a reverse-peering packet to a due peer", async (t) => {
  const loopback = findLoopback();
  if (!loopback) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const discoveryPort = 39231;
  const unicastPort = discoveryPort + 1;
  const iface = new AutoInterface({
    name: "auto-rp",
    groupId: "reticulum",
    devices: [loopback.name],
    discoveryPort,
    announceInterval: 5,
    peerJobInterval: 60, // keep the background loop quiet during the test
    reversePeeringInterval: 0,
  });
  await iface.connect();
  iface.addPeer("::1", loopback.name);
  iface.peers["::1"].lastOutbound = iface._now() - 1000;

  const listener = dgram.createSocket({ type: "udp6", reuseAddr: true });
  await bindUdp(listener, unicastPort, "::1");
  try {
    const got = new Promise((resolve) =>
      listener.on("message", (/** @type {Buffer} */ msg) => resolve(msg)),
    );
    await iface._runPeerJobs();
    const msg = await Promise.race([
      got,
      rejectAfter(1500, "no reverse-peering packet received"),
    ]);
    const expected = await computeDiscoveryToken(
      new TextEncoder().encode("reticulum"),
      "fe80::1",
    );
    assert.strictEqual(toHex(new Uint8Array(msg)), toHex(expected));
  } finally {
    await new Promise((res) => listener.close(() => res()));
    await iface.disconnect();
  }
});

test("peer jobs: rebinds the data socket when the link-local address changes", async (t) => {
  const loopback = findLoopback();
  if (!loopback) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const iface = new AutoInterface({
    name: "auto-rebind",
    groupId: "reticulum",
    devices: [loopback.name],
    discoveryPort: 39233,
    dataPort: 39493,
    announceInterval: 5,
    peerJobInterval: 60,
  });
  await iface.connect();
  const before = iface.dataSockets[loopback.name];

  // Simulate a stale adopted address: _checkLinkLocalChange sees the real
  // fe80::1 differ from the adopted value and rebinds.
  iface.adoptedInterfaces[loopback.name] = "fe80::dead:beef";
  iface._checkLinkLocalChange(loopback.name);
  await sleep(250); // rebind is fire-and-forget inside _checkLinkLocalChange

  const after = iface.dataSockets[loopback.name];
  assert.notStrictEqual(before, after, "data socket was rebound");
  assert.strictEqual(iface.adoptedInterfaces[loopback.name], "fe80::1");
  assert.ok(iface.linkLocalAddresses.includes("fe80::1"));
  assert.ok(iface.carrierChanged, "carrier-changed flag set on rebind");
  await iface.disconnect();
});

test("peer jobs: flags carrier lost when multicast echoes stop", () => {
  const iface = new AutoInterface({ multicastEchoTimeout: 1 });
  iface.online = true;
  iface.adoptedInterfaces.en0 = "fe80::1";
  iface.initialEchoes.en0 = iface._now(); // an echo was received at least once
  iface.multicastEchoes.en0 = iface._now() - 10; // then went stale
  iface._checkMulticastEcho("en0", iface._now());
  assert.strictEqual(iface.timedOutInterfaces.en0, true);
  assert.ok(iface.carrierChanged);
});

test("peer jobs: clears carrier-lost when multicast echoes resume", () => {
  const iface = new AutoInterface({ multicastEchoTimeout: 1 });
  iface.online = true;
  iface.adoptedInterfaces.en0 = "fe80::1";
  iface.initialEchoes.en0 = iface._now();
  iface.timedOutInterfaces.en0 = true; // was lost
  iface.carrierChanged = false;
  iface.multicastEchoes.en0 = iface._now(); // echoes resumed
  iface._checkMulticastEcho("en0", iface._now());
  assert.strictEqual(iface.timedOutInterfaces.en0, false);
  assert.ok(iface.carrierChanged, "recovery also flags carrier-changed");
});

test("connect starts the peer-jobs loop and disconnect stops it", async (t) => {
  const loopback = findLoopback();
  if (!loopback) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const iface = new AutoInterface({
    name: "auto-loop",
    groupId: "reticulum",
    devices: [loopback.name],
    discoveryPort: 39235,
    dataPort: 39495,
    announceInterval: 5,
    peerJobInterval: 60,
  });
  await iface.connect();
  assert.ok(iface._peerJobsTimer, "peer-jobs loop started");
  await iface.disconnect();
  assert.strictEqual(iface._peerJobsTimer, null, "peer-jobs loop stopped");
});

test("connect skips an interface whose data port is already held (no crash)", async (t) => {
  const loopback = findLoopback();
  if (!loopback) {
    t.skip("no loopback fe80::1 available on this host");
    return;
  }
  const discoveryPort = 39237;
  const dataPort = 39497;
  // Pre-hold the data port on the loopback link-local so AutoInterface's bind
  // fails mid-connect (mirrors running alongside a local rnsd on the same link).
  const squatter = dgram.createSocket({ type: "udp6" });
  await bindUdp(squatter, dataPort, "fe80::1%lo0");
  try {
    const iface = new AutoInterface({
      name: "auto-skip",
      groupId: "reticulum",
      devices: [loopback.name],
      discoveryPort,
      dataPort,
      announceInterval: 5,
      peerJobInterval: 60,
    });
    // Must NOT throw despite the bind conflict.
    await iface.connect();
    assert.strictEqual(iface.online, true, "came online despite the conflict");
    assert.ok(
      !iface.adoptedInterfaces[loopback.name],
      "contended interface was skipped",
    );
    assert.ok(
      !iface.dataSockets[loopback.name],
      "no leaked data socket for the skipped interface",
    );
    assert.ok(
      !iface.multicastSockets[loopback.name],
      "no leaked discovery sockets for the skipped interface",
    );
    await iface.disconnect();
  } finally {
    await new Promise((res) => squatter.close(() => res()));
  }
});
