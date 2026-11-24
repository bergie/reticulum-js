import assert from "node:assert";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import {
  generateStamp as defaultGenerateStamp,
  stampValid as defaultStampValid,
  stampValue as defaultStampValue,
  stampWorkblock as defaultStampWorkblock,
  getStamper,
  setStamper,
  WORKBLOCK_EXPAND_ROUNDS,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
  WORKBLOCK_EXPAND_ROUNDS_PN,
} from "@reticulum/core/src/utils/stamper.js";
import { useWasmStamper, wasmStamper } from "../src/index.js";

const hexToBytes = (/** @type {string} */ hex) =>
  new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

// Never leak the wasm engine into other test files in this process.
after(() => {
  setStamper(null);
});

/**
 * Independent validity check: `SHA256(workblock || stamp) <=
 * 2^(256 - targetCost)` computed with node:crypto and BigInt.
 * @param {Uint8Array} stamp
 * @param {number} targetCost
 * @param {Uint8Array} workblock
 */
function nodeCryptoStampValid(stamp, targetCost, workblock) {
  const digest = createHash("sha256").update(workblock).update(stamp).digest();
  const target = 1n << BigInt(256 - targetCost);
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return BigInt(`0x${hex}`) <= target;
}

/**
 * Independent leading-zero-bit count with node:crypto.
 * @param {Uint8Array} stamp
 * @param {Uint8Array} workblock
 */
function nodeCryptoStampValue(stamp, workblock) {
  const digest = createHash("sha256").update(workblock).update(stamp).digest();
  let value = 0;
  for (const byte of digest) {
    if (byte === 0) {
      value += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte >> bit) & 1) return value;
      value += 1;
    }
  }
  return value;
}

test("wasm stamper engine satisfies the StamperEngine shape", () => {
  for (const fn of [
    "fullHash",
    "stampWorkblock",
    "stampValid",
    "stampValue",
    "generateStamp",
  ]) {
    assert.strictEqual(
      typeof wasmStamper[/** @type {any} */ (fn)],
      "function",
      `wasmStamper.${fn} must be a function`,
    );
  }
});

test("useWasmStamper installs the engine, null restores default", () => {
  const before = getStamper();
  assert.notStrictEqual(before, wasmStamper);
  assert.strictEqual(useWasmStamper(), wasmStamper);
  assert.strictEqual(getStamper(), wasmStamper);
  setStamper(null);
  assert.strictEqual(getStamper(), before);
});

