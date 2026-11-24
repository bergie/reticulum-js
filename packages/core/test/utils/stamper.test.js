import assert from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  fullHash,
  generateStamp,
  getStamper,
  msgpackUint,
  normalizeGenerateStampOptions,
  STAMP_SIZE,
  setStamper,
  stampTargetBytesFromCost,
  stampValid,
  stampValue,
  stampWorkblock,
  WORKBLOCK_EXPAND_ROUNDS,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
  WORKBLOCK_EXPAND_ROUNDS_PN,
} from "../../src/utils/stamper.js";
import {
  stampValid as rnsStampValid,
  stampValue as rnsStampValue,
  STAMP_LENGTH,
} from "../../src/utils/stamps.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/rns160-stamps.json", import.meta.url),
    "utf8",
  ),
);

const hexToBytes = (/** @type {string} */ hex) =>
  new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

test("stamper engine seam", async (t) => {
  await t.test("exposes canonical constants", () => {
    assert.strictEqual(STAMP_SIZE, 32);
    assert.strictEqual(WORKBLOCK_EXPAND_ROUNDS, 3000);
    assert.strictEqual(WORKBLOCK_EXPAND_ROUNDS_PN, 1000);
    assert.strictEqual(WORKBLOCK_EXPAND_ROUNDS_PEERING, 25);
  });

  await t.test(
    "msgpackUint counter is multi-byte at n >= 128 (matches Python umsgpack)",
    () => {
      assert.deepStrictEqual(msgpackUint(0), new Uint8Array([0]));
      assert.deepStrictEqual(msgpackUint(127), new Uint8Array([127]));
      assert.deepStrictEqual(msgpackUint(128), new Uint8Array([0xcc, 128]));
      assert.deepStrictEqual(msgpackUint(255), new Uint8Array([0xcc, 255]));
      assert.deepStrictEqual(msgpackUint(256), new Uint8Array([0xcd, 1, 0]));
      assert.deepStrictEqual(
        msgpackUint(65536),
        new Uint8Array([0xce, 0, 1, 0, 0]),
      );
    },
  );

  await t.test(
    "default engine workblock is byte-identical to Python LXStamper",
    async () => {
      // Vector generated with Python LXMF.LXStamper.stamp_workblock:
      //   material = RNS.Identity.full_hash(b"cross-check material")
      // 300 rounds crosses the uint8 boundary (n = 128..255 encode as
      // 0xcc nn) — a naive single-byte counter would diverge here.
      const material = hexToBytes(
        "01310dfe3bcb204b5bc6889def4de0cc6f98b64972a17399866cffb0651cf890",
      );
      const wb = await stampWorkblock(material, 300);
      assert.strictEqual(wb.length, 300 * 256);
      assert.deepStrictEqual(
        wb.slice(0, 32),
        hexToBytes(
          "4db69f305d4e0fc69a511bf38e8bc6b6f169dbd2bbe57bab4f943330057008b4",
        ),
      );
    },
  );

  await t.test("getStamper returns the installed engine", () => {
    const engine = getStamper();
    assert.ok(engine, "an engine must always be installed");
    for (const fn of [
      "fullHash",
      "stampWorkblock",
      "stampValid",
      "stampValue",
      "generateStamp",
    ]) {
      assert.strictEqual(typeof engine[fn], "function", `${fn} must exist`);
    }
  });

  await t.test("fullHash matches WebCrypto SHA-256", async () => {
    const data = new TextEncoder().encode("stamper engine smoke");
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", data),
    );
    assert.deepStrictEqual(await fullHash(data), expected);
  });

  await t.test("setStamper swaps all five functions and back", async () => {
    /** @type {string[]} */
    const calls = [];
    /** @type {import("../../src/utils/stamper.js").StamperEngine} */
    const mockEngine = {
      async fullHash(data) {
        calls.push("fullHash");
        return new Uint8Array(data.length & 0xff);
      },
      async stampWorkblock(material, expandRounds) {
        calls.push(`stampWorkblock:${expandRounds}`);
        return new Uint8Array(material.length + Number(expandRounds));
      },
      async stampValid(stamp, targetCost, workblock) {
        calls.push(`stampValid:${targetCost}:${workblock.length}`);
        return stamp.length === 32 && targetCost === 7;
      },
      async stampValue(workblock, stamp) {
        calls.push(`stampValue:${workblock.length}:${stamp.length}`);
        return 42;
      },
      async generateStamp(messageId, stampCost, expandRounds) {
        calls.push(`generateStamp:${stampCost}:${expandRounds}`);
        return [new Uint8Array(32), stampCost];
      },
    };

    setStamper(mockEngine);
    assert.strictEqual(getStamper(), mockEngine);

    const material = new Uint8Array(32).fill(1);
    const wb = new Uint8Array(64);
    const stamp = new Uint8Array(32);

    assert.deepStrictEqual(await fullHash(material), new Uint8Array(32));
    // Omitted expandRounds must be filled in with the default before the
    // engine is called (engines should not have to default it themselves).
    assert.strictEqual((await stampWorkblock(material)).length, 32 + 3000);
    assert.strictEqual(
      (await stampWorkblock(material, WORKBLOCK_EXPAND_ROUNDS_PEERING)).length,
      32 + 25,
    );
    assert.strictEqual(await stampValid(stamp, 7, wb), true);
    assert.strictEqual(await stampValid(stamp, 8, wb), false);
    assert.strictEqual(await stampValue(wb, stamp), 42);
    const [genStamp, genValue] = await generateStamp(material, 12);
    assert.strictEqual(genStamp.length, 32);
    assert.strictEqual(genValue, 12);

    assert.deepStrictEqual(calls, [
      "fullHash",
      "stampWorkblock:3000",
      "stampWorkblock:25",
      "stampValid:7:64",
      "stampValid:8:64",
      "stampValue:64:32",
      "generateStamp:12:3000",
    ]);

    // Resetting restores the WebCrypto default engine.
    setStamper(null);
    assert.notStrictEqual(getStamper(), mockEngine);
    assert.deepStrictEqual(
      await fullHash(new TextEncoder().encode("x")),
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x")),
      ),
    );
  });

  await t.test(
    "setStamper rejects invalid engines and keeps the current one",
    () => {
      const before = getStamper();
      assert.throws(
        () =>
          setStamper(
            /** @type {any} */ ({
              fullHash: () => {},
              stampWorkblock: () => {},
              stampValid: () => {},
              stampValue: () => {},
            }),
          ),
        TypeError,
      );
      assert.strictEqual(getStamper(), before);
      assert.throws(() => setStamper(/** @type {any} */ ("bogus")), TypeError);
      assert.strictEqual(getStamper(), before);
    },
  );

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

