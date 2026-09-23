/**
 * Spec test-vectors — Announce (SPEC §2.1, §4.1–§4.5).
 *
 * Parses each announce's `wire_bytes_hex` via `Packet.deserialize`, feeds
 * the body to `Identity.validateAnnounce`, and asserts the parsed
 * identity/name_hash/destination_hash/app_data match the known-good
 * `expected.fields` decomposition. Where the announce is an
 * `lxmf.delivery` app_data, also asserts the LXMF announce-data parser
 * round-trips the decoded shape.
 *
 * @module test/spec-vectors/announces.test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseAnnounceAppData } from "../../../lxmf/src/announce_data.js";
import { Identity } from "../../src/core/identity.js";
import { Packet } from "../../src/core/packet.js";
import {
  bytesToHex,
  hexToBytes,
  loadIdentityMap,
  loadVectors,
  vectorsAvailable,
} from "./_loader.js";

test("announce vectors: validateAnnounce parses identity/name_hash/app_data", async (t) => {
  if (!vectorsAvailable())
    t.skip("spec vectors unavailable — skipping spec-vector conformance");
  if (!vectorsAvailable()) return;
  const identities = await loadIdentityMap();
  const { vectors } = loadVectors("announces");
  for (const v of vectors) {
    const wire = hexToBytes(v.expected.wire_bytes_hex);
    const packet = Packet.deserialize(wire);
    assert.equal(
      packet.contextFlag ? 1 : 0,
      v.context_flag,
      `${v.label}: context_flag`,
    );
    assert.equal(
      bytesToHex(packet.destinationHash),
      v.expected.destination_hash_hex,
      `${v.label}: header dest_hash`,
    );

    const result = await Identity.validateAnnounce(
      packet.destinationHash,
      packet.contextFlag,
      packet.payload,
    );
    assert.ok(result, `${v.label}: validateAnnounce accepted`);
    const { identity, nameHash, appData } = result;

    // The parsed identity's public key + identity_hash match the inputs
    // identity (loaded from the private key).
    const inputId = identities.get(v.inputs.identity_label);
    assert.ok(inputId, `${v.label}: identity ${v.inputs.identity_label}`);
    assert.equal(
      bytesToHex(identity.publicKey),
      bytesToHex(inputId.publicKey),
      `${v.label}: public_key`,
    );
    assert.equal(
      bytesToHex(nameHash),
      v.expected.fields.body_name_hash_hex,
      `${v.label}: name_hash`,
    );
    // body_random_hash carries the pinned prefix + timestamp (§4.1).
    assert.equal(
      bytesToHex(result.randomHash),
      v.expected.fields.body_random_hash_hex,
      `${v.label}: random_hash`,
    );
    assert.equal(
      bytesToHex(result.signature),
      v.expected.fields.body_signature_hex,
      `${v.label}: signature`,
    );

    // app_data: assert the raw bytes match, then (when lxmf-shaped) parse.
    if (v.expected.fields.body_app_data_hex) {
      assert.equal(
        bytesToHex(appData ?? new Uint8Array()),
        v.expected.fields.body_app_data_hex,
        `${v.label}: app_data bytes`,
      );
    }

    // The vector's destination_full_name is a custom `vectors.*` aspect
    // (not lxmf.delivery), so the LXMF announce-data parser is only
    // exercised when app_data is the LXMF 2/3-element shape. The vectors
    // here use a 2-element `[name, stamp_cost]` form; verify our parser
    // round-trips it for parity with Python's toleration rules.
    const decoded = parseAnnounceAppData(appData);
    assert.ok(decoded, `${v.label}: parseAnnounceAppData decoded`);
    assert.equal(
      decoded.displayName,
      v.inputs.app_data_decoded[0],
      `${v.label}: app_data display name`,
    );
    assert.equal(
      decoded.stampCost,
      v.inputs.app_data_decoded[1],
      `${v.label}: app_data stamp_cost`,
    );
  }
});
