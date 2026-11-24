/**
 * @module @reticulum/wasm-stamper/src/stamper.js
 * @description Fast WASM stamp engine for `@reticulum/core`'s pluggable
 *   stamper seam (work docs #45 and #51), built on `hash-wasm`'s
 *   hand-tuned WebAssembly SHA-256. This is the browser counterpart to
 *   `@reticulum/node`'s `node:crypto` engine: WebCrypto cannot clone hash
 *   state, so the default engine must re-hash the entire workblock on every
 *   stamp-search trial and pays ~15 000 `importKey`/`sign` round-trips per
 *   HKDF workblock build. WASM hashers can `save()`/`load()` their state,
 *   which is exactly the `hash.copy()` capability the Node engine relies on.
 *
 *   The engine is deliberately hybrid:
 *
 *   - `stampWorkblock` builds the HKDF workblock with WASM HMAC-SHA256
 *     (~10× faster than the WebCrypto default, same league as the Node
 *     engine), yielding to the event loop whenever a synchronous stretch
 *     exceeds ~8 ms so the UI stays responsive;
 *   - `generateStamp` absorbs the workblock once, saves the SHA-256
 *     midstate, and per trial only hashes the stamp bytes (~300× faster
 *     per trial), with bytewise comparison against the cost target from
 *     `stampTargetBytesFromCost` — the fractional 8.8 fixed-point TAB grid
 *     of `RNS/Stamps.py` `target_from_cost` (at whole-number costs exactly
 *     the `2^(256 - cost)` LXMF threshold) — the same boundary semantics
 *     as the Node engine. The search yields on the same ~8 ms wall-clock
 *     budget.
 *   - `fullHash`, `stampValid` and `stampValue` stay on native
 *     `crypto.subtle`, which absorbs large workblocks faster than WASM —
 *     this keeps one-shot validation fast for receivers.
 *
 *   Wire format and validation semantics are byte-identical to the default
 *   engine (and the Python `LXStamper` reference).
 */

/* @ts-self-types="../types/src/stamper.d.ts" */

import {
  msgpackUint,
  normalizeGenerateStampOptions,
  setStamper,
  stampTargetBytesFromCost,
  WORKBLOCK_EXPAND_ROUNDS,
} from "@reticulum/core/src/utils/stamper.js";
import { createSHA256 } from "hash-wasm";

/** @typedef {import("@reticulum/core/src/utils/stamper.js").StamperEngine} StamperEngine */
/** @typedef {import("@reticulum/core/src/utils/stamper.js").GenerateStampOptions} GenerateStampOptions */

/**
 * A hash-wasm SHA-256 hasher (wasm-backed, with `save()`/`load()` state
 * cloning — the capability WebCrypto lacks and this engine's stamp search
 * relies on).
 * @typedef {Awaited<ReturnType<typeof import("hash-wasm").createSHA256>>} Sha256Hasher
 */

/** Stamp size in bytes: HASHLENGTH//8 = 256//8 = 32. */
const STAMP_SIZE = 32;

/** Random-byte pool size for stamp trials (64 trials per refill). */
const RANDOM_POOL_TRIALS = 64;

/** Check for a pending yield every this many workblock rounds. */
const WORKBLOCK_YIELD_CHECK_ROUNDS = 64;

/** Check for a pending yield every this many stamp trials. */
const TRIALS_YIELD_CHECK_TRIALS = 512;

/** Yield once a single synchronous stretch reaches this many milliseconds. */
const YIELD_BUDGET_MS = 8;

/** @type {Uint8Array<ArrayBufferLike>} */
const EMPTY = new Uint8Array(0);

/**
 * Pending resolvers for the shared MessageChannel yield queue, in FIFO
 * order (one posted message resolves exactly one waiter, so concurrent
 * yields each get their own turn).
 * @type {(() => void)[]}
 */
const yieldResolvers = [];

/** Lazily created MessageChannel backing {@link macrotaskYield}. */
/** @type {MessageChannel | null} */
let yieldChannel = null;

/**
 * Enqueues a macrotask turn without `setTimeout`'s nested-timeout clamping
 * (~4 ms after five levels), so periodic yields stay cheap on browsers
 * without `scheduler.yield()`.
 *
 * @returns {Promise<void>}
 */
