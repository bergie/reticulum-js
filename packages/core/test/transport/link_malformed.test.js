/**
 * Malformed LINKREQUEST / LRRTT ingress handling.
 *
 * Security regression tests for the responder-side handshake paths:
 *
 *   - `Link.accept` must reject any payload size other than exactly 64
 *     (two ephemeral public keys) or 67 (keys + MTU signalling) bytes and
 *     convert every validation exception into `null` — mirroring the Python
 *     reference's `Link.validate_request`, which wraps the handshake in
 *     try/except and drops the request. Throwing raw WebCrypto errors into
 *     `link_request` listeners crashes applications that follow the
 *     documented `acceptLink` pattern without their own try/catch.
 *   - `_handleLRRTT` must treat a non-finite reported RTT (msgpack can carry
 *     NaN/Infinity float64s) as a protocol error and tear the link down.
 *     `Math.max` propagates NaN into `keepaliveInterval`/`staleTime`, which
 *     silently disables the staleness watchdog.
 *
 * @module test/transport/link_malformed
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { MicroMsgPack } from "../../src/utils/msgpack.js";

/** Minimal IN destination + transport mock for responder-side tests. */
async function responderSetup() {
  const identity = await Identity.generate();
  /** @type {any} */
  const transport = {
    links: new Map(),
    addLink(hash, link) {
      this.links.set(Buffer.from(hash).toString("hex"), link);
    },
    removeLink() {},
    async sendPacket(packet) {
      this.sent ??= [];
      this.sent.push(packet);
    },
  };
  const destination = await Destination.create(
    "responder",
    Direction.IN,
    DestType.SINGLE,
    identity,
    transport,
  );
  return { destination, transport };
}

/** Builds a LINKREQUEST-shaped packet with an arbitrary payload length. */
function lrPacket(destinationHash, payloadLength, fill = true) {
  const payload = new Uint8Array(payloadLength);
  if (fill) crypto.getRandomValues(payload);
  const packet = new Packet({
    packetType: PacketType.LINKREQUEST,
    destinationType: DestType.SINGLE,
    destinationHash,
    contextByte: ContextType.NONE,
    payload,
  });
  packet.raw = packet.serialize();
  return packet;
}

test("Link.accept drops a too-short LINKREQUEST payload (returns null)", async () => {
  const { destination } = await responderSetup();
  const link = await Link.accept(
    destination,
    /** @type {any} */ ({}),
    lrPacket(destination.destinationHash, 32),
  );
  assert.strictEqual(link, null, "32-byte payload must be dropped");
});

test("Link.accept drops a 65-byte (neither 64 nor 67) LINKREQUEST payload", async () => {
  const { destination } = await responderSetup();
  const link = await Link.accept(
    destination,
    /** @type {any} */ ({}),
    lrPacket(destination.destinationHash, 65),
  );
  assert.strictEqual(link, null, "non-canonical payload size must be dropped");
});

test("Link.accept converts derivation failures into null instead of throwing", async () => {
  const { destination } = await responderSetup();
  // Exactly 64 bytes — passes the size gate — but the X25519 public key is
  // all zeros (a low-order point): deriveBits must reject it, and the
  // failure must surface as null, not a raw WebCrypto exception.
  const packet = lrPacket(destination.destinationHash, 64, false);
  const link = await Link.accept(destination, /** @type {any} */ ({}), packet);
  assert.strictEqual(link, null, "unusable ephemeral key must be dropped");
});

test("Destination.acceptLink returns null on a malformed request", async () => {
  const { destination } = await responderSetup();
  /** @type {any} */ (destination).interfaceLayer = { transport: {} };
  const link = await destination.acceptLink(
    lrPacket(destination.destinationHash, 10),
  );
  assert.strictEqual(link, null);
});

test("an LRRTT reporting NaN tears the link down instead of poisoning timers", async () => {
  const { destination, transport } = await responderSetup();
  // Establish a responder-side link without a full handshake: craft the
  // accept path with a well-formed 64-byte payload.
  const packet = lrPacket(destination.destinationHash, 64);
  const link = await Link.accept(destination, transport, packet);
  assert.ok(link, "well-formed request establishes a responder link");

  await link._handleLRRTT({ payload: MicroMsgPack.encode(Number.NaN) });
  assert.notStrictEqual(
    link.status,
    LinkStatus.ACTIVE,
    "a NaN RTT must not leave the link usable",
  );
  assert.strictEqual(link.status, LinkStatus.CLOSED);
});

test("an LRRTT reporting Infinity tears the link down", async () => {
  const { destination, transport } = await responderSetup();
  const packet = lrPacket(destination.destinationHash, 64);
  const link = await Link.accept(destination, transport, packet);
  assert.ok(link, "well-formed request establishes a responder link");

  await link._handleLRRTT({
    payload: MicroMsgPack.encode(Number.POSITIVE_INFINITY),
  });
  assert.strictEqual(link.status, LinkStatus.CLOSED);
});
