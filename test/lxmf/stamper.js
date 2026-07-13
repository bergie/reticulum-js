import assert from "node:assert";
import fs from "node:fs";
import { test } from "node:test";
import {
  generateStamp,
  STAMP_SIZE,
  stampValid,
  stampValue,
  stampWorkblock,
  WORKBLOCK_EXPAND_ROUNDS,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
  WORKBLOCK_EXPAND_ROUNDS_PN,
} from "../../src/lxmf/stamper.js";

const fixtures = JSON.parse(
  fs.readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
);

const hexToBytes = (/** @type {string} */ hex) =>
  new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

test("LXMF Stamper", async (t) => {
  await t.test("exposes canonical constants", () => {
    assert.strictEqual(STAMP_SIZE, 32);
    assert.strictEqual(WORKBLOCK_EXPAND_ROUNDS, 3000);
    assert.strictEqual(WORKBLOCK_EXPAND_ROUNDS_PN, 1000);
    assert.strictEqual(WORKBLOCK_EXPAND_ROUNDS_PEERING, 25);
  });

  await t.test(
    "stampWorkblock is byte-identical to Python LXStamper",
    async () => {
      const { material_hex, expand_rounds, workblock_hex } = fixtures.workblock;
      const wb = await stampWorkblock(hexToBytes(material_hex), expand_rounds);
      assert.strictEqual(wb.length, workblock_hex.length / 2);
      assert.deepStrictEqual(wb, hexToBytes(workblock_hex));
    },
  );

  await t.test("stampValue matches Python", async () => {
    const { material_hex, expand_rounds, stamp_hex, expected_value } =
      fixtures.workblock;
    const wb = await stampWorkblock(hexToBytes(material_hex), expand_rounds);
    const value = await stampValue(wb, hexToBytes(stamp_hex));
    assert.strictEqual(value, expected_value);
  });

  await t.test("stampValid honours the target cost threshold", async () => {
    const { material_hex, expand_rounds, stamp_hex, expected_value } =
      fixtures.workblock;
    const wb = await stampWorkblock(hexToBytes(material_hex), expand_rounds);
    const stamp = hexToBytes(stamp_hex);
    // The fixture stamp achieves exactly `expected_value` leading-zero bits.
    assert.ok(await stampValid(stamp, expected_value, wb));
    // Demanding one more bit than achieved must fail.
    assert.ok(!(await stampValid(stamp, expected_value + 1, wb)));
  });

  await t.test("generateStamp produces a stamp that validates", async () => {
    const messageId = crypto.getRandomValues(new Uint8Array(32));
    // Keep the work cheap so the test stays fast.
    const cost = 6;
    const result = await generateStamp(
      messageId,
      cost,
      WORKBLOCK_EXPAND_ROUNDS_PEERING,
    );
    assert.ok(result, "generateStamp should return a stamp");
    const [stamp, value] = result;
    assert.strictEqual(stamp.length, STAMP_SIZE);
    assert.ok(value >= cost, "achieved value must meet the requested cost");
    const wb = await stampWorkblock(messageId, WORKBLOCK_EXPAND_ROUNDS_PEERING);
    assert.ok(await stampValid(stamp, cost, wb));
    assert.strictEqual(await stampValue(wb, stamp), value);
  });
});
