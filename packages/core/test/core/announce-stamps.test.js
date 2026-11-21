/**
 * RNS 1.6.0 announce stamps — receive-side conformance.
 *
 * The fixture announce in `fixtures/rns160-announce.json` was emitted by the
 * Python reference implementation (`./Reticulum/RNS`, 1.6.0) with destination stamps
 * enabled (target value 3.0, required cost 2.5, link cost 12.5). These tests
 * assert that `Identity.validateAnnounce` parses the 18-byte extension
 * payload exactly like the Python reference: stamp validated, app_data
 * stripped, fractional value and link cost surfaced — and that enforcement
 * and insufficient-value behavior match.
 *
 * @module test/core/announce-stamps.test
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import { Packet, PacketType } from "../../src/core/packet.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/rns160-announce.json", import.meta.url),
    "utf8",
  ),
);

const hexToBytes = (/** @type {string} */ hex) =>
  new Uint8Array(hex.match(/.{1,2}/g).map((b) => Number.parseInt(b, 16)));

/** Required announce stamp cost the Python emitter was configured with. */
const REQUIRED_COST = 2.5;

/** The Python-emitted stamped announce, wire bytes deserialized. */
function pythonStampedAnnounce() {
  const packet = Packet.deserialize(hexToBytes(fixture.wire));
  assert.equal(packet.packetType, PacketType.ANNOUNCE);
  return { packet };
}

test("parses a Python-reference stamped announce", async () => {
  const { packet } = pythonStampedAnnounce();
  const result = await Identity.validateAnnounce(
    packet.destinationHash,
    packet.contextFlag,
    packet.payload,
    { requiredStampValue: REQUIRED_COST },
  );
  assert.ok(result, "announce validates");
  assert.strictEqual(result.stampValidated, true);
  assert.strictEqual(result.stamp.length, 14);
  assert.strictEqual(result.stampValue, fixture.recalledStampValue);
  assert.strictEqual(result.linkCost, fixture.linkCost);
  // Extension payload stripped — application sees its own app_data only.
  assert.strictEqual(
    new TextDecoder().decode(result.appData),
    fixture.appDataPlain,
  );
  assert.strictEqual(
    Buffer.from(packet.destinationHash).toString("hex"),
    fixture.destHash,
  );
});

test("default required value leaves an insufficient stamp in place", async () => {
  const { packet } = pythonStampedAnnounce();
  // Default required value (23.5) exceeds the emitted value (~4.6): the
  // announce is still accepted (no enforcement), but the stamp is flagged
  // unvalidated and the extension payload stays inside app_data.
  const result = await Identity.validateAnnounce(
    packet.destinationHash,
    packet.contextFlag,
    packet.payload,
  );
  assert.ok(result, "announce still validates without enforcement");
  assert.strictEqual(result.stampValidated, false);
  assert.strictEqual(result.linkCost, null);
  const plain = new TextEncoder().encode(fixture.appDataPlain).length;
  assert.strictEqual(result.appData.length, plain + 18);
});

test("enforcement rejects announces below the required value", async () => {
  const { packet } = pythonStampedAnnounce();
  const result = await Identity.validateAnnounce(
    packet.destinationHash,
    packet.contextFlag,
    packet.payload,
    { enforceStamps: true },
  );
  assert.strictEqual(result, null, "stamp below required value rejected");
});

test("a re-signed announce with an invalid stamp is detected", async () => {
  const { packet } = pythonStampedAnnounce();
  // The fixture carries the emitting identity's private key, so we can
  // re-sign a body whose stamp is corrupted — exercising the stamp-validity
  // path (not just the signature path).
  const identity = await Identity.fromPrivateKey(
    hexToBytes(fixture.identityPrivateKey),
  );
  assert.ok(identity, "fixture identity loads");
  // Announce body (context_flag unset): pub(64) name(10) random(10)
  // sig(64) app_data(incl. 18-byte ext payload).
  const payload = Uint8Array.from(packet.payload);
  const appData = payload.subarray(148);
  assert.strictEqual(appData.length, 18 + fixture.appDataPlain.length);
  const extStart = appData.length - 18;
  appData[extStart + 2] ^= 0x40; // corrupt one stamp byte
  const signedData = new Uint8Array(16 + 84 + appData.length);
  signedData.set(packet.destinationHash, 0);
  signedData.set(payload.subarray(0, 84), 16);
  signedData.set(appData, 100);
  const signature = await identity.sign(signedData);
  const tamperedBody = new Uint8Array(payload.length);
  tamperedBody.set(payload.subarray(0, 84), 0);
  tamperedBody.set(signature, 84);
  tamperedBody.set(appData, 148);
  const result = await Identity.validateAnnounce(
    packet.destinationHash,
    packet.contextFlag,
    tamperedBody,
    { requiredStampValue: REQUIRED_COST },
  );
  assert.ok(result, "signature verifies over the tampered body");
  assert.strictEqual(result.stampValidated, false);
  assert.strictEqual(result.linkCost, null);
  // Enforced: rejected outright.
  const enforced = await Identity.validateAnnounce(
    packet.destinationHash,
    packet.contextFlag,
    tamperedBody,
    { requiredStampValue: REQUIRED_COST, enforceStamps: true },
  );
  assert.strictEqual(enforced, null);
});