test("stampTargetBytesFromCost keeps the engine seam byte-compatible", () => {
  // Whole-number costs must encode exactly the historical LXMF threshold
  // 2^(256 - cost), so engines mining the TAB grid are drop-in compatible
  // with integer-bit callers and validators.
  for (let cost = 1; cost <= 64; cost++) {
    const bytes = stampTargetBytesFromCost(cost);
    assert.strictEqual(bytes.length, 32);
    // 2^(256 - cost): the set bit sits at MSB-first byte floor((cost-1)/8),
    // offset (cost-1)%8 from the byte's most significant bit.
    const expected = new Uint8Array(32);
    expected[Math.floor((cost - 1) / 8)] = 1 << (7 - ((cost - 1) % 8));
    assert.deepStrictEqual(bytes, expected, `cost ${cost}`);
  }
  // Fractional costs encode the Python TAB target verbatim (fixture vectors
  // from `RNS/Stamps.py` `target_from_cost`).
  for (const [cost, hex] of Object.entries(fixture.targetFromCost)) {
    const hexBody = hex.startsWith("0x") ? hex.slice(2) : hex;
    assert.deepStrictEqual(
      stampTargetBytesFromCost(Number(cost)),
      hexToBytes(hexBody.padStart(64, "0")),
      `targetFromCost(${cost})`,
    );
  }
  // Cost 0 clamps to the all-ones encoding (equivalent for 32-byte digests).
  assert.deepStrictEqual(
    stampTargetBytesFromCost(0),
    new Uint8Array(32).fill(0xff),
  );
  assert.throws(() => stampTargetBytesFromCost(-1), RangeError);
  assert.throws(() => stampTargetBytesFromCost(101), RangeError);
});

test("normalizeGenerateStampOptions tolerates the legacy positional form", () => {
  assert.deepStrictEqual(normalizeGenerateStampOptions(25), {
    expandRounds: 25,
  });
  assert.deepStrictEqual(normalizeGenerateStampOptions(undefined), {});
  assert.deepStrictEqual(normalizeGenerateStampOptions(null), {});
  assert.deepStrictEqual(
    normalizeGenerateStampOptions({ expandRounds: 0, size: STAMP_LENGTH }),
    { expandRounds: 0, size: STAMP_LENGTH },
  );
});

test("generateStamp dispatches options objects to the engine verbatim", async () => {
  const real = getStamper();
  /** @type {any[]} */
  const seen = [];
  setStamper({
    ...real,
    async generateStamp(messageId, stampCost, expandRoundsOrOptions) {
      seen.push(expandRoundsOrOptions);
      return real.generateStamp(messageId, stampCost, expandRoundsOrOptions);
    },
  });
  try {
    const material = crypto.getRandomValues(new Uint8Array(32));
    // The RNS call form: options object must reach the engine unmodified —
    // expandRounds 0 (raw material workblock) and the 14-byte stamp size.
    const [stamp] = /** @type {[Uint8Array, number]} */ (
      await generateStamp(material, 6, {
        expandRounds: 0,
        size: STAMP_LENGTH,
      })
    );
    assert.deepStrictEqual(seen[0], {
      expandRounds: 0,
      size: STAMP_LENGTH,
    });
    assert.strictEqual(stamp.length, STAMP_LENGTH);
    // Engine-mined stamp must satisfy the stamps.js reference validators —
    // the wire-parity contract with `RNS/Stamps.py`.
    assert.ok(await rnsStampValid(stamp, 6, material));
    assert.ok((await rnsStampValue(material, stamp)) >= 6);
    // Legacy positional form keeps reaching the engine as a number.
    await generateStamp(material, 6, WORKBLOCK_EXPAND_ROUNDS_PEERING);
    assert.strictEqual(seen[1], WORKBLOCK_EXPAND_ROUNDS_PEERING);
  } finally {
    setStamper(null);
  }
});

test("generateStamp honours an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const material = crypto.getRandomValues(new Uint8Array(32));
  assert.strictEqual(
    await generateStamp(material, 6, {
      expandRounds: 0,
      signal: controller.signal,
    }),
    null,
  );
});
