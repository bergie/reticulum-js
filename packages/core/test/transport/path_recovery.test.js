/**
 * Tests for path-recovery semantics on send (the leaf counterpart of Python
 * `Transport.expire_path` + LXMF's rediscovery after failed attempts):
 *
 *   - `sendPacket` refuses to route via a path marked UNRESPONSIVE: the route
 *     is expired first and the packet degrades to the default-interface leaf
 *     broadcast, so a confirmed-dead path cannot blackhole further sends while
 *     `hasPath()` keeps returning true.
 *   - `sendPacket` returns the tracked `PacketReceipt` for opportunistic
 *     CTX_NONE DATA (settleable via `whenSettled`).
 *   - `requestPathAuto` treats an UNRESPONSIVE path as unknown and sends a
 *     fresh `path?` request instead of short-circuiting.
 *   - `PacketReceipt.whenSettled` resolves with the terminal status for both
 *     the delivered and the timed-out (failed) outcomes.
 */
import assert from "node:assert";
import test from "node:test";
import { createAnnounceRandomHash } from "../../src/core/destination.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { PacketReceipt, ReceiptStatus } from "../../src/core/packet_receipt.js";
import { Reticulum } from "../../src/core/reticulum.js";
import { PathState } from "../../src/transport/router.js";

/**
 * A recording (non-looping) interface: every written packet is captured,
 * nothing is routed back in. Returns the interface and its write log.
 * @param {import("../../src/transport/transport.js").TransportCore} transport
 * @param {string} [name]
 * @returns {{iface: any, written: import("../../src/core/packet.js").Packet[]}}
 */
function attachRecorder(transport, name = "recorder") {
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const written = [];
  const iface = Object.assign(new EventTarget(), {
    name,
    bitrate: 1_000_000,
    _packetWriter: {
      write: async (
        /** @type {import("../../src/core/packet.js").Packet} */ pkt,
      ) => {
        written.push(pkt);
      },
    },
  });
  transport.addInterface(iface, true);
  return { iface, written };
}

/**
 * Adds a 1-hop route for `hash` through the given interface.
 * @param {import("../../src/transport/transport.js").TransportCore} transport
 * @param {any} iface
 * @param {Uint8Array} hash
 * @param {number} [hops]
 */
function addRoute(transport, iface, hash, hops = 1) {
  transport.routingTable.addOrUpdateRoute(hash, {
    nextHop: crypto.getRandomValues(new Uint8Array(16)),
    hops,
    viaInterface: iface,
    randomBlob: createAnnounceRandomHash(
      crypto.getRandomValues(new Uint8Array(16)),
      1000,
    ),
  });
}

/**
 * A CTX_NONE single-destination DATA packet (the opportunistic shape).
 * @param {Uint8Array} destinationHash
 */
function opportunisticData(destinationHash) {
  return new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash,
    contextByte: ContextType.NONE,
    payload: new Uint8Array([1, 2, 3]),
  });
}

test("sendPacket expires an UNRESPONSIVE route instead of routing into it", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const { iface, written } = attachRecorder(transport);
  const hash = crypto.getRandomValues(new Uint8Array(16));
  addRoute(transport, iface, hash);
  transport.routingTable.markState(hash, PathState.UNRESPONSIVE);

  const receipt = await transport.sendPacket(opportunisticData(hash));

  // The dead route is gone: the next sender cannot ride it.
  assert.strictEqual(
    transport.hasPath(hash),
    false,
    "an unresponsive route must be expired before sending",
  );
  // The packet still went out — via the default-interface leaf broadcast.
  assert.strictEqual(
    written.length,
    1,
    "the packet must still be transmitted on the default interface",
  );
  // A settleable receipt was handed back for opportunistic DATA.
  assert.ok(receipt instanceof PacketReceipt);
  assert.strictEqual(
    PacketReceipt.find(receipt.truncatedHash),
    receipt,
    "the receipt must be tracked so an inbound PROOF can resolve it",
  );
  receipt.clearTimeout();
});

test("sendPacket still routes normally while the path is merely stale (UNKNOWN state)", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const { iface } = attachRecorder(transport);
  const hash = crypto.getRandomValues(new Uint8Array(16));
  addRoute(transport, iface, hash);

  const receipt = await transport.sendPacket(opportunisticData(hash));
  assert.ok(receipt instanceof PacketReceipt);
  assert.strictEqual(transport.hasPath(hash), true);
  receipt.clearTimeout();
});

test("requestPathAuto re-requests an UNRESPONSIVE path instead of skipping it", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  const { iface } = attachRecorder(transport);
  const hash = crypto.getRandomValues(new Uint8Array(16));
  addRoute(transport, iface, hash);
  transport.routingTable.markState(hash, PathState.UNRESPONSIVE);

  let requested = 0;
  transport.requestPath = async () => {
    requested += 1;
  };

  assert.strictEqual(await transport.requestPathAuto(hash), true);
  assert.strictEqual(requested, 1);
});

test("PacketReceipt.whenSettled resolves DELIVERED on proof, FAILED on timeout", async () => {
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const destinationHash = crypto.getRandomValues(new Uint8Array(16));

  // Delivered: settles as soon as setDelivered fires.
  const ok = new PacketReceipt(packetHash, destinationHash);
  const okPromise = ok.whenSettled();
  assert.strictEqual(ok.status, ReceiptStatus.SENDING);
  setTimeout(() => ok.setDelivered(), 10);
  assert.strictEqual(await okPromise, ReceiptStatus.DELIVERED);
  // Already-settled receipts resolve immediately.
  assert.strictEqual(await ok.whenSettled(), ReceiptStatus.DELIVERED);

  // Failed: settles when the proof-wait timeout expires.
  const bad = new PacketReceipt(packetHash.slice(), destinationHash.slice());
  const badPromise = bad.whenSettled();
  bad.startTimeout(25);
  assert.strictEqual(await badPromise, ReceiptStatus.FAILED);
});
