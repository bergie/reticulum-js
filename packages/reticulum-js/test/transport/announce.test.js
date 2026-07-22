/**
 * Inbound ANNOUNCE handling for TransportCore (SPEC.md §4.5).
 *
 * A packet built by `Destination.announce` is serialized and deserialized
 * (mirroring a real wire arrival), then routed through
 * `TransportCore._routeIncomingPacket`. Valid announces must be
 * signature-verified, destination-hash-checked, cached in
 * `Destination.knownDestinations`, and dispatched as an `announce` event;
 * forged and self-echo announces must be dropped.
 */
import assert from "node:assert";
import test from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType, Packet, PacketType } from "../../src/core/packet.js";
import { TransportCore } from "../../src/transport/transport.js";
import { bytesEqual, toHex } from "../../src/utils/encoding.js";

/** Captures broadcast packets in place of a real interface layer. */
class CapturingLayer {
  constructor() {
    /** @type {Packet[]} */
    this.packets = [];
  }
  /** @param {Packet} pkt */
  broadcast(pkt) {
    this.packets.push(pkt);
  }
}

/**
 * Builds a real announce on the wire (serialize → deserialize) so the inbound
 * path sees exactly what a remote peer would send.
 *
 * @param {string} appName
 * @returns {Promise<{ packet: Packet, identity: Identity, destinationHash: Uint8Array }>}
 */
async function buildWireAnnounce(appName) {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(appName, DestType.SINGLE, identity, layer);
  await dest.announce();
  const outgoing = layer.packets[0];
  const incoming = Packet.deserialize(outgoing.serialize());
  return {
    packet: incoming,
    identity,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
  };
}

test("TransportCore ingests a valid announce and dispatches an `announce` event", async () => {
  const { packet, identity, destinationHash } = await buildWireAnnounce(
    "test.valid.announce",
  );
  const transport = new TransportCore();

  /** @type {any} */
  let event = null;
  transport.addEventListener("announce", (e) => {
    event = /** @type {CustomEvent} */ (e).detail;
  });

  await transport._routeIncomingPacket(packet, /** @type {any} */ (null));

  assert.ok(event, "expected an announce event");
  assert.ok(bytesEqual(event.destinationHash, destinationHash));
  assert.ok(bytesEqual(event.identity.identityHash, identity.identityHash));

  const entry = Destination.knownDestinations.get(toHex(destinationHash));
  assert.ok(entry, "announce should have been cached in knownDestinations");
  assert.ok(bytesEqual(entry[2], identity.publicKey));
});

test("TransportCore drops an announce with a tampered signature", async () => {
  const { packet, destinationHash } = await buildWireAnnounce("test.bad.sig");
  // Corrupt a byte inside the signature slot [84:148] of a ratchet-less
  // announce body. validateAnnounce reads from packet.payload, so the tamper
  // is visible and signature verification must fail (§4.5 step 2).
  const tampered = Packet.deserialize(packet.serialize());
  tampered.payload[90] ^= 0xff;

  const transport = new TransportCore();
  let fired = false;
  transport.addEventListener("announce", () => {
    fired = true;
  });

  await transport._routeIncomingPacket(tampered, /** @type {any} */ (null));

  assert.strictEqual(fired, false);
  assert.ok(
    !Destination.knownDestinations.has(toHex(destinationHash)),
    "forged announce must not be cached",
  );
});

test("TransportCore ignores announces for its own local destinations (self-echo, §9.5)", async () => {
  const { packet, destinationHash } = await buildWireAnnounce("test.self.echo");
  const transport = new TransportCore();
  // Register the destination hash as local, simulating receiving our own
  // announce back from the mesh.
  transport.localDestinations.set(
    toHex(destinationHash),
    /** @type {any} */ ({}),
  );

  let fired = false;
  transport.addEventListener("announce", () => {
    fired = true;
  });

  await transport._routeIncomingPacket(packet, /** @type {any} */ (null));

  assert.strictEqual(fired, false);
});

test("TransportCore routes a ratchet-bearing announce and caches the ratchet", async () => {
  // Build a ratchet announce by hand (Destination.announce does not yet emit
  // ratchets — that is ratchet-rotation work). This pins the receive side
  // independently of the send side.
  const identity = await Identity.generate();
  const dest = await Destination.IN(
    "test.ratchet",
    DestType.SINGLE,
    identity,
    new CapturingLayer(),
  );
  const pubKey = await identity.getPublicKey();
  const nameHash = /** @type {Uint8Array} */ (dest.nameHash);
  const randomHash = new Uint8Array(10);
  crypto.getRandomValues(randomHash.subarray(0, 5));
  const ratchet = crypto.getRandomValues(new Uint8Array(32));

  // signed_data = dest_hash || pub_key || name_hash || random_hash || ratchet || app_data
  const signedData = new Uint8Array(
    dest.destinationHash.length +
      pubKey.length +
      nameHash.length +
      randomHash.length +
      ratchet.length,
  );
  let o = 0;
  signedData.set(dest.destinationHash, o);
  o += dest.destinationHash.length;
  signedData.set(pubKey, o);
  o += pubKey.length;
  signedData.set(nameHash, o);
  o += nameHash.length;
  signedData.set(randomHash, o);
  o += randomHash.length;
  signedData.set(ratchet, o);
  const signature = await identity.sign(signedData);

  // Body (context_flag=1): pubKey(64) || nameHash(10) || randomHash(10) || ratchet(32) || signature(64)
  const body = new Uint8Array(64 + 10 + 10 + 32 + 64);
  body.set(pubKey, 0);
  body.set(nameHash, 64);
  body.set(randomHash, 74);
  body.set(ratchet, 84);
  body.set(signature, 116);

  const packet = new Packet({
    packetType: PacketType.ANNOUNCE,
    destinationType: DestType.SINGLE,
    destinationHash: dest.destinationHash,
    contextFlag: true,
    payload: body,
  });
  packet.raw = packet.serialize();

  const transport = new TransportCore();
  await transport._routeIncomingPacket(packet, /** @type {any} */ (null));

  const ring = Destination.recallRatchets(dest.destinationHash);
  assert.ok(ring, "ratchet should have been cached");
  assert.ok(bytesEqual(ring[0], ratchet));
});
