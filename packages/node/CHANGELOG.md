# Changelog

## [Unreleased]
### Added
- **IFAC (Interface Authentication Code) wiring** (work doc #28): the
  node-side interfaces gain `networkName`/`passphrase`/`ifacSize` options and
  seal/verify packets at the serialize/deserialize chokepoints via the shared
  `Interface._sealRaw`/`_openRaw` helpers. Spawned sub-interfaces (TCP server,
  AutoInterface peers, HTTP server peers) propagate the IFAC config to their
  children. See `@reticulum/core` for the IFAC primitives.
- **UDP interface** (`src/interfaces/udp.js`, `UDPInterface`, work doc #26): the
  IPv4 broadcast-bus transport porting the Python reference
  `RNS/Interfaces/UDPInterface.py`. A single interface binds a UDP socket to
  receive (`listenIp`/`listenPort`) and sends raw datagrams — one RNS packet
  each, no KISS/HDLC framing — to a forward destination (`forwardIp`/
  `forwardPort`), typically a subnet broadcast address. `port` is shorthand for
  both ports; `device` (e.g. `eth0`) resolves the IPv4 broadcast address for
  both halves. Receive-only and forward-only modes are valid (a receive-only
  instance has a `null` `writable`, so the transport simply won't transmit out
  of it). Registered in the interface registry as `udp`; re-exported from the
  package index.
  - `src/utils/netinfo.js` gains `getAddressForInterface`/
    `getBroadcastForInterface` (mirroring the Python `get_address_for_if`/
    `get_broadcast_for_if`): Node's `os.networkInterfaces()` does not report
    the broadcast address, so it is computed as `(addr & netmask) | ~netmask`
    via the exported `computeIPv4Broadcast`.
- **Dual-mode rfed/LXMF CLI runner** (work doc #27): `rfed.js` now runs an
  rfed node and/or an LXMF propagation node (`--lxmf-propagation`, `--no-rfed`)
  sharing one Reticulum instance + identity + interface. Per-role limit/TTL
  flags (`--storage-limit-mb`, `--blob-ttl-days`, `--deferred-ttl-days`,
  `--lxmf-message-ttl-days`) + LXMF options (`--lxmf-stamp-cost`,
  `--lxmf-peering-cost`, `--propagation-peer`, `--autopeer`,
  `--autopeer-max-cost`).
- **LXMF message-store filesystem persistence**: `loadLXMFStore(dir)` /
  `saveLXMFStore(dir, store)` (`storage/lxmf.js`) persist the propagation-node
  message store as `propagation_messages.rmp` (msgpack), mirroring the rfed
  FS adapter.
- **rfed CLI: backup failover scheduling** (work doc #25, Phase 6). The
  runner now schedules `tickBackupDelivery()` every 30s (push own subs to the
  backup, prune stale, fail over for offline owners, chain re-push) and exposes
  `--primary-node`, `--secondary-node` (repeatable), `--owner-offline-secs`,
  `--trusted-backup-peer` (repeatable), and `--backup-interval`.
- **rfed filesystem persistence + CLI runner** (work doc #25).
  - `loadRFedStores(dir)` / `saveRFedStores(dir, stores)` (`storage/rfed.js`)
    persist the four rfed in-memory stores to disk: blobs as
    `blobs/<ch_hex>/<id_hex>.bin` (mtime preserves `received` for TTL) and
    the subscription/deferred/notify tables as `subscriptions.rmp`,
    `deferred_delivery.rmp`, `notify_registrations.rmp` (msgpack via
    `@reticulum/core`'s `MsgPack`). Missing files/dirs yield fresh stores.
  - `rfed` CLI (`src/cli/rfed.js`, exposed as the `rfed` bin): boots a
    `Reticulum` instance + mesh interface (`--interface shared|auto|tcp`),
    loads/creates the node identity, hydrates stores from disk, runs an
    `RFedNode`, and schedules hourly maintenance+persistence plus optional
    static-peer sync (`--sync-peer`, repeatable). Default stamp cost 16
    (flex 3), matching the Rust `TierPolicy::default`. SIGINT/SIGTERM flush
    stores and exit.

## [0.5.3] - 2026-08-02

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
