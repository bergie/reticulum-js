# Changelog

## [Unreleased]

## [0.5.2] - 2026-08-01

## [0.5.1] - 2026-08-01

## [0.5.0] - 2026-07-31
### Added
- Per-interface traffic counting for the Node.js interfaces. `TCPClientInterface`,
  `LocalClientInterface`, `HTTPClientInterface`, `HTTPServerExchangeClient` and
  the `AutoInterface` spawned peers now record cumulative `rxb`/`txb` byte
  counters (and expose `getStats()`) inherited from the base `Interface`, so
  apps can show transfer rates for any transport. See the `@reticulum/core`
  changelog for the base-class statistics API.
- RNode serial backend (`src/interfaces/rnode-serial.js`,
  `RNodeSerialInterface`, work doc #6): the Node.js serial transport for the
  `RNodeInterface` base (in [`@reticulum/core`](../core)). Zero-dependency: it
  opens the device non-blocking (`O_NONBLOCK` — a blocking `open()` wedges in
  uninterruptible sleep waiting for carrier detect on real RNode hardware),
  configures termios via an inherited-fd `stty` (so `stty` never re-opens the
  device, avoiding both the carrier wait and the macOS `-f`/Linux `-F` flag
  split), and drives the fd with `readSync`/`writeSync` — one `readSync` per
  event-loop tick (treating `EAGAIN` as no data) so a continuously-trickling
  radio can't starve the loop. Registered in the interface registry as
  `rnode-serial`; re-exported from the package index (also as `RNodeInterface`).
  Validated live against an ESP32 RNode (firmware 1.86).
- `FileStorageAdapter` implements the new secret-slot pair
  `loadOwnedRatchets`/`saveOwnedRatchets` for a local destination's owned
  ratchet private-key ring, written at `<dir>/owned_ratchets/<hash>.key`. Like
  `identity.key`, the file is mode `0o600` and its directory `0o700`, so the
  secret key material is owner-only regardless of the process umask.
- `@reticulum/node` is now also tested on Deno

## [0.4.5] - 2026-07-27
- The HTTP POST exchange server (the PHP-router replacement, listening
  on an open port with no authentication) now caps the request body
  (`maxRequestBodyBytes`, default 2 MiB) *before* any auth or JSON.parse and
  responds 413, so a single anonymous oversized POST can no longer OOM the
  process. Inbound `packets` are capped at `maxBatchPackets` with per-entry size
  filtering (matching the outbound cap), the session-token comparison is now
  constant-time via `crypto.timingSafeEqual`, and the Node HTTP server gets
  explicit `requestTimeout`/`headersTimeout` (slowloris defense).
- `FileStorageAdapter.saveKey` writes the identity private-key file
  with mode `0o600` and its containing directory with `0o700`. Node's default
  `0o666` resolves to `0o644` after a typical umask, leaving the key that *is*
  the node's cryptographic address world-readable to other local users.

## [0.4.4] - 2026-07-24

## [0.4.3] - 2026-07-24
### Fixed
- JSR package score: satisfy the "no slow types" scoring criterion. JSR's fast
  type-check does not auto-resolve a sibling `.d.ts` for a JavaScript
  entrypoint, so the entrypoint now carries a
  `/* @ts-self-types="…types/…d.ts" */` directive pointing at its generated
  declaration, and `types/` is shipped to JSR.

## [0.4.2] - 2026-07-24

## [0.4.1] - 2026-07-23

## [0.4.0] - 2026-07-23
### Added
- New package, carved out of [`@reticulum/core`](../core) (work doc #22):
  the Node.js-only Reticulum interfaces and the interface registry, so the
  core can stay browser-safe. Hosts `TCPClientInterface`/`TCPServerInterface`
  (`tcp`), `AutoInterface` (`auto`), `LocalClientInterface` (`local-client`,
  including shared-instance endpoint discovery and `~/.reticulum/config`
  parsing), `HttpPostServerInterface` (`http-server`), and the registry
  (`listInterfaces`/`getInterface`/`getSchema`/`registerInterface`, which also
  aggregates the browser-safe interfaces from `@reticulum/core`). Depends on
  `@reticulum/core`.
- `FileStorageAdapter` (`src/storage/file.js`, work doc #16): the Node.js
  reference `StorageAdapter`, exported from the package index. Constructed with
  a client-chosen root folder — `new FileStorageAdapter(directory)` — under
  which it writes `<dir>/identity.key` and `<dir>/<namespace>/<key>.bin`. Uses
  `node:fs/promises` (non-blocking); reads return `null`/`[]` on missing
  records, `delete` is idempotent, and a guard rejects path-traversing keys /
  namespaces. `examples/*` now import it instead of each carrying an inline
  loadKey/saveKey-only copy.
