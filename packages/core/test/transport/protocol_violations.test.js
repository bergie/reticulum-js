/**
 * Per-interface protocol violation tracking (RNS 1.5.0, work doc #31 update #9).
 *
 * Covers the three `Interface` counters + helper methods
 * (`protocolViolation` / `ifacViolation` / `packetFilterHit`), their surfacing
 * in `getStats()`, and the transport-side wiring: invalid-announce-signature
 * → `protocolViolation`, duplicate non-announce packets → `packetFilterHit`,
 * tagless / oversized path-request tags → `protocolViolation`, and the early
 * excessive-hop-count guard in `sendPacket`.
 */
import assert from "node:assert";
import test from "node:test";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  PATHFINDER_M,
  Packet,
  PacketType,
  TransportType,
} from "../../src/core/packet.js";
import { Interface } from "../../src/interfaces/base.js";
import { TransportCore } from "../../src/transport/transport.js";
import { toHex } from "../../src/utils/encoding.js";

/** Minimal concrete interface registered with a transport. */
class StubInterface extends Interface {
  readable = null;
  writable = null;
}

/** Builds a DATA packet addressed to an arbitrary dest so it can be dedup'd. */
function dataPacket(destHash) {
  return new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: destHash,
    transportType: TransportType.BROADCAST,
    contextByte: ContextType.NONE,
    payload: new Uint8Array([1, 2, 3, 4]),
  });
}

test("protocolViolation / ifacViolation / packetFilterHit increment and return null", () => {
  const iface = new StubInterface();
  assert.strictEqual(iface.protocolViolation(), null);
  assert.strictEqual(iface.protocolViolation("bad sig"), null);
  assert.strictEqual(iface.ifacViolation("missing flag"), null);
  assert.strictEqual(iface.packetFilterHit(), null);
  assert.strictEqual(iface.protocolViolations, 2);
  assert.strictEqual(iface.ifacViolations, 1);
  assert.strictEqual(iface.packetFilterHits, 1);
  const stats = iface.getStats();
  assert.strictEqual(stats.protocolViolations, 2);
  assert.strictEqual(stats.ifacViolations, 1);
  assert.strictEqual(stats.packetFilterHits, 1);
});

test("an invalid announce signature counts a protocol violation on the receiving interface", async () => {
  const transport = new TransportCore();
  const iface = new StubInterface();
  transport.interfaces.add(iface);

  // Build a real announce body with a bogus signature so validateAnnounce
  // rejects it. Use a freshly generated identity's pubkey + name_hash, but a
  // random (invalid) 64-byte signature.
  const ident = await Identity.generate();
  const publicKey = ident.publicKey;
  const nameHash = new Uint8Array(10).fill(0x01);
  const randomHash = new Uint8Array(10).fill(0x02);
  const body = new Uint8Array(64 + 10 + 10 + 64); // pubkey|name|random|sig
  body.set(publicKey, 0);
  body.set(nameHash, 64);
  body.set(randomHash, 74);
  // signature slot (118..182) left zero → invalid.

  const destHash = await Identity.truncatedHash(
    new Uint8Array(
      (await crypto.subtle.digest("SHA-256", nameHash)).slice(0, 10),
    ),
  );
  // Recompute the *real* destination hash the way RNS does so the body is at
  // least structurally plausible; validateAnnounce will still fail on the
  // signature before reaching the hash check, but either failure path counts
  // a violation.
  const packet = new Packet({
    packetType: PacketType.ANNOUNCE,
    destinationType: DestType.SINGLE,
    destinationHash: destHash,
    transportType: TransportType.BROADCAST,
    contextByte: ContextType.NONE,
    contextFlag: false,
    payload: body,
  });

  const before = iface.protocolViolations;
  await transport._handleAnnounce(packet, iface);
  assert.strictEqual(
    iface.protocolViolations,
    before + 1,
    "invalid announce counted as a protocol violation",
  );
});

test("a duplicate non-announce packet counts a packet-filter hit on the receiving interface", async () => {
  const transport = new TransportCore();
  const iface = new StubInterface();
  transport.interfaces.add(iface);

  const dest = crypto.getRandomValues(new Uint8Array(16));
  const pkt = dataPacket(dest);
  await transport._routeIncomingPacket(pkt, iface); // first pass
  const hitsBefore = iface.packetFilterHits;
  await transport._routeIncomingPacket(pkt, iface); // duplicate
  assert.strictEqual(
    iface.packetFilterHits,
    hitsBefore + 1,
    "duplicate packet counted as a packet-filter hit",
  );
});

test("a tagless path request counts a protocol violation on the receiving interface", async () => {
  const transport = new TransportCore();
  const iface = new StubInterface();
  transport.interfaces.add(iface);

  // A 16-byte payload has no tag slot → tagless → dropped + violation.
  const target = crypto.getRandomValues(new Uint8Array(16));
  const pkt = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    transportType: TransportType.BROADCAST,
    contextByte: ContextType.NONE,
    payload: target,
  });
  const before = iface.protocolViolations;
  await transport._handlePathRequest(pkt, iface);
  assert.strictEqual(
    iface.protocolViolations,
    before + 1,
    "tagless path request counted as a protocol violation",
  );
});

test("an oversized path-request tag counts a protocol violation", async () => {
  const transport = new TransportCore();
  const iface = new StubInterface();
  transport.interfaces.add(iface);

  // 16-byte target + 17-byte trailing tag (oversized; cap is 16) →
  // violation, then the request is still dedup-processed on the truncated tag.
  const target = crypto.getRandomValues(new Uint8Array(16));
  const payload = new Uint8Array(16 + 16 + 17);
  payload.set(target, 0);
  // data[16:32] = requesting_transport_instance (ignored on a leaf),
  // data[32:]  = the oversized raw tag (17 bytes > 16 cap).
  payload.set(crypto.getRandomValues(new Uint8Array(16)), 16);
  payload.set(crypto.getRandomValues(new Uint8Array(17)), 32);
  const pkt = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: await transport._pathRequestDestHash(),
    transportType: TransportType.BROADCAST,
    contextByte: ContextType.NONE,
    payload,
  });
  const before = iface.protocolViolations;
  await transport._handlePathRequest(pkt, iface);
  assert.strictEqual(
    iface.protocolViolations,
    before + 1,
    "oversized path-request tag counted as a protocol violation",
  );
});

test("sendPacket refuses a packet whose hop count has reached PATHFINDER_M", async () => {
  const transport = new TransportCore();
  const dest = crypto.getRandomValues(new Uint8Array(16));
  const pkt = dataPacket(dest);
  pkt.hops = PATHFINDER_M;
  // No interface / no broadcast call should happen; sendPacket must bail.
  let sent = false;
  transport.broadcast = () => {
    sent = true;
  };
  await transport.sendPacket(pkt);
  assert.strictEqual(sent, false, "excessive-hop packet not sent");
});

test("sendPacket sends a packet with hops just below PATHFINDER_M", async () => {
  const transport = new TransportCore();
  const dest = crypto.getRandomValues(new Uint8Array(16));
  const pkt = dataPacket(dest);
  pkt.hops = PATHFINDER_M - 1;
  // Provide a default interface writer so the leaf-broadcast fallback runs.
  const iface = new StubInterface();
  /** @type {Packet[]} */ const written = [];
  iface._packetWriter = { write: async (p) => written.push(p) };
  transport.defaultInterface = iface;
  await transport.sendPacket(pkt);
  assert.strictEqual(written.length, 1, "sub-max-hop packet sent");
});
