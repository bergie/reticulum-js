import assert from "node:assert";
import { test } from "node:test";
import {
  generateStamp as defaultGenerateStamp,
  stampValid as defaultStampValid,
  stampValue as defaultStampValue,
  stampWorkblock as defaultStampWorkblock,
  getStamper,
  setStamper,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
} from "@reticulum/core/src/utils/stamper.js";
import {
  fullHashSync,
  generateStampSync,
  stampTargetBytes,
  stampValidSync,
  stampValueSync,
  stampWorkblockSync,
} from "../../src/utils/stamp-crypto.js";
import {
  nodeStamper,
  stampWorkerRunning,
  stopNodeStamper,
  useNodeStamper,
} from "../../src/utils/stamper.js";

const hexToBytes = (/** @type {string} */ hex) =>
  new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

// Vector generated with Python LXMF.LXStamper (same as the core/lxmf tests).
const material = hexToBytes(
  "01310dfe3bcb204b5bc6889def4de0cc6f98b64972a17399866cffb0651cf890",
);

/** BigInt reference implementation of the validity rule (Python semantics). */
async function referenceValid(stamp, targetCost, workblock) {
  const material = new Uint8Array(workblock.length + stamp.length);
  material.set(workblock, 0);
  material.set(stamp, workblock.length);
  const hash = await fullHashSync(material);
  let hex = "";
  for (const b of hash) hex += b.toString(16).padStart(2, "0");
  return BigInt(`0x${hex}`) <= 1n << BigInt(256 - targetCost);
}

test("node:crypto stamp primitives", async (t) => {
  await t.test(
    "stampWorkblockSync is byte-identical to the WebCrypto default engine",
    async () => {
      const rounds = 30;
      const fast = stampWorkblockSync(material, rounds);
      const reference = await defaultStampWorkblock(material, rounds);
      assert.strictEqual(fast.length, rounds * 256);
      assert.deepStrictEqual(fast, reference);
    },
  );

  await t.test(
    "stampValidSync agrees with the BigInt reference across the boundary",
    async () => {
      const wb = stampWorkblockSync(material, 2);
      for (const targetCost of [1, 8, 9, 16, 128, 255, 256]) {
        for (let i = 0; i < 32; i++) {
          const stamp = crypto.getRandomValues(new Uint8Array(32));
          assert.strictEqual(
            stampValidSync(stamp, targetCost, wb),
            await referenceValid(stamp, targetCost, wb),
            `cost ${targetCost} trial ${i}`,
          );
        }
      }
    },
  );

  await t.test("stampTargetBytes encodes 2^(256-cost)", () => {
    // 2^248 = 0x01 followed by 31 zero bytes.
    assert.deepStrictEqual(stampTargetBytes(8)[0], 0x01);
    assert.deepStrictEqual(
      Array.from(stampTargetBytes(8).slice(1)),
      new Array(31).fill(0),
    );
    // 2^240 = byte 1 carries the 0x01.
    assert.deepStrictEqual(
      Array.from(stampTargetBytes(16).slice(0, 2)),
      [0x00, 0x01],
    );
    // 2^255 = 0x80.
    assert.deepStrictEqual(stampTargetBytes(1)[0], 0x80);
    // 2^0 = 1 in the last byte.
    assert.deepStrictEqual(stampTargetBytes(256)[31], 0x01);
    assert.throws(() => stampTargetBytes(0), RangeError);
    assert.throws(() => stampTargetBytes(257), RangeError);
  });

  await t.test(
    "stampValueSync matches the WebCrypto default engine",
    async () => {
      const wb = stampWorkblockSync(material, 2);
      for (let i = 0; i < 8; i++) {
        const stamp = crypto.getRandomValues(new Uint8Array(32));
        assert.strictEqual(
          stampValueSync(wb, stamp),
          await defaultStampValue(wb, stamp),
        );
      }
    },
  );

  await t.test(
    "generateStampSync finds stamps that the default engine validates",
    async () => {
      const [stamp, value] = generateStampSync(
        material,
        8,
        WORKBLOCK_EXPAND_ROUNDS_PEERING,
      );
      assert.strictEqual(stamp.length, 32);
      assert.ok(value >= 8);
      const wb = await defaultStampWorkblock(
        material,
        WORKBLOCK_EXPAND_ROUNDS_PEERING,
      );
      assert.ok(await defaultStampValid(stamp, 8, wb));
      assert.strictEqual(await defaultStampValue(wb, stamp), value);
    },
  );
});