/**
 * Rebuilds the announce body with a mutation applied to the app_data (the
 * extension payload rides inside it) and a fresh Ed25519 signature from the
 * fixture identity — so signature verification passes and the mutation
 * specifically exercises the stamp-parsing logic.
 *
 * @param {(payload: Uint8Array) => void} mutate
 */
async function reSignedWith(mutate) {
  const { packet } = pythonStampedAnnounce();
  const identity = await Identity.fromPrivateKey(
    hexToBytes(fixture.identityPrivateKey),
  );
  assert.ok(identity, "fixture identity loads");
  const payload = Uint8Array.from(packet.payload);
  mutate(payload);
  const appData = payload.subarray(148);
  const signedData = new Uint8Array(16 + 84 + appData.length);
  signedData.set(packet.destinationHash, 0);
  signedData.set(payload.subarray(0, 84), 16);
  signedData.set(appData, 100);
  const signature = await identity.sign(signedData);
  const body = new Uint8Array(payload.length);
  body.set(payload.subarray(0, 84), 0);
  body.set(signature, 84);
  body.set(appData, 148);
  return { destinationHash: packet.destinationHash, body, payload };
}

test("unknown extension markers keep app_data untouched", async () => {
  const { destinationHash, contextFlag, body, payload } = await reSignedWith(
    (payload) => {
      payload[payload.length - 18] = 0xc2; // unknown marker
    },
  );
  const result = await Identity.validateAnnounce(
    destinationHash,
    contextFlag,
    body,
    { requiredStampValue: REQUIRED_COST },
  );
  assert.ok(result, "announce validates — extension treated as app_data");
  assert.strictEqual(result.stampValidated, false);
  assert.strictEqual(result.appData.length, body.length - 148);
});

test("extended-flag announces are not treated as stamped", async () => {
  const { destinationHash, contextFlag, body } = await reSignedWith(
    (payload) => {
      payload[payload.length - 1] |= 0x80; // anchor MSB: future format
    },
  );
  const result = await Identity.validateAnnounce(
    destinationHash,
    contextFlag,
    body,
    { requiredStampValue: REQUIRED_COST },
  );
  assert.ok(result, "announce validates — unknown extension format");
  assert.strictEqual(result.stampValidated, false);
});

// --- Emit side (RNS 1.6.0 destination stamps) -------------------------------

import { Destination, Direction } from "../../src/core/destination.js";
import { DestType } from "../../src/core/packet.js";
import { TransportCore } from "../../src/transport/transport.js";

