/**
 * Spec test-vectors — Identity (SPEC §1.1, §1.2).
 *
 * Loads each identity via `Identity.fromBytes(private_key_hex)` (the
 * spec's documented recipe) and asserts the derived `identityHash`,
 * `nameHash`, `publicKey`, and the `destination_hash` for the recorded
 * `destination_full_name` (`lxmf.delivery`) match the known-good bytes.
 *
 * @module test/spec-vectors/identities.test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType } from "../../src/core/packet.js";
import {
  bytesToHex,
  hexToBytes,
  loadVectors,
  vectorsAvailable,
} from "./_loader.js";

test("identity vectors: fromBytes derives identity_hash / name_hash / destination_hash", async (t) => {
  if (!vectorsAvailable())
    t.skip("spec vectors unavailable — skipping spec-vector conformance");
  if (!vectorsAvailable()) return;
  const { vectors } = loadVectors("identities");
  for (const v of vectors) {
    const id = await Identity.fromPrivateKey(
      hexToBytes(v.inputs.private_key_hex),
    );
    assert.ok(id, `failed to load identity ${v.label}`);
    assert.equal(
      bytesToHex(id.identityHash),
      v.expected.identity_hash_hex,
      `${v.label}: identity_hash`,
    );
    assert.equal(
      bytesToHex(id.publicKey),
      v.expected.public_key_hex,
      `${v.label}: public_key`,
    );
    // name_hash = SHA256(full_app_name_string)[:10] (SPEC §1.1/§4.2).
    const enc = new TextEncoder();
    const nameHashBuf = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        enc.encode(v.destination_full_name),
      ),
    ).slice(0, 10);
    assert.equal(
      bytesToHex(nameHashBuf),
      v.expected.name_hash_hex,
      `${v.label}: name_hash`,
    );
    // destination_hash = SHA256(name_hash || identity_hash)[:16] (SPEC §1.2).
    const dest = await Destination.OUT(
      v.destination_full_name,
      DestType.SINGLE,
      id,
      null,
    );
    assert.equal(
      bytesToHex(dest.destinationHash),
      v.expected.destination_hash_hex,
      `${v.label}: destination_hash`,
    );
  }
});
