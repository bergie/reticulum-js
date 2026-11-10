/**
 * RNS 1.6.0 link request stamps (`Link.initiate` keystamp mining and
 * `Link.accept` validation, mirroring Python `Link.__stamped_keys` and the
 * `Link.__init__` stamp block).
 *
 * The stamp material is `dest_hash ‖ initiator_ephemeral_sig_pub` and the
 * stamp itself is the initiator's ephemeral X25519 public key — mined so
 * `SHA256(material ‖ x25519_pub)` meets the destination's announced link
 * cost. Zero extra wire bytes: the LINKREQUEST body is unchanged.
 *
 * @module test/transport/link_stamps.test
 */

import assert from "node:assert";
import { test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import {
  exportPublicKey,
  generateEd25519KeyPair,
} from "../../src/crypto/keys.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { TransportCore } from "../../src/transport/transport.js";
import { concatBytes } from "../../src/utils/encoding.js";
import {
  generateStampedKey,
  stampValid,
  stampValue,
} from "../../src/utils/stamps.js";

const LOW_COST = 4.0;

test("initiator mines the ephemeral X25519 key against the announced cost", async (t) => {
  await t.test("stamped when the destination announced a cost", async () => {
    const transport = new TransportCore();
    transport.sendPacket = async (/** @type {Packet} */ pkt) => pkt;
    const identity = await Identity.generate();
    const dest = await Destination.OUT(
      "remote",
      DestType.SINGLE,
      identity,
      /** @type {any} */ ({ transport }),
    );
    const announced = LOW_COST;
    transport.recallLinkCost = async () => announced;
    /** @type {Packet[]} */
    const captured = [];
    transport.sendPacket = async (/** @type {Packet} */ pkt) => {
      captured.push(pkt);
      return pkt;
    };

    const link = await Link.initiate(dest, transport);
    const x25519Pub = link.ephemeralX25519Pub;
    // The ephemeral sig pub is the second 32 bytes of the LINKREQUEST body.
    const material = concatBytes(
      /** @type {Uint8Array} */ (dest.destinationHash),
      captured[0].payload.slice(32, 64),
    );
    assert.strictEqual(
      await stampValid(x25519Pub, announced, material),
      true,
      "ephemeral X25519 pub validates as the stamp",
    );
    assert.strictEqual(link.stampStatus, null);
  });

  await t.test("unstamped when no cost was announced", async () => {
    const transport = new TransportCore();
    transport.sendPacket = async (/** @type {Packet} */ pkt) => pkt;
    const identity = await Identity.generate();
    const dest = await Destination.OUT(
      "remote",
      DestType.SINGLE,
      identity,
      /** @type {any} */ ({ transport }),
    );
    transport.recallLinkCost = async () => null;
    assert.strictEqual(TransportCore.ALWAYS_STAMP_LINK_REQUESTS, false);
    /** @type {Packet[]} */
    const captured = [];
    transport.sendPacket = async (/** @type {Packet} */ pkt) => {
      captured.push(pkt);
      return pkt;
    };

    const link = await Link.initiate(dest, transport);
    // The key is unmined randomness — below the announced cost with
    // overwhelming probability.
    const material = concatBytes(
      /** @type {Uint8Array} */ (dest.destinationHash),
      captured[0].payload.slice(32, 64),
    );
    assert.strictEqual(
      await stampValid(link.ephemeralX25519Pub, 8, material),
      false,
    );
  });
});

test("responder validates the stamp and records its value", async () => {
  const responderIdentity = await Identity.generate();
  const dest = await Destination.IN(
    "stamped-service",
    DestType.SINGLE,
    responderIdentity,
    null,
  );
  dest.setLinkCost(LOW_COST);

  // Build the initiator side exactly as a stamped Python/JS peer would.
  const initiatorEd = await generateEd25519KeyPair();
  const ed25519Pub = await exportPublicKey(initiatorEd.publicKey);
  const material = concatBytes(
    /** @type {Uint8Array} */ (dest.destinationHash),
    ed25519Pub,
  );
  const stamped = await generateStampedKey(material, LOW_COST);
  assert.ok(stamped, "keystamp mining succeeds");

  // LINKREQUEST body: initiator_X25519(32) || initiator_Ed25519(32) || signalling(3)
  const body = new Uint8Array(64 + 3);
  body.set(stamped.publicKey, 0);
  body.set(ed25519Pub, 32);
  // zero signalling: default MTU/mode

  const packet = new Packet({
    headerType: 0,
    hops: 0,
    transportType: 0,
    destinationType: DestType.SINGLE,
    packetType: PacketType.LINKREQUEST,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
    contextByte: ContextType.NONE,
    payload: body,
  });
  packet.raw = packet.serialize();

  const transport = new TransportCore();
  transport.sendPacket = async (/** @type {Packet} */ pkt) => pkt;
  const originalEnforced = TransportCore.LR_STAMPS_ENFORCED;
  try {
    const link = await Link.accept(dest, transport, packet, null);
    assert.strictEqual(link.stampStatus, true);
    assert.ok(link.stampCost !== null && link.stampCost >= LOW_COST);
    assert.strictEqual(
      await stampValue(material, stamped.publicKey),
      link.stampCost,
    );
    assert.strictEqual(link.status, LinkStatus.HANDSHAKE);
  } finally {
    TransportCore.LR_STAMPS_ENFORCED = originalEnforced;
  }
});

test("enforcement rejects insufficient link request stamps", async () => {
  const responderIdentity = await Identity.generate();
  const dest = await Destination.IN(
    "stamped-service",
    DestType.SINGLE,
    responderIdentity,
    null,
  );
  dest.setLinkCost(16.0); // requirement the unstamped key cannot meet

  const initiatorEd = await generateEd25519KeyPair();
  const ed25519Pub = await exportPublicKey(initiatorEd.publicKey);
  // Unstamped (random) X25519 key: value ≈ 0
  const { generateX25519KeyPair } = await import("../../src/crypto/keys.js");
  const unstamped = await generateX25519KeyPair();

  const body = new Uint8Array(64 + 3);
  body.set(await exportPublicKey(unstamped.publicKey), 0);
  body.set(ed25519Pub, 32);
  const packet = new Packet({
    headerType: 0,
    hops: 0,
    transportType: 0,
    destinationType: DestType.SINGLE,
    packetType: PacketType.LINKREQUEST,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
    contextByte: ContextType.NONE,
    payload: body,
  });
  packet.raw = packet.serialize();

  const transport = new TransportCore();
  transport.sendPacket = async (/** @type {Packet} */ pkt) => pkt;
  const originalEnforced = TransportCore.LR_STAMPS_ENFORCED;
  TransportCore.LR_STAMPS_ENFORCED = true;
  try {
    await assert.rejects(
      () => Link.accept(dest, transport, packet, null),
      /Insufficient link request stamp value/,
    );
  } finally {
    TransportCore.LR_STAMPS_ENFORCED = originalEnforced;
  }

  // Non-enforcing (upstream 1.6.0 default): the same request is accepted and
  // the (insufficient) value is recorded.
  const link = await Link.accept(dest, transport, packet, null);
  assert.strictEqual(link.stampStatus, true);
  assert.ok(link.stampCost !== null && link.stampCost < 16.0);
});