test("stamped emission appends a valid extension payload", async () => {
  const identity = await Identity.generate();
  /** @type {any[]} */
  const captured = [];
  /** @type {any} */
  const fakeLayer = { broadcast: (pkt) => captured.push(pkt) };
  const dest = await Destination.IN(
    "stampedapp",
    DestType.SINGLE,
    identity,
    fakeLayer,
  );
  dest.setLinkCost(12.5);
  dest.appData = new TextEncoder().encode("js-stamped-announce");

  const originalStamp = TransportCore.STAMP_DESTINATIONS;
  const originalValue = TransportCore.DESTINATION_VALUE;
  const originalCost = TransportCore.DESTINATION_COST;
  try {
    // Cheap values so mining stays instant; targets floor at
    // DESTINATION_VALUE, required cost at DESTINATION_COST.
    TransportCore.DESTINATION_VALUE = 4.0;
    TransportCore.DESTINATION_COST = 3.5;
    TransportCore.STAMP_DESTINATIONS = true;
    // Lower the destination's own target too — the effective emission target
    // is max(destination target, DESTINATION_VALUE), and the unconfigured
    // default (DESTINATION_COST = 23.5 bits) takes ~minutes to mine.
    dest.setStampValue(4.0);
    await dest.announce();
    assert.strictEqual(captured.length, 1, "announce went on air");

    const packet = captured[0];
    const result = await Identity.validateAnnounce(
      packet.destinationHash,
      packet.contextFlag,
      packet.payload,
      { requiredStampValue: 3.5 },
    );
    assert.ok(result, "self-emitted announce validates");
    assert.strictEqual(result.stampValidated, true);
    assert.strictEqual(result.stamp.length, 14);
    assert.ok(result.stampValue >= 4.0, "stamp meets the emission target");
    assert.strictEqual(result.linkCost, 12.5);
    assert.strictEqual(
      new TextDecoder().decode(result.appData),
      "js-stamped-announce",
    );

    // Stamps are one-shot: a second announce reuses the same stamp bytes.
    await dest.announce();
    assert.strictEqual(captured.length, 2);
    const first = await Identity.validateAnnounce(
      captured[0].destinationHash,
      captured[0].contextFlag,
      captured[0].payload,
      { requiredStampValue: 3.5 },
    );
    const second = await Identity.validateAnnounce(
      captured[1].destinationHash,
      captured[1].contextFlag,
      captured[1].payload,
      { requiredStampValue: 3.5 },
    );
    assert.deepStrictEqual(first.stamp, second.stamp);
  } finally {
    TransportCore.STAMP_DESTINATIONS = originalStamp;
    TransportCore.DESTINATION_VALUE = originalValue;
    TransportCore.DESTINATION_COST = originalCost;
  }
});

test("stamping can be disabled — unstamped announce emission", async () => {
  // RNS 1.6.1 enables destination stamping by default (upstream
  // `STAMP_DESTINATIONS = True`); this test exercises the opt-out.
  const identity = await Identity.generate();
  /** @type {any[]} */
  const captured = [];
  /** @type {any} */
  const fakeLayer = { broadcast: (pkt) => captured.push(pkt) };
  const dest = await Destination.IN(
    "plainapp",
    DestType.SINGLE,
    identity,
    fakeLayer,
  );
  dest.setLinkCost(12.5);
  const originalStamp = TransportCore.STAMP_DESTINATIONS;
  try {
    TransportCore.STAMP_DESTINATIONS = false;
    await dest.announce();
    assert.strictEqual(captured.length, 1);
    const packet = captured[0];
    const result = await Identity.validateAnnounce(
      packet.destinationHash,
      packet.contextFlag,
      packet.payload,
    );
    assert.ok(result, "unstamped announce validates");
    assert.strictEqual(result.stampValidated, false);
    assert.strictEqual(result.stamp, null);
    assert.strictEqual(result.linkCost, null);
    assert.strictEqual(result.appData, null);
  } finally {
    TransportCore.STAMP_DESTINATIONS = originalStamp;
  }
});

test("destination stamping is on by default (RNS 1.6.1)", () => {
  assert.strictEqual(TransportCore.STAMP_DESTINATIONS, true);
  assert.strictEqual(TransportCore.STAMP_PATH_REQUESTS, true);
  // Enforcement stays off until upstream flips it.
  assert.strictEqual(TransportCore.STAMPS_ENFORCED, false);
  assert.strictEqual(TransportCore.LR_STAMPS_ENFORCED, false);
});

test("committed JS-emitted fixture stays Python-identical", async () => {
  // The wire bytes in fixtures/rns160-announce-js-emitted.json were validated
  // by the Python 1.6.0 reference (validate_announce accepted, stamp value
  // 4.69921875, link cost 12.5, app_data 'js-roundtrip' recalled). Any change
  // to our ext-payload emission must keep these bytes' semantics stable.
  const emitted = JSON.parse(
    readFileSync(
      new URL("../fixtures/rns160-announce-js-emitted.json", import.meta.url),
      "utf8",
    ),
  );
  const packet = Packet.deserialize(hexToBytes(emitted.wire));
  const result = await Identity.validateAnnounce(
    packet.destinationHash,
    packet.contextFlag,
    packet.payload,
    { requiredStampValue: 3.5 },
  );
  assert.ok(result, "committed fixture validates");
  assert.strictEqual(result.stampValidated, true);
  assert.strictEqual(result.stampValue, 4.69921875);
  assert.strictEqual(result.linkCost, 12.5);
  assert.strictEqual(new TextDecoder().decode(result.appData), "js-roundtrip");
});