function macrotaskYield() {
  if (typeof MessageChannel !== "function") {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  let channel = yieldChannel;
  if (channel === null) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const next = yieldResolvers.shift();
      if (next !== undefined) next();
    };
    // Don't hold the host process open just for the yield channel — but
    // only unref on actual Node: Deno resolves its event loop once only
    // unref'd operations remain, which would strand a pending yield (and
    // Deno/Bun do not hang on message ports anyway).
    const isNode =
      typeof (/** @type {any} */ (globalThis).Deno) === "undefined" &&
      typeof (/** @type {any} */ (globalThis).Bun) === "undefined" &&
      typeof process !== "undefined" &&
      process.versions?.node != null;
    if (isNode) {
      const ports = /** @type {any} */ (channel);
      ports.port1.unref?.();
      ports.port2.unref?.();
    }
    yieldChannel = channel;
  }
  return new Promise((resolve) => {
    yieldResolvers.push(resolve);
    channel.port2.postMessage(null);
  });
}

/**
 * Cooperative yield that lets the browser paint and the mesh event loop
 * drain between long synchronous stretches (workblock rounds, stamp
 * trials). Uses `scheduler.yield()` where available (continuation
 * prioritised like other rendering tasks), a MessageChannel macrotask
 * otherwise, and only falls back to a zero-timeout where neither exists.
 *
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  const scheduler = /** @type {any} */ (globalThis).scheduler;
  if (typeof scheduler?.yield === "function") {
    return /** @type {Promise<void>} */ (scheduler.yield());
  }
  return macrotaskYield();
}

/**
 * Starts timing a synchronous stretch for {@link yieldIfOverBudget}.
 *
 * @returns {number} The stretch start timestamp.
 */
function stretchStart() {
  return performance.now();
}

/**
 * Yields to the event loop once the current synchronous stretch has run
 * for {@link YIELD_BUDGET_MS} milliseconds — keeping worst-case main-thread
 * blocking bounded by wall-clock time on any device speed, instead of a
 * fixed round/trial count.
 *
 * @param {number} started - The timestamp from {@link stretchStart}.
 * @returns {Promise<number>} The next stretch start timestamp.
 */
async function yieldIfOverBudget(started) {
  if (performance.now() - started < YIELD_BUDGET_MS) return started;
  await yieldToEventLoop();
  return performance.now();
}

/**
 * Computes SHA-256 of the input via the native Web Crypto API.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function nativeFullHash(data) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    /** @type {any} */ (data),
  );
  return new Uint8Array(digest);
}

/**
 * Computes the 32-byte big-endian encoding of the validity threshold
 * `2^(256 - targetCost)`.
 *
 * @param {number} targetCost - Required leading zero bits (1..256).
 * @returns {Uint8Array}
 */
function stampTargetBytes(targetCost) {
  if (!Number.isInteger(targetCost) || targetCost < 1 || targetCost > 256) {
    throw new RangeError(
      `targetCost must be an integer in 1..256, got ${targetCost}`,
    );
  }
  const target = new Uint8Array(32);
  // Bit (256 - targetCost) counted from the least significant bit, i.e. the
  // byte at index floor((targetCost - 1) / 8) from the most significant byte,
  // bit (targetCost - 1) % 8 within that byte (MSB-first).
  const byteIndex = Math.floor((targetCost - 1) / 8);
  const bitInByte = (targetCost - 1) % 8;
  target[byteIndex] = 1 << (7 - bitInByte);
  return target;
}

/**
 * Bytewise big-endian comparison: `a <= b` for equal-length digests.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function digestLessOrEqual(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}

/**
 * Counts the leading zero bits of a digest.
 *
 * @param {Uint8Array} hash
 * @returns {number}
 */
function leadingZeroBits(hash) {
  let value = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i];
    if (byte === 0) {
      value += 8;
      continue;
    }
    // Math.clz32(byte) = 24 + (leading zeros within the byte).
    value += Math.clz32(byte) - 24;
    break;
  }
  return value;
}

/**
 * HMAC-SHA256 using two WASM hasher instances (inner, outer). The key is
 * always ≤ 64 bytes in this engine (32-byte salts and PRKs); longer keys
 * are hashed to 32 bytes first, per the standard HMAC construction.
 *
 * @param {Sha256Hasher} inner - Hasher for the ipad pass.
 * @param {Sha256Hasher} outer - Hasher for the opad pass.
 * @param {Uint8Array} key - HMAC key (may be up to 64 bytes).
 * @param {Uint8Array} data - Message to authenticate.
 * @returns {Uint8Array} The 32-byte MAC.
 */
function hmac(inner, outer, key, data) {
  let macKey = key;
  if (macKey.length > 64) {
    inner.init();
    inner.update(macKey);
    macKey = /** @type {Uint8Array} */ (
      /** @type {any} */ (inner.digest("binary"))
    );
  }
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  ipad.set(macKey);
  opad.set(macKey);
  for (let i = 0; i < 64; i++) {
    ipad[i] ^= 0x36;
    opad[i] ^= 0x5c;
  }
  inner.init();
  inner.update(ipad);
  inner.update(data);
  const innerDigest = /** @type {Uint8Array} */ (
    /** @type {any} */ (inner.digest("binary"))
  );
  outer.init();
  outer.update(opad);
  outer.update(innerDigest);
  return /** @type {Uint8Array} */ (
    /** @type {any} */ (outer.digest("binary"))
  );
}

