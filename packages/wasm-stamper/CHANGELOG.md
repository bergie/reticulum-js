# Changelog

## [Unreleased]

### Added

- Initial release: opt-in WASM proof-of-work stamp engine (`useWasmStamper()`) for reticulum-js, built on hash-wasm's WebAssembly SHA-256 with `save()`/`load()` midstate cloning. Workblock builds run ~10× faster than the WebCrypto default engine (WASM HMAC-SHA256 HKDF instead of ~15 000 async `importKey`/`sign` calls per 3000-round build) and stamp-search trials ~300× faster (only the 32-byte stamp is hashed per trial against a saved midstate, instead of re-hashing the entire 750 KiB workblock). One-shot hashing and validation stay on native `crypto.subtle`, which absorbs large workblocks faster than WASM — keeping receivers fast. Workblocks are byte-identical to the WebCrypto default engine and the Python `LXMF.LXStamper` reference, stamps cross-validate with every engine, and stamp generation never touches `crypto.subtle` (only `crypto.getRandomValues`), so it works outside Secure Contexts too. The engine yields to the event loop on an ~8 ms wall-clock budget so long stamping never blocks the UI for more than about a half-frame, and its yield channel is unref'd so it never holds a host process open at exit.
