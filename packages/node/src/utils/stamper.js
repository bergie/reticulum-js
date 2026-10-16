/**
 * @file stamper.js
 * @description Fast `node:crypto` stamp engine for `@reticulum/node`
 *   (work doc #45) — an optional, drop-in replacement for the WebCrypto
 *   default engine in `@reticulum/core`'s `utils/stamper.js`.
 *
 *   Install it explicitly (importing this module has no side effects):
 *
 *     import { useNodeStamper } from "@reticulum/node";
 *     useNodeStamper();
 *
 *   Compared to the WebCrypto default, this engine:
 *
 *   - builds workblocks with `hkdfSync` + `createHash` (~18× faster);
 *   - validates stamps via `hash.copy()` + `update(stamp)` (~30× faster per
 *     trial), with bytewise digest comparison against the
 *     `2^(256 - targetCost)` threshold instead of BigInt/hex round-trips;
 *   - caches workblocks in an LRU keyed by material + expansion rounds, so
 *     re-validating the same transient id costs one digest instead of a full
 *     workblock rebuild;
 *   - runs workblock builds and stamp generation in a `node:worker_threads`
 *     worker (mirroring the Python reference's worker-process design), so
 *     stamping never blocks the host's event loop. If workers are
 *     unavailable, it transparently falls back to running the same
 *     synchronous primitives on the calling thread.
 *
 *   Wire format and validation semantics are byte-identical to the default
 *   engine (and the Python `LXStamper` reference).
 */

/* @ts-self-types="../../types/src/utils/stamper.d.ts" */

import { Worker } from "node:worker_threads";
import {
  setStamper,
  WORKBLOCK_EXPAND_ROUNDS,
} from "@reticulum/core/src/utils/stamper.js";
import {
  fullHashSync,
  generateStampSync,
  stampValidSync,
  stampValueSync,
  stampWorkblockSync,
} from "./stamp-crypto.js";

// ---------------------------------------------------------------------
// Workblock LRU cache
// ---------------------------------------------------------------------

/** Maximum number of cached workblocks. */
const CACHE_MAX_ENTRIES = 64;
/** Maximum total cached bytes (~40 PN workblocks or ~42 message workblocks). */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * A small LRU cache for workblocks, keyed by `"<rounds>:<material hex>"`.
 * Cached buffers are shared between callers and must be treated as
 * read-only.
 */
class WorkblockCache {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this.map = new Map();
    /** @type {number} */
    this.bytes = 0;
  }

  /**
   * @param {string} key
   * @returns {Uint8Array | undefined}
   */
  get(key) {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {Uint8Array} value
   * @returns {void}
   */
  set(key, value) {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.bytes -= existing.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    while (
      this.map.size > 1 &&
      (this.map.size > CACHE_MAX_ENTRIES || this.bytes > CACHE_MAX_BYTES)
    ) {
      const oldest = /** @type {string} */ (this.map.keys().next().value);
      const evicted = /** @type {Uint8Array} */ (this.map.get(oldest));
      this.map.delete(oldest);
      this.bytes -= evicted.length;
    }
  }

  /**
   * @returns {void}
   */
  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

/** @type {WorkblockCache} */
const workblockCache = new WorkblockCache();

// ---------------------------------------------------------------------
// Worker management
// ---------------------------------------------------------------------

/** @type {Worker | null} */
let worker = null;
/** Set once worker spawning has failed (e.g. unsupported runtime) — all
 * further work then runs synchronously on the calling thread. */
let workerBroken = false;
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
const pending = new Map();
/** @type {number} */
let nextRequestId = 1;

/**
 * @returns {Worker | null}
 */
function getWorker() {
  if (worker !== null || workerBroken) return worker;
  try {
    const w = new Worker(new URL("./stamp-worker.js", import.meta.url));
    w.on("message", (/** @type {any} */ message) => {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error));
      } else {
        waiter.resolve(message.result);
      }
    });
    w.on("error", (/** @type {Error} */ err) => {
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
    });
    w.on("exit", () => {
      // Requests never answered are failed; the next call respawns.
      for (const waiter of pending.values()) {
        waiter.reject(new Error("Stamp worker exited"));
      }
      pending.clear();
      worker = null;
    });
    worker = w;
  } catch {
    workerBroken = true;
    return null;
  }
  return worker;
}

/**
 * Runs one operation in the worker.
 *
 * @template T
 * @param {string} op
 * @param {any[]} args
 * @returns {Promise<T>}
 */