test("node stamp engine (worker + LRU cache)", async (t) => {
  t.after(async () => {
    // Always restore the WebCrypto default and release the worker.
    setStamper(null);
    await stopNodeStamper();
  });

  await t.test("useNodeStamper installs the engine explicitly", () => {
    const before = getStamper();
    assert.notStrictEqual(before, nodeStamper);
    assert.strictEqual(useNodeStamper(), nodeStamper);
    assert.strictEqual(getStamper(), nodeStamper);
  });

  await t.test(
    "engine workblocks are byte-identical to the WebCrypto default",
    async () => {
      const rounds = 30;
      const fast = await nodeStamper.stampWorkblock(material, rounds);
      const reference = await defaultStampWorkblock(material, rounds);
      assert.deepStrictEqual(fast, reference);
    },
  );

  await t.test(
    "stampWorkblock results are LRU-cached by material",
    async () => {
      const first = await nodeStamper.stampWorkblock(material, 2);
      const second = await nodeStamper.stampWorkblock(material, 2);
      assert.strictEqual(second, first, "repeat lookups must hit the cache");
      const other = await nodeStamper.stampWorkblock(
        crypto.getRandomValues(new Uint8Array(32)),
        2,
      );
      assert.notStrictEqual(other, first);
    },
  );

  await t.test(
    "engine stampValid/stampValue agree with the WebCrypto default",
    async () => {
      const wb = await nodeStamper.stampWorkblock(material, 2);
      for (let i = 0; i < 16; i++) {
        const stamp = crypto.getRandomValues(new Uint8Array(32));
        assert.strictEqual(
          await nodeStamper.stampValid(stamp, 9, wb),
          await defaultStampValid(stamp, 9, wb),
        );
        assert.strictEqual(
          await nodeStamper.stampValue(wb, stamp),
          await defaultStampValue(wb, stamp),
        );
      }
    },
  );

  await t.test(
    "generateStamp runs off-thread and produces default-engine-valid stamps",
    async () => {
      const [stamp, value] = await nodeStamper.generateStamp(
        material,
        8,
        WORKBLOCK_EXPAND_ROUNDS_PEERING,
      );
      assert.ok(stampWorkerRunning(), "the stamp worker should be running");
      assert.strictEqual(stamp.length, 32);
      assert.ok(value >= 8);
      const wb = await defaultStampWorkblock(
        material,
        WORKBLOCK_EXPAND_ROUNDS_PEERING,
      );
      assert.ok(await defaultStampValid(stamp, 8, wb));
      assert.strictEqual(await defaultStampValue(wb, stamp), value);
    },
  );

  await t.test(
    "stopNodeStamper releases the worker but keeps the engine",
    async () => {
      await stopNodeStamper();
      assert.ok(!stampWorkerRunning());
      // The engine remains installed and functional (worker respawns lazily).
      assert.strictEqual(getStamper(), nodeStamper);
      const wb = await nodeStamper.stampWorkblock(material, 2);
      assert.deepStrictEqual(wb, await defaultStampWorkblock(material, 2));
    },
  );
});

test("core generateStamp via the installed node engine stays compatible", async () => {
  useNodeStamper();
  try {
    const messageId = crypto.getRandomValues(new Uint8Array(32));
    const [stamp, value] = await defaultGenerateStamp(
      messageId,
      8,
      WORKBLOCK_EXPAND_ROUNDS_PEERING,
    );
    assert.ok(value >= 8);
    const wb = await defaultStampWorkblock(
      messageId,
      WORKBLOCK_EXPAND_ROUNDS_PEERING,
    );
    assert.ok(await defaultStampValid(stamp, 8, wb));
  } finally {
    setStamper(null);
    await stopNodeStamper();
  }
});
