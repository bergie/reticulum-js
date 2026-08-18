/**
 * rfed channel PoW stamp contract (work doc #25, Phase 0).
 *
 * Verifies the rfed stamp binds to `channel_hash ‖ inner_blob` using the
 * standard LXMF stamper workblock (memory-hard HKDF at rfed's 16 rounds) and
 * the leading-zero-bit value contract, per `RFed/SPEC.md` §3 "PoW STAMP
 * CONTRACT". See `src/rfed/stamp.js`.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import {
  generateStamp,
  stampWorkblock,
  WORKBLOCK_EXPAND_ROUNDS,
} from "../../src/lxmf/stamper.js";
import { STAMP_EXPAND_ROUNDS, STAMP_SIZE } from "../../src/rfed/constants.js";
import {
  channelStampWorkblock,
  generateChannelStamp,
  validateChannelStamp,
} from "../../src/rfed/stamp.js";
import { concatBytes, toHex } from "../../src/utils/encoding.js";

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

describe("rfed channelStampWorkblock (LXMF stamper at 16 rounds)", () => {
  test("transient id = SHA-256(channel_hash ‖ inner_blob)", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(100);
    const { transientId } = await channelStampWorkblock(channelHash, innerBlob);

    const expected = await sha256(concatBytes(channelHash, innerBlob));
    assert.deepStrictEqual(transientId, expected);
  });

  test("workblock is the LXMF memory-hard HKDF expansion at 16 rounds (4096 bytes)", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(100);
    const { transientId, workblock } = await channelStampWorkblock(
      channelHash,
      innerBlob,
    );

    // Same expansion the normal LXMF stamper produces for this transient id.
    const expected = await stampWorkblock(transientId, STAMP_EXPAND_ROUNDS);
    assert.strictEqual(workblock.length, STAMP_EXPAND_ROUNDS * 256);
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

  test("a stamp from the normal LXMF stamper validates against the same material", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(120);
    const { transientId } = await channelStampWorkblock(channelHash, innerBlob);

    // A stamp minted by lxmf/stamper.js directly at rfed's 16 rounds must be
    // accepted — the rfed contract is the LXMF one over this material.
    const [stamp, value] = await generateStamp(
      transientId,
      8,
      STAMP_EXPAND_ROUNDS,
    );
    assert.ok(value >= 8);
    assert.strictEqual(
      await validateChannelStamp(channelHash, innerBlob, stamp, 8),
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

  test("generation is randomized — LXMF random-trial search (two stamps differ)", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(64);
    const [a] = await generateChannelStamp(channelHash, innerBlob, 8);
    const [b] = await generateChannelStamp(channelHash, innerBlob, 8);
    // Same input → same workblock, but random trials yield different stamps
    // (collision probability is negligible).
    assert.notStrictEqual(toHex(a), toHex(b));
  });

  test("an undersized stamp is rejected before hashing", async () => {
    const channelHash = rnd(16);
    const innerBlob = rnd(64);
    assert.strictEqual(
      await validateChannelStamp(channelHash, innerBlob, rnd(31), 8),
      false,
    );
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
    const hash = await Identity.fullHash(concatBytes(workblock, stamp));
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
