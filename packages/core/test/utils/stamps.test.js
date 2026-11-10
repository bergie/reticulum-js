/**
 * RNS 1.6.0 network stamp primitives (`src/utils/stamps.js`) — conformance
 * against the Python reference (`Reticulum/RNS/Stamps.py`).
 *
 * All vectors in `fixtures/rns160-stamps.json` were generated with the
 * vendored Python 1.6.0 reference: fixed-point cost helpers, target values,
 * mined 14-byte stamps (values + validity sweeps) and mantissa-table
 * digests. The materials are SHA-256 of their labels, so any implementation
 * can rederive them without long literals.
 *
 * A live-generation block exercises `generateStamp` / `generateStampedKey`
 * at low costs to keep the suite fast (a cost-6.25 search is ~2^6 trials).
 *
 * @module test/utils/stamps.test
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fullHash, stampWorkblock } from "../../src/utils/stamper.js";
import {
  COST_FP,
  COST_FP_BITS,
  costFromBytes,
  costFromFp,
  costInt,
  costToBytes,
  costToFp,
  fpFromBytes,
  fpToBytes,
  generateStamp,
  generateStampedKey,
  MANTISSA_BITS,
  quantizeCost,
  STAMP_COST_CAP,
  STAMP_LENGTH,
  stampValid,
  stampValue,
  TAB,
  targetFromCost,
  targetFromFp,
} from "../../src/utils/stamps.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/rns160-stamps.json", import.meta.url),
    "utf8",
  ),
);

const hexToBytes = (/** @type {string} */ hex) =>
  new Uint8Array(hex.match(/.{1,2}/g).map((b) => Number.parseInt(b, 16)));

/** @param {string} label */
function materialFor(label) {
  return hexToBytes(fixture.materials[label]);
}

test("constants match the Python reference", () => {
  assert.strictEqual(STAMP_LENGTH, 14);
  assert.strictEqual(STAMP_COST_CAP, 100);
  assert.strictEqual(MANTISSA_BITS, 33);
  assert.strictEqual(COST_FP_BITS, 8);
  assert.strictEqual(COST_FP, 256);
});

test("mantissa table matches the Python TAB digest", async () => {
  const joined = TAB.join(",");
  const digest = Buffer.from(
    await fullHash(new TextEncoder().encode(joined)),
  ).toString("hex");
  assert.strictEqual(digest, fixture.tabDigest);
  // PRM digest pins the table together with the layout constants, exactly
  // like the Python reference's load-time assertions.
  const prmMaterial = `master|${digest}|${MANTISSA_BITS}|${TAB.length}|${COST_FP_BITS}|${COST_FP}|`;
  const prmDigest = Buffer.from(
    await fullHash(new TextEncoder().encode(prmMaterial)),
  ).toString("hex");
  assert.strictEqual(prmDigest, fixture.prmDigest);
});

test("fixed-point cost helpers match Python", () => {
  for (const [cost, fp] of Object.entries(fixture.costToFp)) {
    assert.strictEqual(costToFp(Number(cost)), fp, `costToFp(${cost})`);
  }
  for (const [fp, hex] of Object.entries(fixture.fpToBytes)) {
    assert.deepStrictEqual(
      fpToBytes(Number(fp)),
      hexToBytes(hex),
      `fpToBytes(${fp})`,
    );
    assert.strictEqual(
      fpFromBytes(hexToBytes(hex)),
      Number(fp),
      `fpFromBytes(${hex})`,
    );
    assert.deepStrictEqual(
      costToBytes(Number(fp) / COST_FP),
      hexToBytes(hex),
      `costToBytes(${fp}/256)`,
    );
    assert.strictEqual(
      costFromBytes(hexToBytes(hex)),
      Number(fp) / COST_FP,
      `costFromBytes(${hex})`,
    );
  }
  for (const [cost, fp] of Object.entries(fixture.quantizeCost)) {
    assert.strictEqual(quantizeCost(Number(cost)), fp, `quantizeCost(${cost})`);
  }
  for (const [fp, int] of Object.entries(fixture.costInt)) {
    assert.strictEqual(costInt(Number(fp)), int, `costInt(${fp})`);
  }
  // costFromFp round-trips on the grid
  assert.strictEqual(costFromFp(4045), 15.80078125);
});

test("targetFromCost / targetFromFp match Python (BigInt targets)", () => {
  for (const [cost, hex] of Object.entries(fixture.targetFromCost)) {
    assert.strictEqual(
      targetFromCost(Number(cost)),
      BigInt(hex),
      `targetFromCost(${cost})`,
    );
  }
  for (const [fp, hex] of Object.entries(fixture.targetFromFp)) {
    assert.strictEqual(
      targetFromFp(Number(fp)),
      BigInt(hex),
      `targetFromFp(${fp})`,
    );
  }
});

test("targetFromFp rejects out-of-range costs", () => {
  assert.throws(() => targetFromFp(-1), RangeError);
  assert.throws(() => targetFromFp(STAMP_COST_CAP * COST_FP + 1), RangeError);
});

