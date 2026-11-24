# Changelog

## [Unreleased]

## [0.10.1] - 2026-11-24
### Added

- Initial release: opt-in WASM proof-of-work stamp engine (`useWasmStamper()`) for reticulum-js, built on hash-wasm's WebAssembly SHA-256 with `save()`/`load()` midstate cloning. Workblock builds run ~10× faster than the WebCrypto default engine (WASM HMAC-SHA256 HKDF instead of ~15 000 async `importKey`/`sign` calls per 3000-round build) and stamp-search trials ~300× faster (only the 32-byte stamp is hashed per trial against a saved midstate, instead of re-hashing the entire 750 KiB workblock). One-shot hashing and validation stay on native `crypto.subtle`, which absorbs large workblocks faster than WASM — keeping receivers fast. Workblocks are byte-identical to the WebCrypto default engine and the Python `LXMF.LXStamper` reference, stamps cross-validate with every engine, and stamp generation never touches `crypto.subtle` (only `crypto.getRandomValues`), so it works outside Secure Contexts too. The engine yields to the event loop on an ~8 ms wall-clock budget so long stamping never blocks the UI for more than about a half-frame, and its yield channel is unref'd so it never holds a host process open at exit.

### Changed

- `generateStamp` accepts the options-object form (`expandRounds`, `size`, `signal`) alongside the legacy positional rounds, mines against fractional 8.8 fixed-point costs on the RNS TAB target grid (`RNS/Stamps.py` `target_from_cost` — byte-identical targets at whole-number costs, so integer-bit callers are unaffected), supports arbitrary stamp sizes (14-byte `Identity.STAMPLENGTH` detached stamps), and honours an `AbortSignal` at its yield points, resolving to `null` when aborted. Cost 0 is now accepted (Python `target_from_cost(0)` = 2²⁵⁶, which every digest satisfies) instead of rejected; negative and over-cap costs still throw.
