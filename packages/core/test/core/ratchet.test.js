/**
 * Forward-secrecy ratchets (SPEC.md §7.4).
 *
 * Covers ratchet ownership on `Destination` (generation, rotation, announce
 * emission), the two encrypt/decrypt call sites (encrypt to a peer's newest
 * ratchet; decrypt with the owned private ring), rotation tolerance for
 * in-flight messages, and the long-term fallback when no ratchet is known.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType, Packet } from "../../src/core/packet.js";
import { TransportCore } from "../../src/transport/transport.js";
import { bytesEqual } from "../../src/utils/encoding.js";

/** Captures broadcast announce packets in place of a real interface layer. */
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

const enc = (s) => new TextEncoder().encode(s);

describe("Destination.enableRatchets — ownership & announce emission", () => {
  test("enableRatchets generates a key and the announce carries context_flag + 32B ratchet", async () => {
    const identity = await Identity.generate();
    const layer = new CapturingLayer();
    const dest = await Destination.IN(
      "test.ratchet.emit",
      DestType.SINGLE,
      identity,
      layer,
    );

    await dest.enableRatchets();
    assert.strictEqual(dest.ratchetsEnabled, true);
    assert.strictEqual(dest.ratchets.length, 1);

    await dest.announce();
    const announce = layer.packets[0];
    assert.strictEqual(announce.contextFlag, true, "context_flag must be set");

    // validateAnnounce recovers the embedded ratchet (§4.5 ratchet branch).
    const result = await Identity.validateAnnounce(
      dest.destinationHash,
      true,
      announce.payload,
    );
    assert.ok(result);
    assert.ok(result.ratchet);
    assert.strictEqual(result.ratchet.length, 32);
    assert.ok(bytesEqual(result.ratchet, dest.ratchets[0].publicKey));
  });

  test("a ratchet announce round-trips through the transport and is recalled", async () => {
    const identity = await Identity.generate();
    const layer = new CapturingLayer();
    const dest = await Destination.IN(
      "test.ratchet.transport",
      DestType.SINGLE,
      identity,
      layer,
    );
    await dest.enableRatchets();
    await dest.announce();
    const arriving = Packet.deserialize(layer.packets[0].serialize());

    const transport = new TransportCore();
    await transport._routeIncomingPacket(arriving, /** @type {any} */ (null));

    const recalled = Destination.recallRatchets(dest.destinationHash);
    assert.ok(recalled && recalled.length > 0);
    assert.ok(bytesEqual(recalled[0], dest.ratchets[0].publicKey));
  });
});

describe("Destination.encrypt / _handleData — ratchet wiring", () => {
  test("encrypts to the recipient's ratchet and decrypts with the owned private key", async () => {
    // Receiver: full identity, ratchets enabled.
    const idA = await Identity.generate();
    const destA = await Destination.IN(
      "test.ratchet.xcv",
      DestType.SINGLE,
      idA,
      new CapturingLayer(),
    );
    await destA.enableRatchets();
    const ratchetPriv = destA.ratchets[0].privateKey;

    // Sender learns A's ratchet (as if from an announce).
    Destination.rememberRatchet(
      destA.destinationHash,
      destA.ratchets[0].publicKey,
    );

    // Outbound destination for A (public-only identity) routes encrypt() via
    // Destination.recallRatchets → Identity.encrypt(ratchet).
    const idAOut = await Identity.fromPublicKey(await idA.getPublicKey());
    const destAOut = await Destination.OUT(
      "test.ratchet.xcv",
      DestType.SINGLE,
      idAOut,
      null,
    );
    const plaintext = enc("forward-secret payload");
    const ciphertext = await destAOut.encrypt(plaintext);

    // A decrypts with its owned ratchet private key.
    const decrypted = await idA.decrypt(ciphertext, [ratchetPriv]);
    assert.ok(decrypted);
    assert.ok(bytesEqual(decrypted, plaintext));
  });

  test("a ratchet-encrypted payload is NOT decryptable with the long-term key alone", async () => {
    const idA = await Identity.generate();
    const destA = await Destination.IN(
      "test.ratchet.not.longterm",
      DestType.SINGLE,
      idA,
      new CapturingLayer(),
    );
    await destA.enableRatchets();
    Destination.rememberRatchet(
      destA.destinationHash,
      destA.ratchets[0].publicKey,
    );

    const idAOut = await Identity.fromPublicKey(await idA.getPublicKey());
    const destAOut = await Destination.OUT(
      "test.ratchet.not.longterm",
      DestType.SINGLE,
      idAOut,
      null,
    );
    const ciphertext = await destAOut.encrypt(enc("ratchet-only"));

    // ratchets=null forces the long-term fallback path, which must fail since
    // the payload was encrypted to a different (ratchet) public key.
    const longTermOnly = await idA.decrypt(ciphertext, null);
    assert.strictEqual(longTermOnly, null);
  });

  test("falls back to the long-term key when no ratchet is known for the peer", async () => {
    const idA = await Identity.generate();
    const idAOut = await Identity.fromPublicKey(await idA.getPublicKey());
    const destAOut = await Destination.OUT(
      "test.ratchet.none",
      DestType.SINGLE,
      idAOut,
      null,
    );
    // No rememberRatchets → recallRatchets returns null → long-term encryption.
    const plaintext = enc("no ratchet here");
    const ciphertext = await destAOut.encrypt(plaintext);

    const decrypted = await idA.decrypt(ciphertext);
    assert.ok(decrypted);
    assert.ok(bytesEqual(decrypted, plaintext));
  });
});

describe("Destination.rotateRatchets — rotation tolerance", () => {
  test("a message encrypted to a just-rotated previous ratchet still decrypts", async () => {
    const idA = await Identity.generate();
    const destA = await Destination.IN(
      "test.ratchet.rotate",
      DestType.SINGLE,
      idA,
      new CapturingLayer(),
    );
    await destA.enableRatchets();
    const oldPub = destA.ratchets[0].publicKey;

    await destA.rotateRatchets(true); // force a new ratchet
    assert.strictEqual(destA.ratchets.length, 2);
    const newPub = destA.ratchets[0].publicKey;
    assert.ok(!bytesEqual(oldPub, newPub), "rotation must produce a new key");

    // Simulate an in-flight message encrypted to the OLD ratchet.
    Destination.rememberRatchet(destA.destinationHash, oldPub);
    const idAOut = await Identity.fromPublicKey(await idA.getPublicKey());
    const destAOut = await Destination.OUT(
      "test.ratchet.rotate",
      DestType.SINGLE,
      idAOut,
      null,
    );
    const ciphertext = await destAOut.encrypt(enc("in flight"));

    // The full retained ring (newest first) still contains the old private key.
    const privRing = destA.ratchets.map((r) => r.privateKey);
    const decrypted = await idA.decrypt(ciphertext, privRing);
    assert.ok(decrypted);
    assert.ok(bytesEqual(decrypted, enc("in flight")));
  });
});