test("mined stamp vectors validate against Python values and sweeps", async () => {
  for (const v of fixture.mined) {
    const material = materialFor(v.materialLabel);
    const stamp = hexToBytes(v.stamp);
    assert.strictEqual(stamp.length, STAMP_LENGTH, `${v.label}: 14-byte stamp`);
    // Value must reproduce the Python float exactly (both derive from the
    // same integer fp path).
    assert.strictEqual(
      await stampValue(material, stamp),
      v.value,
      `${v.label}: value`,
    );
    // Achieved value meets the requested cost; validity is inclusive.
    assert.ok(v.value >= v.requiredCost, `${v.label}: value >= requiredCost`);
    assert.strictEqual(
      await stampValid(stamp, v.requiredCost, material),
      true,
      `${v.label}: valid at requiredCost`,
    );
    for (const [cost, expected] of Object.entries(v.validSweep)) {
      assert.strictEqual(
        await stampValid(stamp, Number(cost), material),
        expected,
        `${v.label}: sweep at cost ${cost}`,
      );
    }
  }
});

test("arbitrary stamps match Python fractional values", async () => {
  for (const v of fixture.arbitrary) {
    const material = materialFor(v.materialLabel);
    const stamp = hexToBytes(v.stamp);
    assert.strictEqual(
      await stampValue(material, stamp),
      v.value,
      `${v.materialLabel}: arbitrary value`,
    );
  }
});

test("stampWorkblock with 0 rounds returns the material (Python-faithful)", async () => {
  const material = materialFor("mat0");
  const wb = await stampWorkblock(material, 0);
  assert.strictEqual(wb.length, material.length);
  assert.deepStrictEqual(wb, material);
});

test("generateStamp produces valid 14-byte stamps at fractional costs", async (t) => {
  await t.test("found stamp validates and meets the cost", async () => {
    const material = crypto.getRandomValues(new Uint8Array(32));
    const cost = 6.25;
    const result = await generateStamp(material, cost);
    assert.ok(result, "generation should succeed");
    const [stamp, value] = result;
    assert.strictEqual(stamp.length, STAMP_LENGTH);
    assert.ok(value >= cost, `achieved value ${value} >= ${cost}`);
    assert.strictEqual(await stampValid(stamp, cost, material), true);
  });

  await t.test("abort signal cancels generation", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateStamp(
      crypto.getRandomValues(new Uint8Array(32)),
      16.5,
      { signal: controller.signal },
    );
    assert.strictEqual(result, null);
  });

  await t.test("rejects costs outside the cap", async () => {
    const material = crypto.getRandomValues(new Uint8Array(32));
    assert.rejects(() => generateStamp(material, -1), RangeError);
    assert.rejects(
      () => generateStamp(material, STAMP_COST_CAP + 0.5),
      RangeError,
    );
  });
});

test("generateStampedKey mines X25519 keys as stamps", async (t) => {
  await t.test("stamped public key validates as the stamp itself", async () => {
    const { Identity } = await import("../../src/core/identity.js");
    const { exportRawPrivateKey, generateEd25519KeyPair } = await import(
      "../../src/crypto/keys.js"
    );
    const material = crypto.getRandomValues(new Uint8Array(32));
    const cost = 2.5;
    const key = await generateStampedKey(material, cost);
    assert.ok(key, "key generation should succeed");
    assert.strictEqual(key.publicKey.length, 32);
    assert.strictEqual(key.privateKey.length, 32);
    assert.ok(key.value >= cost, `achieved value ${key.value} >= ${cost}`);
    // The stamped key validates with the public key bytes *as* the stamp.
    assert.strictEqual(await stampValid(key.publicKey, cost, material), true);
    assert.strictEqual(await stampValue(material, key.publicKey), key.value);
    // Python-faithful: the mined key is the X25519 half only. A full
    // stamped identity pairs it with a fresh Ed25519 key (the signing key
    // doubles as the stamp material).
    const ed = await generateEd25519KeyPair();
    const edPrivate = await exportRawPrivateKey(ed.privateKey);
    const blob = new Uint8Array(64);
    blob.set(key.privateKey, 0);
    blob.set(edPrivate, 32);
    const identity = await Identity.fromPrivateKey(blob);
    assert.ok(identity, "private key should load");
    const pubBytes = await identity.getPublicKey();
    assert.deepStrictEqual(pubBytes.slice(0, 32), key.publicKey);
  });

  await t.test("rejects costs outside the cap", async () => {
    const material = crypto.getRandomValues(new Uint8Array(32));
    assert.rejects(() => generateStampedKey(material, -0.5), RangeError);
    assert.rejects(() => generateStampedKey(material, 101), RangeError);
  });

  await t.test("abort signal cancels generation", async () => {
    const controller = new AbortController();
    controller.abort();
    const key = await generateStampedKey(
      crypto.getRandomValues(new Uint8Array(32)),
      8.5,
      { signal: controller.signal },
    );
    assert.strictEqual(key, null);
  });
});
