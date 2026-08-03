/**
 * rfed channel PoW stamp contract (work doc #25, Phase 0).
 *
 * Verifies the rfed stamp binds to `channel_hash ‖ inner_blob` using the
 * reticulum-rust `LXStamper` workblock (iterated SHA-256) and the
 * leading-zero-bit value contract, per `RFed/SPEC.md` §3 "PoW STAMP
 * CONTRACT". See `src/rfed/stamp.js` for why this mirrors reticulum-rust
 * rather than Python LXMF's memory-hard HKDF workblock.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import {
  stampWorkblock,
  WORKBLOCK_EXPAND_ROUNDS,
} from "../../src/lxmf/stamper.js";
import { STAMP_EXPAND_ROUNDS, STAMP_SIZE } from "../../src/rfed/constants.js";
import {
  channelStampWorkblock,
  generateChannelStamp,
  validateChannelStamp,
} from "../../src/rfed/stamp.js";
import { toHex } from "../../src/utils/encoding.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

const sha256 = (data) =>
  crypto.subtle.digest("SHA-256", data).then((d) => new Uint8Array(d));

describe("rfed stamp constants", () => {
  test("STAMP_EXPAND_ROUNDS is 16 — distinct from LXMF PN (1000) and message (3000)", () => {
    assert.strictEqual(STAMP_EXPAND_ROUNDS, 16);
    assert.notStrictEqual(STAMP_EXPAND_ROUNDS, WORKBLOCK_EXPAND_ROUNDS);
    assert.strictEqual(STAMP_SIZE, 32);
  });
});

describe("rfed channelStampWorkblock (reticulum-rust LXStamper)", () => {
  test("transient id = SHA-256(channel_hash ‖ inner_blob)", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(100);
    const { transientId } = await channelStampWorkblock(channelHash, innerBlob);

    const material = new Uint8Array(channelHash.length + innerBlob.length);
    material.set(channelHash, 0);
    material.set(innerBlob, channelHash.length);
    const expected = await sha256(material);
    assert.deepStrictEqual(transientId, expected);
  });

  test("workblock is iterated SHA-256: SHA-256^(rounds+1)(transient_id), 32 bytes", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(100);
    const { transientId, workblock } = await channelStampWorkblock(
      channelHash,
      innerBlob,
    );

    // Replicate reticulum-rust LXStamper::stamp_workblock independently.
    let expected = await sha256(transientId);
    for (let i = 0; i < STAMP_EXPAND_ROUNDS; i++) {
      expected = await sha256(expected);
    }
    assert.strictEqual(workblock.length, 32);
    assert.deepStrictEqual(workblock, expected);
  });

  test("the workblock changes if inner_blob or channel_hash change", async () => {
    const channelHash = rnd(16);
    const blobA = rnd(80);
    const blobB = rnd(80);
    const a = await channelStampWorkblock(channelHash, blobA);
    const b = await channelStampWorkblock(channelHash, blobB);
    assert.notStrictEqual(toHex(a.transientId), toHex(b.transientId));
    assert.notStrictEqual(toHex(a.workblock), toHex(b.workblock));
  });
});

describe("rfed generateChannelStamp / validateChannelStamp", () => {
  test("a generated stamp validates at its cost (low cost for test speed)", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(120);
    const cost = 8;

    const [stamp, value] = await generateChannelStamp(
      channelHash,
      innerBlob,
      cost,
    );
    assert.strictEqual(stamp.length, STAMP_SIZE);
    assert.ok(value >= cost, `achieved value ${value} >= cost ${cost}`);

    assert.strictEqual(
      await validateChannelStamp(channelHash, innerBlob, stamp, cost),
      true,
    );
  });

  test("a stamp for one blob does not validate a different blob", async () => {
    const channelHash = rnd(16);
    const stamp = (await generateChannelStamp(channelHash, rnd(120), 8))[0];
    assert.strictEqual(
      await validateChannelStamp(channelHash, rnd(120), stamp, 8),
      false,
    );
  });

  test("a stamp under a different channel_hash does not validate", async () => {
    const innerBlob = rnd(120);
    const stamp = (await generateChannelStamp(rnd(16), innerBlob, 8))[0];
    assert.strictEqual(
      await validateChannelStamp(rnd(16), innerBlob, stamp, 8),
      false,
    );
  });

  test("a valid stamp also validates at any lower cost", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(120);
    const [stamp] = await generateChannelStamp(channelHash, innerBlob, 10);
    assert.strictEqual(
      await validateChannelStamp(channelHash, innerBlob, stamp, 6),
      true,
    );
  });

  test("generation is deterministic — sequential nonce search (matches Rust)", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(64);
    const [a] = await generateChannelStamp(channelHash, innerBlob, 8);
    const [b] = await generateChannelStamp(channelHash, innerBlob, 8);
    // Same input → same workblock → same first-valid nonce → same stamp.
    assert.deepStrictEqual(a, b);
  });
});

describe("rfed stamp value semantics", () => {
  test("value = leading-zero-bits of SHA-256(workblock ‖ stamp)", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(64);
    const { workblock } = await channelStampWorkblock(channelHash, innerBlob);
    const [stamp, value] = await generateChannelStamp(
      channelHash,
      innerBlob,
      8,
    );
    const hash = await Identity.fullHash(
      new Uint8Array([...workblock, ...stamp]),
    );
    // Independently count leading zero bits.
    let expected = 0;
    for (const byte of hash) {
      if (byte === 0) expected += 8;
      else {
        expected += Math.clz32(byte) - 24;
        break;
      }
    }
    assert.strictEqual(value, expected);
    assert.ok(value >= 8);
  });
});

describe("rfed stamp workblock switch (reticulum-rust stub → SPEC-correct)", () => {
  // Guards the `USE_RUST_STUB_WORKBLOCK` switch in `src/rfed/stamp.js`: the
  // SPEC-correct (Python-LXMF-compatible) workblock is already wired and must
  // remain callable + distinct from the iterated-SHA-256 stub we use today for
  // live-node interop. When the reticulum-rust PR lands, flipping the switch
  // makes `channelStampWorkblock` return this workblock instead.
  test("the SPEC-correct lxmf workblock is ready, larger, and distinct at 16 rounds", async () => {
    const transientId = rnd(32);

    // Stub (current live-node behaviour): SHA-256 iterated rounds+1 times.
    let stub = await sha256(transientId);
    for (let i = 0; i < STAMP_EXPAND_ROUNDS; i++) stub = await sha256(stub);

    // Correct (switch target): memory-hard HKDF expansion from lxmf/stamper.
    const correct = await stampWorkblock(transientId, STAMP_EXPAND_ROUNDS);

    assert.strictEqual(stub.length, 32);
    assert.strictEqual(correct.length, STAMP_EXPAND_ROUNDS * 256); // 16 × 256 B
    assert.notStrictEqual(toHex(stub), toHex(correct.subarray(0, 32)));
  });
});