function callWorker(op, args) {
  const w = getWorker();
  if (w === null) return Promise.reject(new Error("Stamp worker unavailable"));
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, args });
  });
}

// ---------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------

/**
 * Computes the workblock cache key for a material + rounds pair.
 *
 * @param {Uint8Array} material
 * @param {number} expandRounds
 * @returns {string}
 */
function cacheKey(material, expandRounds) {
  let hex = "";
  for (let i = 0; i < material.length; i++) {
    hex += material[i].toString(16).padStart(2, "0");
  }
  return `${expandRounds}:${hex}`;
}

/**
 * @type {import("@reticulum/core/src/utils/stamper.js").StamperEngine}
 */
export const nodeStamper = {
  /**
   * @param {Uint8Array} data
   * @returns {Promise<Uint8Array>}
   */
  async fullHash(data) {
    return fullHashSync(data);
  },

  /**
   * Builds (or LRU-cache-recalls) the workblock for the material. The build
   * itself runs in the stamp worker when available, keeping the event loop
   * free; cache hits cost nothing but a map lookup.
   *
   * @param {Uint8Array} material
   * @param {number} [expandRounds]
   * @returns {Promise<Uint8Array>}
   */
  async stampWorkblock(material, expandRounds = WORKBLOCK_EXPAND_ROUNDS) {
    const key = cacheKey(material, expandRounds);
    const cached = workblockCache.get(key);
    if (cached !== undefined) return cached;
    let workblock;
    if (!workerBroken) {
      try {
        workblock = await callWorker("workblock", [material, expandRounds]);
      } catch {
        // Worker unavailable, exited, or errored: fall back to synchronous
        // construction — the sync primitive throws the same errors the
        // worker would have, so nothing is masked.
      }
    }
    if (workblock === undefined) {
      workblock = stampWorkblockSync(material, expandRounds);
    }
    workblockCache.set(key, workblock);
    return workblock;
  },

  /**
   * @param {Uint8Array} stamp
   * @param {number} targetCost
   * @param {Uint8Array} workblock
   * @returns {Promise<boolean>}
   */
  async stampValid(stamp, targetCost, workblock) {
    return stampValidSync(stamp, targetCost, workblock);
  },

  /**
   * @param {Uint8Array} workblock
   * @param {Uint8Array} stamp
   * @returns {Promise<number>}
   */
  async stampValue(workblock, stamp) {
    return stampValueSync(workblock, stamp);
  },

  /**
   * Generates a stamp in the stamp worker (never blocking the event loop),
   * falling back to the synchronous search when workers are unavailable.
   *
   * @param {Uint8Array} messageId
   * @param {number} stampCost
   * @param {number} [expandRounds]
   * @returns {Promise<[Uint8Array, number]>}
   */
  async generateStamp(messageId, stampCost, expandRounds) {
    if (!workerBroken) {
      try {
        const result = await callWorker("generate", [
          messageId,
          stampCost,
          expandRounds,
        ]);
        return /** @type {[Uint8Array, number]} */ (result);
      } catch {
        // Worker unavailable, exited, or errored: run the identical search
        // synchronously on the calling thread instead.
      }
    }
    return generateStampSync(messageId, stampCost, expandRounds);
  },
};

/**
 * Installs {@link nodeStamper} as the active stamp engine in
 * `@reticulum/core` (replacing the WebCrypto default until
 * `setStamper(null)` is called). Purely opt-in: Node.js consumers choose to
 * call this; browsers and other runtimes are unaffected.
 *
 * @returns {typeof nodeStamper} The installed engine.
 */
export function useNodeStamper() {
  setStamper(nodeStamper);
  return nodeStamper;
}

/**
 * Releases the stamp engine's resources: terminates the stamp worker and
 * clears the workblock cache. The engine stays installed (calls continue to
 * work synchronously); call `setStamper(null)` (from
 * `@reticulum/core/src/utils/stamper.js`) to switch back to the WebCrypto
 * default engine.
 *
 * @returns {Promise<void>} Resolves once the worker has exited.
 */
export function stopNodeStamper() {
  workblockCache.clear();
  if (worker === null) return Promise.resolve();
  const w = worker;
  worker = null;
  return w.terminate().then(() => undefined);
}

/**
 * Returns whether the stamp worker is currently running.
 *
 * @returns {boolean}
 */
export function stampWorkerRunning() {
  return worker !== null;
}