test("fullHash matches node:crypto SHA-256", async () => {
  const data = crypto.getRandomValues(new Uint8Array(1000));
  const expected = createHash("sha256").update(data).digest("hex");
  const actual = await wasmStamper.fullHash(data);
  assert.strictEqual(Buffer.from(actual).toString("hex"), expected);
  const empty = await wasmStamper.fullHash(new Uint8Array(0));
  assert.strictEqual(
    Buffer.from(empty).toString("hex"),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("workblock is byte-identical to the WebCrypto default engine across round counts", async () => {
  const material = crypto.getRandomValues(new Uint8Array(32));
  for (const rounds of [0, 1, 2, 25, 127, 128, 300, 1000, 3000]) {
    const wasm = await wasmStamper.stampWorkblock(material, rounds);
    const reference = await defaultStampWorkblock(material, rounds);
    assert.strictEqual(
      Buffer.from(wasm).equals(Buffer.from(reference)),
      true,
      `workblock diverged at ${rounds} rounds`,
    );
  }
  // 0-round semantics: the material itself (never an empty workblock).
  const zero = await wasmStamper.stampWorkblock(material, 0);
  assert.deepStrictEqual(zero, material);
});

test("workblock is byte-identical to the Python LXStamper reference", async () => {
  // Vector generated with Python LXMF.LXStamper.stamp_workblock (same
  // vector as the core engine test):
  //   material = RNS.Identity.full_hash(b"cross-check material")
  // 300 rounds crosses the uint8 boundary (n = 128..255 encode as 0xcc nn).
  const material = hexToBytes(
    "01310dfe3bcb204b5bc6889def4de0cc6f98b64972a17399866cffb0651cf890",
  );
  const wb = await wasmStamper.stampWorkblock(material, 300);
  assert.strictEqual(wb.length, 300 * 256);
  assert.deepStrictEqual(
    wb.slice(0, 32),
    hexToBytes(
      "4db69f305d4e0fc69a511bf38e8bc6b6f169dbd2bbe57bab4f943330057008b4",
    ),
  );
});

test("stampValid matches node:crypto BigInt threshold semantics", async () => {
  const material = crypto.getRandomValues(new Uint8Array(32));
  const workblock = await wasmStamper.stampWorkblock(
    material,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  for (const cost of [1, 4, 8, 16, 24]) {
    for (let i = 0; i < 20; i++) {
      const stamp = crypto.getRandomValues(new Uint8Array(32));
      assert.strictEqual(
        await wasmStamper.stampValid(stamp, cost, workblock),
        nodeCryptoStampValid(stamp, cost, workblock),
        `stampValid divergence at cost=${cost}, trial=${i}`,
      );
      // Cross-check against the WebCrypto default engine too.
      assert.strictEqual(
        await wasmStamper.stampValid(stamp, cost, workblock),
        await defaultStampValid(stamp, cost, workblock),
        `cross-engine stampValid divergence at cost=${cost}, trial=${i}`,
      );
    }
  }
  // Boundary: targetCost <= 0 is trivially valid (Node engine parity).
  assert.strictEqual(
    await wasmStamper.stampValid(new Uint8Array(32), 0, workblock),
    true,
  );
  // Invalid costs throw (Node engine parity).
  await assert.rejects(
    wasmStamper.stampValid(new Uint8Array(32), 257, workblock),
    RangeError,
  );
  await assert.rejects(
    wasmStamper.stampValid(new Uint8Array(32), 1.5, workblock),
    RangeError,
  );
});

test("stampValue matches node:crypto and the default engine", async () => {
  const material = crypto.getRandomValues(new Uint8Array(32));
  const workblock = await wasmStamper.stampWorkblock(
    material,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  for (let i = 0; i < 10; i++) {
    const stamp = crypto.getRandomValues(new Uint8Array(32));
    const wasm = await wasmStamper.stampValue(workblock, stamp);
    assert.strictEqual(wasm, nodeCryptoStampValue(stamp, workblock));
    assert.strictEqual(wasm, await defaultStampValue(workblock, stamp));
  }
});

test("generateStamp produces valid stamps with the expected value", async () => {
  for (const [rounds, cost] of [
    [WORKBLOCK_EXPAND_ROUNDS, 8],
    [WORKBLOCK_EXPAND_ROUNDS_PN, 8],
    [WORKBLOCK_EXPAND_ROUNDS_PEERING, 10],
  ]) {
    const messageId = crypto.getRandomValues(new Uint8Array(32));
    const [stamp, value] = await wasmStamper.generateStamp(
      messageId,
      cost,
      rounds,
    );
    assert.strictEqual(stamp.length, 32);
    assert.strictEqual(value >= cost, true, `value ${value} < cost ${cost}`);
    // Independent node:crypto verification.
    const workblock = await wasmStamper.stampWorkblock(messageId, rounds);
    assert.strictEqual(
      nodeCryptoStampValid(stamp, cost, workblock),
      true,
      `invalid stamp at rounds=${rounds}, cost=${cost}`,
    );
    assert.strictEqual(
      nodeCryptoStampValue(stamp, workblock),
      value,
      `reported value mismatch at rounds=${rounds}`,
    );
    // Cross-engine: the WebCrypto default engine accepts the stamp.
    assert.strictEqual(await defaultStampValid(stamp, cost, workblock), true);
  }
});

test("engines cross-validate each other's stamps end-to-end", async () => {
  // The WebCrypto default engine is slow to generate (~1 s per workblock
  // build), so one cross-check at the cheapest round count is enough here;
  // the other tests already verify wasm output against node:crypto directly.
  setStamper(null);
  const messageId = crypto.getRandomValues(new Uint8Array(32));
  const [defaultStamp] = await defaultGenerateStamp(
    messageId,
    8,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  const wasmWorkblock = await wasmStamper.stampWorkblock(
    messageId,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  assert.strictEqual(
    await wasmStamper.stampValid(defaultStamp, 8, wasmWorkblock),
    true,
    "default engine stamp must validate under the wasm engine",
  );
  const [wasmStamp] = await wasmStamper.generateStamp(
    messageId,
    8,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  assert.strictEqual(
    await defaultStampValid(wasmStamp, 8, wasmWorkblock),
    true,
    "wasm engine stamp must validate under the default engine",
  );
});

test("generateStamp retries reuse the midstate cache", async () => {
  // Same message_id generated twice at increasing costs — exercises the
  // single-entry retry cache; both results must independently validate.
  const messageId = crypto.getRandomValues(new Uint8Array(32));
  const [first, firstValue] = await wasmStamper.generateStamp(
    messageId,
    8,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  const [second, secondValue] = await wasmStamper.generateStamp(
    messageId,
    9,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  const workblock = await wasmStamper.stampWorkblock(
    messageId,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  assert.strictEqual(nodeCryptoStampValid(first, 8, workblock), true);
  assert.strictEqual(nodeCryptoStampValid(second, 9, workblock), true);
  assert.strictEqual(firstValue >= 8, true);
  assert.strictEqual(secondValue >= 9, true);
  // Different message_id must not be poisoned by the cache.
  const otherId = crypto.getRandomValues(new Uint8Array(32));
  const [third] = await wasmStamper.generateStamp(
    otherId,
    8,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  const otherWorkblock = await wasmStamper.stampWorkblock(
    otherId,
    WORKBLOCK_EXPAND_ROUNDS_PEERING,
  );
  assert.strictEqual(nodeCryptoStampValid(third, 8, otherWorkblock), true);
  assert.strictEqual(
    nodeCryptoStampValid(third, 8, workblock),
    false,
    "stamp for a different message_id must not validate under the cached workblock",
  );
});

test("generateStamp rejects invalid costs", async () => {
  const messageId = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(wasmStamper.generateStamp(messageId, 0), RangeError);
});