/**
 * Builds the memory-hard workblock used for stamp proof-of-work, using WASM
 * HMAC-SHA256 for the per-round HKDF. Byte-identical to the WebCrypto
 * default engine's workblock (each round: `SHA256(material || msgpack(n))`
 * salt, then 256 bytes of HKDF-Expand output keyed on the material).
 *
 * Yields to the event loop whenever a synchronous stretch exceeds ~8 ms
 * (wall-clock budget), so long builds (3000 rounds ≈ 100–180 ms) never
 * block the main thread for more than a frame or so.
 *
 * @param {Uint8Array} material - The 32-byte message_id (or peering_id).
 * @param {number} [expandRounds] - Number of HKDF expansion rounds.
 * @returns {Promise<Uint8Array>} The concatenated workblock.
 */
async function wasmStampWorkblock(
  material,
  expandRounds = WORKBLOCK_EXPAND_ROUNDS,
) {
  // Python-faithful 0-round semantics: `LXStamper.stamp_workblock` returns
  // the material itself when no expansion is requested (`not expand_rounds`).
  // RNS 1.6.0 network stamps always validate against the raw material, so
  // this path must never yield an empty workblock.
  if (!expandRounds) return material.slice();
  const saltHasher = await createSHA256();
  const innerHasher = await createSHA256();
  const outerHasher = await createSHA256();
  const workblock = new Uint8Array(expandRounds * 256);
  let stretch = stretchStart();
  for (let n = 0; n < expandRounds; n++) {
    saltHasher.init();
    saltHasher.update(material);
    saltHasher.update(msgpackUint(n));
    const salt = saltHasher.digest("binary");
    const prk = hmac(innerHasher, outerHasher, salt, material);
    // HKDF-Expand: 256 bytes = 8 × 32-byte HMAC blocks,
    // T_i = HMAC(prk, T_i-1 || i), starting from the empty info string.
    let lastT = EMPTY;
    for (let i = 1; i <= 8; i++) {
      const input = new Uint8Array(lastT.length + 1);
      input.set(lastT, 0);
      input[input.length - 1] = i;
      const block = hmac(innerHasher, outerHasher, prk, input);
      workblock.set(block, n * 256 + (i - 1) * 32);
      lastT = block;
    }
    if ((n + 1) % WORKBLOCK_YIELD_CHECK_ROUNDS === 0) {
      stretch = await yieldIfOverBudget(stretch);
    }
  }
  return workblock;
}

/**
 * Validates a stamp against a target proof-of-work cost, identically to the
 * default engine (`SHA256(workblock || stamp) <= 2^(256 - targetCost)`).
 * Uses the native Web Crypto API, which absorbs large workblocks faster
 * than WASM on a one-shot validation.
 *
 * @param {Uint8Array} stamp
 * @param {number} targetCost
 * @param {Uint8Array} workblock
 * @returns {Promise<boolean>}
 */
async function nativeStampValid(stamp, targetCost, workblock) {
  if (targetCost <= 0) return true;
  const hash = await nativeFullHash(new Uint8Array([...workblock, ...stamp]));
  return digestLessOrEqual(hash, stampTargetBytes(targetCost));
}

/**
 * Returns the number of leading zero bits in SHA256(workblock || stamp),
 * identically to the default engine's `stampValue`. Uses the native Web
 * Crypto API (see {@link nativeStampValid}).
 *
 * @param {Uint8Array} workblock
 * @param {Uint8Array} stamp
 * @returns {Promise<number>}
 */
async function nativeStampValue(workblock, stamp) {
  const hash = await nativeFullHash(new Uint8Array([...workblock, ...stamp]));
  return leadingZeroBits(hash);
}

/**
 * Workblock + midstate cache for the retry path: when a recipient rejects a
 * stamp and asks for a higher cost, `generateStamp` runs again for the same
 * message_id. Re-absorbing the 750 KiB workblock and re-deriving the HKDF
 * is pure waste then, so the last generation's midstate is kept (mirroring
 * `@reticulum/node`'s workblock LRU in spirit — single entry, keyed bytewise
 * on material + rounds).
 *
 * @type {{
 *   key: Uint8Array;
 *   rounds: number;
 *   workblock: Uint8Array;
 *   midstate: Uint8Array;
 * } | null}
 */
let lastGeneration = null;

/**
 * Returns the previous generation's workblock and SHA-256 midstate when
 * `generateStamp` runs again for the same material and round count (the
 * higher-cost retry path), or `null` on a miss.
 *
 * @param {Uint8Array} messageId
 * @param {number} expandRounds
 * @returns {{ workblock: Uint8Array, midstate: Uint8Array } | null}
 */
