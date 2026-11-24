/**
 * @module @reticulum/wasm-stamper
 * @description Fast WASM proof-of-work stamp engine for reticulum-js — the
 *   browser counterpart to `@reticulum/node`'s fast stamper (work docs #45
 *   and #51).
 *
 *   `@reticulum/core`'s default stamp engine is pure WebCrypto, which runs
 *   everywhere but is very slow at LXMF proof-of-work stamping: it cannot
 *   clone hash state, so every stamp-search trial re-hashes the entire
 *   ~750 KiB workblock, and every HKDF workblock build costs ~15 000 async
 *   `importKey`/`sign` round-trips. In browsers this turns a cost-16 stamp
 *   into tens of seconds of near-continuous main-thread work.
 *
 *   This package installs a drop-in engine backed by
 *   [hash-wasm](https://github.com/Daninet/hash-wasm)'s hand-tuned
 *   WebAssembly SHA-256, which — unlike WebCrypto — can save and restore
 *   hash state. The workblock is built with WASM HMAC-SHA256 (~10× faster),
 *   and stamp trials hash only the 32-byte stamp against a saved SHA-256
 *   midstate (~300× faster per trial, ~200× end-to-end). One-shot hashing
 *   and validation stay on the native Web Crypto API, which absorbs large
 *   workblocks faster than WASM — keeping receivers fast.
 *
 *   The wire format and validation semantics are byte-identical to the
 *   default engine (and the Python `LXStamper` reference): stamps generated
 *   by any engine validate under every other engine.
 *
 *   Opt-in, like all engine swaps:
 *
 *     import { useWasmStamper } from "@reticulum/wasm-stamper";
 *     useWasmStamper();
 *
 *   On Node.js, prefer `useNodeStamper()` from `@reticulum/node` instead —
 *   it is slightly faster, needs no extra dependency, and runs stamping in
 *   a worker thread. This package exists for browsers (and any runtime
 *   where hash-wasm's WASM is faster than WebCrypto), and also avoids
 *   `crypto.subtle` for stamp generation, so it works outside Secure
 *   Contexts for the generation path.
 */

/* @ts-self-types="../types/src/index.d.ts" */

export { useWasmStamper, wasmStamper } from "./stamper.js";
