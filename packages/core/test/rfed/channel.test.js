/**
 * rfed channel derivation (work doc #25, Phase 0).
 *
 * Verifies `deriveChannel` against the Python `channel_hash.compute_channel_hash`
 * reference vectors (`RFed/utilities/channel_hash.py`) and the canonical wire
 * format invariants from `RFed/SPEC.md` §1.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import {
  channelPath,
  deliveryHashFor,
  deriveChannel,
} from "../../src/rfed/channel.js";
import { toHex } from "../../src/utils/encoding.js";

/**
 * Reference channel hashes produced by
 * `python3 RFed/utilities/channel_hash.py <name>` (SHA-256 seed, X25519+Ed25519
 * pub bundle, SHA-256[..16]).
 */
const REFERENCE_HASHES = {
  "public.test": "84a0946dd390c396ace67d1220100990",
  "public.news.tech": "0e064dd09d0ded891899e77cb233a720",
  "public.announcements": "90008a78b902a0a4aa96d5cb5e9ad5e0",
  test: "a166324ac82fcce7a531a0d06785bf1a",
  private: "3520b622fbdb9fff47c1db4ce9b7ea26",
  "private.channel": "aff6881a86e1a085490301043258228e",
};

describe("rfed deriveChannel", () => {
  test("channel hash matches Python reference vectors", async () => {
    for (const [name, expectedHex] of Object.entries(REFERENCE_HASHES)) {
      const { channelHash } = await deriveChannel(name);
      assert.strictEqual(
        toHex(channelHash),
        expectedHex,
        `channel_hash(${JSON.stringify(name)})`,
      );
    }
  });

  test("derivation is deterministic — same name, same identity + hash", async () => {
    const a = await deriveChannel("public.test");
    const b = await deriveChannel("public.test");
    assert.strictEqual(toHex(a.channelHash), toHex(b.channelHash));
    assert.deepStrictEqual(
      await a.identity.getPublicKey(),
      await b.identity.getPublicKey(),
    );
  });

  test("different names yield different hashes", async () => {
    const a = await deriveChannel("public.test");
    const b = await deriveChannel("public.other");
    assert.notStrictEqual(toHex(a.channelHash), toHex(b.channelHash));
  });

  test("channelHash equals Identity.truncatedHash(public_key_bundle)", async () => {
    const { identity, channelHash } = await deriveChannel("public.test");
    const pub = await identity.getPublicKey();
    assert.strictEqual(pub.length, 64); // X25519 ‖ Ed25519
    const expected = await Identity.truncatedHash(pub);
    assert.deepStrictEqual(channelHash, expected);
  });

  test("channel identity holds private keys (can sign + decrypt)", async () => {
    const { identity } = await deriveChannel("public.test");

    const message = new TextEncoder().encode("channel self-test");
    const signature = await identity.sign(message);
    assert.strictEqual(signature.length, 64);
    assert.strictEqual(await identity.validate(signature, message), true);

    // EC encrypt/decrypt round-trip with the derived identity.
    const plaintext = new TextEncoder().encode("secret blob");
    const ciphertext = await identity.encrypt(plaintext);
    const decrypted = await identity.decrypt(ciphertext);
    assert.deepStrictEqual(decrypted, plaintext);
  });

  test("independently derived channel identities agree on EC secrets", async () => {
    // Two parties that know the name arrive at the same keypair, so a blob
    // encrypted by one decrypts cleanly for the other.
    const sender = await deriveChannel("public.test");
    const receiver = await deriveChannel("public.test");

    const plaintext = new TextEncoder().encode("shared channel");
    const ciphertext = await sender.identity.encrypt(plaintext);
    const decrypted = await receiver.identity.decrypt(ciphertext);
    assert.deepStrictEqual(decrypted, plaintext);
  });

  test("a wrong channel name cannot decrypt another channel's blob", async () => {
    const real = await deriveChannel("public.real");
    const impostor = await deriveChannel("public.impostor");
    const ciphertext = await real.identity.encrypt(
      new TextEncoder().encode("nope"),
    );
    const decrypted = await impostor.identity.decrypt(ciphertext);
    assert.strictEqual(decrypted, null);
  });
});

describe("rfed deliveryHashFor", () => {
  test("is the lxmf.delivery destination hash, not the bare identity hash", async () => {
    const { identity, channelHash } = await deriveChannel("public.test");
    const deliveryHash = await deliveryHashFor(identity);

    assert.strictEqual(deliveryHash.length, 16);
    // The delivery hash must differ from the channel identity hash.
    assert.notStrictEqual(toHex(deliveryHash), toHex(channelHash));

    // Recompute manually: SHA-256("lxmf.delivery")[:10] ‖ identity_hash.
    const nameHash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("lxmf.delivery"),
      ),
    ).slice(0, 10);
    const combined = new Uint8Array(nameHash.length + channelHash.length);
    combined.set(nameHash, 0);
    combined.set(channelHash, nameHash.length);
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", combined),
    ).slice(0, 16);
    assert.deepStrictEqual(deliveryHash, expected);
  });

  test("is stable across independent derivations of the same channel", async () => {
    const a = await deriveChannel("public.news.tech");
    const b = await deriveChannel("public.news.tech");
    assert.deepStrictEqual(
      await deliveryHashFor(a.identity),
      await deliveryHashFor(b.identity),
    );
  });
});

describe("rfed channelPath", () => {
  test("joins segments with dots, mirroring aspect notation", () => {
    assert.strictEqual(
      channelPath("public", "news", "tech"),
      "public.news.tech",
    );
    assert.strictEqual(channelPath("public"), "public");
  });

  test("a path round-trips back to the same channel hash", async () => {
    const name = channelPath("public", "test");
    const byName = await deriveChannel("public.test");
    const byPath = await deriveChannel(name);
    assert.deepStrictEqual(byName.channelHash, byPath.channelHash);
  });
});