function cachedGeneration(messageId, expandRounds) {
  const cached = lastGeneration;
  if (cached === null || cached.rounds !== expandRounds) return null;
  if (cached.key.length !== messageId.length) return null;
  for (let i = 0; i < cached.key.length; i++) {
    if (cached.key[i] !== messageId[i]) return null;
  }
  return { workblock: cached.workblock, midstate: cached.midstate };
}

/**
 * Searches for a valid stamp by random trial, using a WASM SHA-256
 * midstate: the workblock is absorbed and `save()`d once, then each trial
 * only `load()`s the state and hashes the stamp — mathematically identical
 * to hashing `workblock ‖ stamp` per trial, ~300× faster than the WebCrypto
 * default's full-buffer re-hash.
 *
 * Yields to the event loop whenever a synchronous stretch exceeds ~8 ms
 * (wall-clock budget), so long searches never block the main thread for
 * more than a frame or so (the Node engine achieves the same by running
 * in a worker).
 *
 * Accepts the legacy positional `expandRounds` number or the
 * {@link GenerateStampOptions} object form (Python `Stamps.generate_stamp`
 * options); an aborted `signal` resolves to `null`, checked at the yield
 * points.
 *
 * @param {Uint8Array} messageId - The 32-byte message_id (or peering_id).
 * @param {number} stampCost - Required fractional 8.8 fixed-point cost (at
 *   whole-number costs identical to the `2^(256 - cost)` boundary).
 * @param {number|GenerateStampOptions} [expandRoundsOrOptions]
 * @returns {Promise<[Uint8Array, number]|null>} `[stamp, value]` (value =
 *   leading-zero-bit count), or `null` when aborted via the signal.
 */
async function wasmGenerateStamp(messageId, stampCost, expandRoundsOrOptions) {
  const {
    expandRounds = WORKBLOCK_EXPAND_ROUNDS,
    size = STAMP_SIZE,
    signal,
  } = normalizeGenerateStampOptions(expandRoundsOrOptions);
  const target = stampTargetBytesFromCost(stampCost);
  const cached = cachedGeneration(messageId, expandRounds);
  let workblock;
  let midstate;
  if (cached === null) {
    workblock = await wasmStampWorkblock(messageId, expandRounds);
    const builder = await createSHA256();
    builder.init();
    builder.update(workblock);
    midstate = /** @type {Uint8Array} */ (/** @type {any} */ (builder.save()));
    lastGeneration = {
      key: messageId.slice(),
      rounds: expandRounds,
      workblock,
      midstate,
    };
  } else {
    workblock = cached.workblock;
    midstate = cached.midstate;
  }
  const searcher = await createSHA256();
  const pool = new Uint8Array(RANDOM_POOL_TRIALS * size);
  let poolOffset = pool.length;
  let trials = 0;
  let stretch = stretchStart();
  while (true) {
    if (poolOffset + size > pool.length) {
      crypto.getRandomValues(pool);
      poolOffset = 0;
    }
    const trial = pool.subarray(poolOffset, poolOffset + size);
    poolOffset += size;
    searcher.load(midstate);
    searcher.update(trial);
    const hash = searcher.digest("binary");
    if (digestLessOrEqual(hash, target)) {
      // Copy out of the pool: the pool is reused (and overwritten) by later
      // trials, so the returned stamp must own its memory.
      return [new Uint8Array(trial), leadingZeroBits(hash)];
    }
    trials += 1;
    if (trials % TRIALS_YIELD_CHECK_TRIALS === 0) {
      if (signal?.aborted) return null;
      stretch = await yieldIfOverBudget(stretch);
    }
  }
}

/**
 * The WASM stamp engine. Hybrid: workblock build and stamp search run on
 * `hash-wasm` WASM SHA-256 (with save/load midstate cloning), one-shot
 * hashing and validation stay on the native Web Crypto API.
 *
 * @type {StamperEngine}
 */
export const wasmStamper = {
  fullHash: nativeFullHash,
  stampWorkblock: wasmStampWorkblock,
  stampValid: nativeStampValid,
  stampValue: nativeStampValue,
  generateStamp: wasmGenerateStamp,
};

/**
 * Installs the WASM stamp engine via `@reticulum/core`'s `setStamper()`.
 * Importing this module has no side effects — only an explicit
 * `useWasmStamper()` call changes the engine.
 *
 *     import { useWasmStamper } from "@reticulum/wasm-stamper";
 *     useWasmStamper();
 *
 * @returns {StamperEngine} The installed engine ({@link wasmStamper}).
 */
export function useWasmStamper() {
  setStamper(wasmStamper);
  return wasmStamper;
}
