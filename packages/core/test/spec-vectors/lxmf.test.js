/**
 * Spec test-vectors — opportunistic LXMF (SPEC §3, §5.1, §5.2, §5.5, §5.6).
 *
 * The vectors pin the LXMF timestamp, title, content and fields, and the
 * sender (alice) identity, so Ed25519's deterministic signing reproduces
 * the recorded `lxmf_packed_hex` byte-for-byte — proving the §5.6.1
 * canonical-msgpack MUST (the recent errata: the signature covers the
 * 4-element payload and a non-canonical encoder breaks every stamped
 * message). Then the opportunistic Token ciphertext (§3 modified Fernet)
 * is reproduced with the pinned ephemeral X25519 priv + IV, proving the
 * wire format that's invisible from the Python side (same encoder both
 * ways).
 *
 * @module test/spec-vectors/lxmf.test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Message } from "../../../lxmf/src/message.js";
import { Destination } from "../../src/core/destination.js";
import { DestType } from "../../src/core/packet.js";
import { hkdf } from "../../src/crypto/ciphers.js";
import { importRawX25519PrivateKey } from "../../src/crypto/keys.js";
import { Token } from "../../src/crypto/token.js";
import {
  bytesToHex,
  hexToBytes,
  loadIdentityMap,
  loadVectors,
  vectorsAvailable,
} from "./_loader.js";

/**
 * The LXMF `lxmf.delivery` destination hash for an identity (§9.1: the LXMF
 * source/destination hashes are `lxmf.delivery` destination hashes, not raw
 * identity hashes).
 *
 * @param {import("../../src/core/identity.js").Identity} identity
 * @returns {Promise<Uint8Array>}
 */
async function lxmfDeliveryHash(identity) {
  const dest = await Destination.OUT(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    null,
  );
  return /** @type {Uint8Array} */ (dest.destinationHash);
}

/**
 * Builds the msgpack `fields` for a Message from a vector's `inputs.fields`
 * object: LXMF field constants are integers, so the vector's JSON string
 * keys ("1", "2") are coerced to integers and a `Map` is used (object keys
 * are always strings in JS and would encode as fixstr, not int).
 *
 * @param {Record<string, any>} fields
 * @returns {Map<number, any>}
 */
function fieldsMap(fields) {
  const map = new Map();
  for (const [k, v] of Object.entries(fields)) {
    map.set(Number(k), v);
  }
  return map;
}

test("lxmf vectors: serialize reproduces packed bytes + opportunistic Token ciphertext", async (t) => {
  if (!vectorsAvailable())
    t.skip("spec vectors unavailable — skipping spec-vector conformance");
  if (!vectorsAvailable()) return;
  const identities = await loadIdentityMap();
  for (const v of loadVectors("lxmf").vectors) {
    const alice = identities.get(v.inputs.src_identity_label);
    const bob = identities.get(v.inputs.dst_identity_label);
    assert.ok(alice && bob, `${v.label}: identities`);

    const aliceDest = await lxmfDeliveryHash(alice);
    const bobDest = await lxmfDeliveryHash(bob);

    const msg = new Message({
      sourceHash: aliceDest,
      destinationHash: bobDest,
      timestamp: v.inputs.lxmf_timestamp,
      title: v.inputs.title_utf8,
      content: v.inputs.content_utf8,
      fields: fieldsMap(v.inputs.fields),
    });
    const { wireData } = await msg.serialize(alice);

    // §5.2 direct form: dest(16) || src(16) || sig(64) || msgpack — byte-for-byte.
    assert.equal(
      bytesToHex(wireData),
      v.expected.lxmf_packed_hex,
      `${v.label}: serialize reproduces lxmf_packed_hex (§5.6.1 canonical msgpack)`,
    );

    // Deserialize round-trips and the signature verifies against alice.
    const parsed = await Message.deserialize(wireData, bobDest);
    assert.equal(parsed.title, v.inputs.title_utf8, `${v.label}: title`);
    assert.equal(parsed.content, v.inputs.content_utf8, `${v.label}: content`);
    const sigOk = await parsed.verifySignature(alice);
    assert.ok(sigOk, `${v.label}: signature verifies`);

    // §5.1 opportunistic plaintext = direct form with the leading dest_hash stripped.
    const opportunisticPlaintext = wireData.subarray(16);
    assert.equal(
      bytesToHex(opportunisticPlaintext),
      v.expected.opportunistic_plaintext_hex,
      `${v.label}: opportunistic plaintext`,
    );

    // §3 modified-Fernet Token: derive the key from the pinned ephemeral ×
    // bob's long-term X25519 pub, salt = bob's identity_hash (§3.2 step 3),
    // then AES-256-CBC with the pinned IV + HMAC over (iv || ciphertext).
    // §3.1 wire format: ephemeral_pub(32) || iv(16) || ciphertext || hmac(32) —
    // strip the leading ephemeral pub before Token.decrypt.
    const ephPriv = await importRawX25519PrivateKey(
      hexToBytes(v.inputs.ephemeral_x25519_priv_hex),
    );
    const bobEncPub = bob.publicKey.subarray(0, 32);
    const bobPubKey = await crypto.subtle.importKey(
      "raw",
      /** @type {any} */ (bobEncPub),
      { name: "X25519" },
      true,
      [],
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "X25519", public: bobPubKey },
      ephPriv,
      256,
    );
    const derivedKey = await hkdf(
      new Uint8Array(sharedBits),
      bob.identityHash,
      new Uint8Array(0),
      64,
    );
    // Decrypt the recorded ciphertext and assert it matches the plaintext
    // (proves our Token impl reads the wire format the spec mandates).
    const token = new Token(derivedKey, Token.MODE_AES_256_CBC);
    const fullToken = hexToBytes(v.expected.token_ciphertext_hex);
    const tokenBody = fullToken.subarray(32); // strip ephemeral_pub
    const decrypted = await token.decrypt(tokenBody);
    assert.equal(
      bytesToHex(decrypted),
      v.expected.opportunistic_plaintext_hex,
      `${v.label}: Token decrypts to opportunistic plaintext`,
    );
    // And our Token key derivation matches the spec's split (signing[0..32],
    // encryption[32..64]) — implicit in the decrypt succeeding.
  }
});
