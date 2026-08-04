import assert from "node:assert";
import dgram from "node:dgram";
import os from "node:os";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "@reticulum/core/src/core/packet.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { UDPInterface } from "../../src/interfaces/udp.js";
import {
  computeIPv4Broadcast,
  getBroadcastForInterface,
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
 * Reserves an ephemeral UDP port and releases it, for test interface binding.
 * @returns {Promise<number>}
 */
function getPort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type: "udp4" });
    s.on("error", reject);
    s.bind(0, "127.0.0.1", () => {
      const { port } = /** @type {import('node:dgram').AddressInfo} */ (
        s.address()
      );
      s.close(() => resolve(port));
    });
  });
}

/**
 * Finds the first non-internal IPv4 interface with a usable broadcast
 * address, for the real broadcast round-trip and `device` resolution tests.
 * Returns null in minimal/sandboxed environments, in which case those tests
 * self-skip.
 * @returns {{ name: string; broadcast: string } | null}
 */
function findBroadcastInterface() {
  const ni = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ni)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal && a.netmask) {
        const broadcast = computeIPv4Broadcast(a.address, a.netmask);
        return { name, broadcast };
      }
    }
  }
  return null;
}

const bcastIface = findBroadcastInterface();

// ------------------------------------------------------------------
// Broadcast-address computation (the netinfo helper UDPInterface relies on)
// ------------------------------------------------------------------

test("computeIPv4Broadcast computes the subnet broadcast address", () => {
  assert.strictEqual(
    computeIPv4Broadcast("192.168.1.10", "255.255.255.0"),
    "192.168.1.255",
  );
  assert.strictEqual(
    computeIPv4Broadcast("10.0.0.5", "255.255.0.0"),
    "10.0.255.255",
  );
  // Non-byte-aligned mask (/20).
  assert.strictEqual(
    computeIPv4Broadcast("172.16.5.20", "255.255.240.0"),
    "172.16.15.255",
  );
  // Tiny point-to-point subnet (/30).
  assert.strictEqual(
    computeIPv4Broadcast("192.168.1.10", "255.255.255.252"),
    "192.168.1.11",
  );
});

test("getBroadcastForInterface resolves an address for a real device", () => {
  if (!bcastIface) return; // no non-internal IPv4 iface in this environment
  const got = getBroadcastForInterface(bcastIface.name);
  assert.strictEqual(typeof got, "string");
  assert.strictEqual(got, bcastIface.broadcast);
});

// ------------------------------------------------------------------
// Configuration / option resolution
// ------------------------------------------------------------------

test("port seeds both listenPort and forwardPort", () => {
  const iface = new UDPInterface({
    listenIp: "127.0.0.1",
    forwardIp: "127.0.0.1",
    port: 4242,
  });
  assert.strictEqual(iface.listenPort, 4242);
  assert.strictEqual(iface.forwardPort, 4242);
  assert.ok(iface.receives);
  assert.ok(iface.forwards);
});

test("explicit listen/forward ports override the port shorthand", () => {
  const iface = new UDPInterface({
    listenIp: "127.0.0.1",
    listenPort: 1000,
    forwardIp: "127.0.0.1",
    forwardPort: 2000,
    port: 4242,
  });
  assert.strictEqual(iface.listenPort, 1000);
  assert.strictEqual(iface.forwardPort, 2000);
});

test("device resolves listenIp and forwardIp to the broadcast address", () => {
  if (!bcastIface) return;
  const expected = getBroadcastForInterface(bcastIface.name);
  const iface = new UDPInterface({ device: bcastIface.name, port: 4242 });
  assert.strictEqual(iface.listenIp, expected);
  assert.strictEqual(iface.forwardIp, expected);
  assert.strictEqual(iface.listenPort, 4242);
  assert.strictEqual(iface.forwardPort, 4242);
});

