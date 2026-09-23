/**
 * Spec test-vectors — Link handshake (SPEC §6.1–§6.4, §6.6).
 *
 * The vector pins the initiator/responder ephemerals so the handshake bytes
 * and derived session keys are reproducible. `Link.initiate` generates its
 * own ephemerals (no injection), so we exercise the **parse/derive side** —
 * the interop-critical half for a leaf receiving a link request — and
 * reproduce the ECDH + HKDF that both sides must agree on:
 *
 *   - `linkIdFromLrPacket(linkrequest_raw)` === `expected.link_id_hex`
 *   - parsed LINKREQUEST initiator pubs + signalling match
 *   - LRPROOF body parses to signature + responder_X25519 + signalling, and
 *     the signature verifies against the responder's long-term Ed25519 pub
 *   - `shared_secret` = ECDH(responder_x25519_priv, initiator_x25519_pub)
 *   - `derived_key`   = HKDF(shared, salt=link_id, info="", L=64)
 *   - the LRRTT packet's Token body decrypts (derived key + recorded IV) to
 *     the recorded plaintext (§6.4.2 / §3)
 *
 * @module test/spec-vectors/links.test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Packet } from "../../src/core/packet.js";
import { hkdf } from "../../src/crypto/ciphers.js";
import { importRawX25519PrivateKey } from "../../src/crypto/keys.js";
import { Token } from "../../src/crypto/token.js";
import { linkIdFromLrPacket } from "../../src/transport/link.js";
import {
  bytesToHex,
  hexToBytes,
  loadIdentityMap,
  loadVectors,
  vectorsAvailable,
} from "./_loader.js";

test("link vector: link_id, LRPROOF signature, ECDH shared secret + HKDF derived key", async (t) => {
  if (!vectorsAvailable())
    t.skip("spec vectors unavailable — skipping spec-vector conformance");
  if (!vectorsAvailable()) return;
  const identities = await loadIdentityMap();
  const [v] = loadVectors("links").vectors;
  const exp = v.expected;

  // --- link_id from the recorded LINKREQUEST wire bytes (§6.3). ---
  const lrRaw = hexToBytes(exp.linkrequest_raw_hex);
  const lrPacket = Packet.deserialize(lrRaw);
  lrPacket.raw = lrRaw;
  const linkId = await linkIdFromLrPacket(lrPacket);
  assert.equal(bytesToHex(linkId), exp.link_id_hex, "link_id");

  // --- LINKREQUEST body: initiator_X25519(32) || initiator_Ed25519(32) || signalling(3). ---
  const lrBody = lrPacket.payload;
  assert.equal(
    bytesToHex(lrBody.subarray(0, 32)),
    exp.linkrequest_fields.initiator_x25519_pub_hex,
    "initiator x25519 pub",
  );
  assert.equal(
    bytesToHex(lrBody.subarray(32, 64)),
    exp.linkrequest_fields.initiator_ed25519_pub_hex,
    "initiator ed25519 pub",
  );
  assert.equal(
    bytesToHex(lrBody.subarray(64, 67)),
    exp.linkrequest_fields.signalling_hex,
    "LINKREQUEST signalling",
  );

  // --- LRPROOF body: signature(64) || responder_X25519(32) || signalling(3) (§6.2). ---
  const lrproofBody = hexToBytes(exp.lrproof_body_hex);
  const signature = lrproofBody.subarray(0, 64);
  const responderX25519Pub = lrproofBody.subarray(64, 96);
  const signalling = lrproofBody.subarray(96, 99);
  assert.equal(
    bytesToHex(signature),
    exp.lrproof_fields.signature_hex,
    "LRPROOF signature",
  );
  assert.equal(
    bytesToHex(responderX25519Pub),
    exp.lrproof_fields.responder_x25519_pub_hex,
    "responder x25519 pub",
  );
  assert.equal(
    bytesToHex(signalling),
    exp.lrproof_fields.signalling_hex,
    "LRPROOF signalling",
  );

  // signed_data = link_id || responder_X25519 || responder_Ed25519 || signalling
  const responder = identities.get(v.inputs.responder_identity_label);
  assert.ok(responder, "responder identity");
  const responderEd25519Pub = responder.publicKey.subarray(32, 64);
  const signedData = new Uint8Array(
    linkId.length +
      responderX25519Pub.length +
      responderEd25519Pub.length +
      signalling.length,
  );
  let off = 0;
  signedData.set(linkId, off);
  off += linkId.length;
  signedData.set(responderX25519Pub, off);
  off += responderX25519Pub.length;
  signedData.set(responderEd25519Pub, off);
  off += responderEd25519Pub.length;
  signedData.set(signalling, off);
  const ok = await responder.validate(signature, signedData);
  assert.ok(ok, "LRPROOF signature verifies against responder identity");

  // --- shared_secret = ECDH(responder_x25519_priv, initiator_x25519_pub) (§6.4). ---
  const responderPriv = await importRawX25519PrivateKey(
    hexToBytes(v.inputs.responder_x25519_priv_hex),
  );
  const initiatorPub = await crypto.subtle.importKey(
    "raw",
    /** @type {any} */ (
      hexToBytes(exp.linkrequest_fields.initiator_x25519_pub_hex)
    ),
    { name: "X25519" },
    true,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: initiatorPub },
    responderPriv,
    256,
  );
  assert.equal(
    bytesToHex(new Uint8Array(sharedBits)),
    exp.shared_secret_hex,
    "shared_secret",
  );

  // --- derived_key = HKDF(shared, salt=link_id, info="", L=64) (§6.4). ---
  const derivedKey = await hkdf(
    new Uint8Array(sharedBits),
    linkId,
    new Uint8Array(0),
    64,
  );
  assert.equal(bytesToHex(derivedKey), exp.derived_key_hex, "derived_key");

  // --- LRRTT: the recorded packet's Token body decrypts to the plaintext (§6.4.2/§3). ---
  // body = IV(16) || ciphertext || HMAC(32); Token.decrypt strips + verifies.
  const lrrtt = exp.lrrtt;
  const token = new Token(derivedKey, Token.MODE_AES_256_CBC);
  const plaintext = await token.decrypt(hexToBytes(lrrtt.body_hex));
  assert.equal(
    bytesToHex(plaintext),
    lrrtt.plaintext_hex,
    "LRRTT Token decrypts to recorded plaintext",
  );
});