test("receive-only interface has a null writable", () => {
  const iface = new UDPInterface({ listenIp: "127.0.0.1", listenPort: 4242 });
  assert.ok(iface.receives);
  assert.ok(!iface.forwards);
  assert.strictEqual(iface.writable, null);
});

test("forward-only interface has a null readable", () => {
  const iface = new UDPInterface({ forwardIp: "127.0.0.1", forwardPort: 4242 });
  assert.ok(!iface.receives);
  assert.ok(iface.forwards);
  assert.strictEqual(iface.readable, null);
});

test("bitrate defaults to the 10 Mbit/s Python guess", () => {
  const iface = new UDPInterface({ forwardIp: "127.0.0.1", forwardPort: 4242 });
  assert.strictEqual(iface.bitrate, 10 * 1000 * 1000);
});

test("configuredBitrate overrides the guess", () => {
  const iface = new UDPInterface({
    forwardIp: "127.0.0.1",
    forwardPort: 4242,
    configuredBitrate: 123456,
  });
  assert.strictEqual(iface.bitrate, 123456);
});

// ------------------------------------------------------------------
// Data path: unicast bidirectional transfer (the core framing-less path)
// ------------------------------------------------------------------

test("UDP interface bidirectional packet transfer (unicast loopback)", async () => {
  const portA = await getPort();
  const portB = await getPort();

  const a = new UDPInterface({
    listenIp: "127.0.0.1",
    listenPort: portA,
    forwardIp: "127.0.0.1",
    forwardPort: portB,
    name: "udp-a",
  });
  const b = new UDPInterface({
    listenIp: "127.0.0.1",
    listenPort: portB,
    forwardIp: "127.0.0.1",
    forwardPort: portA,
    name: "udp-b",
  });

  let aConnected = false;
  let bConnected = false;
  a.addEventListener("connected", () => {
    aConnected = true;
  });
  b.addEventListener("connected", () => {
    bConnected = true;
  });
  await a.connect();
  await b.connect();
  assert.ok(aConnected);
  assert.ok(bConnected);
  assert.ok(a.isOpen);
  assert.ok(b.isOpen);

  const packet = makePacket("Hello over UDP!");

  // A -> B
  const bReceived = new Promise((resolve) => {
    b.addEventListener("packet", (event) => resolve(event.detail.packet), {
      once: true,
    });
  });
  const writerA = a.writable.getWriter();
  await writerA.write(packet);
  writerA.releaseLock();
  const fromA = await bReceived;
  assert.ok(fromA);
  assert.strictEqual(
    new TextDecoder().decode(fromA.payload),
    "Hello over UDP!",
  );

  // B -> A
  const aReceived = new Promise((resolve) => {
    a.addEventListener("packet", (event) => resolve(event.detail.packet), {
      once: true,
    });
  });
  const writerB = b.writable.getWriter();
  await writerB.write(packet);
  writerB.releaseLock();
  const fromB = await aReceived;
  assert.ok(fromB);
  assert.strictEqual(
    new TextDecoder().decode(fromB.payload),
    "Hello over UDP!",
  );

  // Statistics: each interface sent and received exactly one packet, so the
  // cumulative byte counters must equal one serialized packet length each.
  const wireLen = packet.serialize().length;
  assert.equal(a.txb, wireLen, "A should count its outbound packet");
  assert.equal(a.rxb, wireLen, "A should count its inbound packet");
  assert.equal(b.txb, wireLen, "B should count its outbound packet");
  assert.equal(b.rxb, wireLen, "B should count its inbound packet");
  const stats = a.getStats();
  assert.equal(stats.name, "udp-a");
  assert.equal(stats.online, true);
  assert.equal(stats.txb, wireLen);
  assert.equal(stats.rxb, wireLen);

  let aClosed = false;
  let bClosed = false;
  a.addEventListener("closed", () => {
    aClosed = true;
  });
  b.addEventListener("closed", () => {
    bClosed = true;
  });
  await a.disconnect();
  await b.disconnect();
  assert.ok(aClosed);
  assert.ok(bClosed);
  assert.ok(!a.isOpen);
  assert.ok(!b.isOpen);
});

// ------------------------------------------------------------------
// Broadcast path: real broadcast round-trip on a non-internal interface
// ------------------------------------------------------------------

test("UDP interface broadcast round-trip on a real interface", {
  skip: bcastIface ? false : "no non-internal IPv4 broadcast interface",
}, async () => {
  const port = await getPort();
  // Receiver binds to 0.0.0.0 so it hears the subnet broadcast.
  const receiver = new UDPInterface({
    listenIp: "0.0.0.0",
    listenPort: port,
    name: "udp-bcast-recv",
  });
  // Forward-only sender targeting the subnet broadcast address.
  const sender = new UDPInterface({
    forwardIp: bcastIface.broadcast,
    forwardPort: port,
    name: "udp-bcast-send",
  });
  await receiver.connect();
  await sender.connect();

  const received = new Promise((resolve) => {
    receiver.addEventListener("packet", (event) =>
      resolve(event.detail.packet),
    );
  });
  const writer = sender.writable.getWriter();
  await writer.write(makePacket("broadcast hello"));
  writer.releaseLock();

  const packet = await received;
  assert.strictEqual(
    new TextDecoder().decode(packet.payload),
    "broadcast hello",
  );
  assert.ok(sender.txb > 0, "sender should count the broadcast byte count");
  assert.ok(receiver.rxb > 0, "receiver should count the inbound bytes");

  await receiver.disconnect();
  await sender.disconnect();
});

// ------------------------------------------------------------------
// Transport integration: an interface attached to a TransportCore routes
// ------------------------------------------------------------------

test("TransportCore routes a packet out through a UDP interface", async () => {
  const portA = await getPort();
  const portB = await getPort();

  const transportA = new TransportCore();
  const transportB = new TransportCore();
  const a = new UDPInterface({
    listenIp: "127.0.0.1",
    listenPort: portA,
    forwardIp: "127.0.0.1",
    forwardPort: portB,
    name: "udp-a",
  });
  const b = new UDPInterface({
    listenIp: "127.0.0.1",
    listenPort: portB,
    forwardIp: "127.0.0.1",
    forwardPort: portA,
    name: "udp-b",
  });
  await a.connect();
  await b.connect();
  transportA.addInterface(a);
  transportB.addInterface(b);

  const received = new Promise((resolve) => {
    b.addEventListener("packet", (event) => resolve(event.detail.packet), {
      once: true,
    });
  });

  // Broadcast a PLAIN packet on transport A; it should transit interface A and
  // arrive at transport B via interface B.
  const packet = makePacket("via transport");
  transportA.broadcast(packet);

  const got = await received;
  assert.strictEqual(new TextDecoder().decode(got.payload), "via transport");

  await a.disconnect();
  await b.disconnect();
});

// ------------------------------------------------------------------
// Malformed inbound datagrams are dropped, not fatal
// ------------------------------------------------------------------

test("malformed inbound datagrams are dropped without crashing", async () => {
  const portA = await getPort();
  const portB = await getPort();
  const b = new UDPInterface({
    listenIp: "127.0.0.1",
    listenPort: portB,
    forwardIp: "127.0.0.1",
    forwardPort: portA,
    name: "udp-b",
  });
  await b.connect();

  let errored = false;
  b.addEventListener("error", () => {
    errored = true;
  });

  // Send raw garbage directly to B's bound port.
  const s = dgram.createSocket({ type: "udp4" });
  await new Promise((resolve) => s.bind(0, "127.0.0.1", resolve));
  s.send(new Uint8Array([0x00, 0x01, 0x02]), portB, "127.0.0.1");
  // Give the event loop a tick to process the datagram.
  await new Promise((resolve) => setTimeout(resolve, 50));
  s.close();

  assert.ok(!errored, "malformed datagram must not surface as an error event");
  await b.disconnect();
});
