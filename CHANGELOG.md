# Changelog

## [Unreleased]
### Added
- **core/node**: RNode (LoRa radio) interface (work doc #6): a port of the
  Python `RNS.Interfaces.RNodeInterface` KISS/RNode protocol, split across a
  transport-agnostic base and thin environment backends.
  - **core** (`src/interfaces/rnode.js`, `RNodeInterface`): owns the full
    KISS/RNode protocol — the byte-oriented read-loop state machine, the
    detect → configure → validate handshake, flow control (`CMD_READY`
    gating), radio statistics, firmware validation, and on-air bitrate
    computation. The only transport hook is `_openTransport() →
    { readable, write, close }`, which a backend overrides (now async, to
    accommodate Web Serial's `port.open()`). The full KISS command table is
    exported as a frozen `KISS` object.
  - **node** (`@reticulum/node`, `src/interfaces/rnode-serial.js`,
    `RNodeSerialInterface`): the Node.js serial backend, zero-dependency. Opens
    the device non-blocking (`O_NONBLOCK`, to avoid the uninterruptible
    carrier-detect wait that wedges blocking opens on real RNode hardware),
    configures termios via an inherited-fd `stty` (no macOS `-f`/Linux `-F`
    flag split), and drives the fd with `readSync`/`writeSync` — one `readSync`
    per event-loop tick (`EAGAIN` = no data) so a continuously-trickling radio
    can't starve the loop. Registered as `rnode-serial`. Validated live against
    an ESP32 RNode (firmware 1.86).
  - **core** (`src/interfaces/rnode-webserial.js`, `RNodeWebSerialInterface`):
    the browser backend over the Web Serial API (`navigator.serial`).
    `SerialPort` already exposes native Web Streams and handles termios
    internally, so this maps the transport directly — no `stty`/polling.
- **core**: RNode framebuffer / display API on `RNodeInterface`, porting the
  Python `enable_external_framebuffer` / `disable_external_framebuffer` /
  `write_framebuffer` / `display_image` / `read_framebuffer`. The display is
  64×64 @ 1bpp; `writeFramebuffer(line, data)` writes one 8-byte line at a
  time, prefixed with the line index and KISS-escaped (the firmware does not
  accept a whole image in a single frame). `CMD_FB_EXT`/`CMD_FB_READ`/
  `CMD_FB_WRITE` and the `FB_*` geometry constants are exported on the `KISS`
  table and as `RNodeInterface` statics. On headless hardware (no display
  reported) the framebuffer methods are no-ops that log a warning.

### Security
Hardening pass from a full security audit of the `core` and `node` packages.
All findings address untrusted input (peer-supplied wire bytes, anonymous HTTP
POSTs, identity key files on disk). No behaviour change for well-formed traffic.

- **core**: `Resource.accept` now validates the advertised part count `n` before
  allocating the receiver's `parts` array, closing a single-packet OOM. An
  attacker could advertise a tiny encrypted size `t` (under the size cap) with a
  huge `n` and crash the receiver via `new Array(n).fill(null)` in a single
  RESOURCE_ADV from any peer that had established a link. `n` is now rejected
  unless it is positive, under an absolute ceiling (`DEFAULT_MAX_PARTS`), no
  larger than `t` (each part carries at least one byte), and consistent with the
  negotiated link SDU (both ends share the link MTU) within a one-part margin.
- **core**: The HDLC stream unframer (the default framing for the TCP interface,
  the standard Reticulum transport) is now a byte-oriented state machine with a
  capped per-frame accumulator (`maxFrameSize`, default 512 KiB = 2× Python TCP
  `HW_MTU`), mirroring `kiss-framer.js`. Previously a peer could grow the
  unframer's buffer without bound by streaming non-FLAG bytes, by opening a
  frame and never closing it, or by padding a frame past the cap; the oversized
  frame is now dropped and the unframer resyncs on the next FLAG.
- **core**: `MicroMsgPack` (the parser fed directly with attacker-controlled
  bytes from LXMF messages, announce `app_data`, resource advertisements and
  propagation sync) is hardened against three untrusted-input issues: a
  `__proto__` map key no longer hijacks the decoded object's prototype chain
  (dangerous keys are stored as plain own data properties via
  `Object.defineProperty`); nested arrays/maps are capped at a depth of 128 so a
  tiny but deeply-nested payload can't exhaust the stack; and `_decodeBinary`
  bounds-checks its length before slicing so a corrupt/malicious bin length is
  rejected instead of silently returned as a truncated buffer.
- **core**: `Packet.deserialize` now computes the minimum packet length per
  header type (HEADER_2 needs 35 bytes, not the HEADER_1 floor of 19) before
  slicing, so a truncated HEADER_2 frame is rejected instead of silently
  producing a Packet with a short destination hash and an undefined context byte
  coerced to NONE. It also rejects packets whose hop count has reached
  `PATHFINDER_M` (128), mirroring Python `Packet.unpack()`'s loop-prevention
  guard that was missing from the port.
- **core**: `Identity.validate` returns `false` on a non-64-byte signature
  instead of constructing an out-of-bounds view that throws an uncaught
  RangeError, so the public method fails closed on arbitrary input. Dead
  `keyData` export removed.
- **core**: `Identity.loadOrGenerate` no longer silently mints a brand-new
  identity over an existing one. A read error from the storage adapter, or a
  stored key that is the wrong length or fails to import, now throws (with a
  loud ERROR log) rather than falling through to generate-and-overwrite — since
  the identity *is* the node's cryptographic address, silently replacing it
  would break every peer that has cached the old public key. A genuinely absent
  key file (the adapter returns `null`) still generates and persists as before.
- **core**: Removed the dead `pkcs7` import from `Token` (Web Crypto's AES-CBC
  already handles PKCS7 padding internally).
- **node**: The HTTP POST exchange server (the PHP-router replacement, listening
  on an open port with no authentication) now caps the request body
  (`maxRequestBodyBytes`, default 2 MiB) *before* any auth or JSON.parse and
  responds 413, so a single anonymous oversized POST can no longer OOM the
  process. Inbound `packets` are capped at `maxBatchPackets` with per-entry size
  filtering (matching the outbound cap), the session-token comparison is now
  constant-time via `crypto.timingSafeEqual`, and the Node HTTP server gets
  explicit `requestTimeout`/`headersTimeout` (slowloris defense).
- **node**: `FileStorageAdapter.saveKey` writes the identity private-key file
  with mode `0o600` and its containing directory with `0o700`. Node's default
  `0o666` resolves to `0o644` after a typical umask, leaving the key that *is*
  the node's cryptographic address world-readable to other local users.

### Fixed
- **core**: LXMF `send()` now reaches mobile clients (Columba, mobile
  Sideband). With no link supplied it delivered a single opportunistic packet,
  but mobile clients listen for replies over a DIRECT link — so a bot replying
  to an opportunistic/propagation-delivered message (inbound `link` is `null`)
  sent its reply to a channel the client never read. `send()` now matches
  Python's default DIRECT method (`LXMRouter.process_outbound`): it establishes
  a cached DIRECT link to the recipient (with implicit path discovery via
  `Link.initiate`) and falls back to opportunistic only when no link can be
  established. Outbound DIRECT links now also receive replies (the
  backchannel), mirroring Python's `delivery_link_established` on outbound
  direct links — previously only accepted inbound links were wired to receive.
- **core**: Persist identity learned via `LINKIDENTIFY` (work doc #16): the LXMF
  router's link `identify` handler now calls
  `rns.persistor.markContacted(peerDeliveryDest.destinationHash)` after
  `Destination.recall(...)`, so a peer that authenticated itself over a link is
  remembered across a restart. Previously the identity was held in memory only,
  so after a restart `recall(message.sourceHash)` returned null — message
  signatures couldn't be verified and the sender couldn't be identified. Uses
  the same debounced "communicated-with" signal as the transport layer's
  routable-send path.

## [0.5.2] - 2026-08-01
### Fixed
- **core**: Replaced the `{@link import("@reticulum/node").RNodeSerialInterface}` link in
  `RNodeInterface`'s class doc with plain prose. JSR's dependency analyzer
  treats any `import("@reticulum/node")` form (introduced in 0.5.1 to dodge a
  `relative-package-import` error) as a real dependency, which created a
  circular `core → node → core` graph and aborted publishing with
  `unresolvable 'jsr:' dependency: '@reticulum/node@^0.5.1'`. The package name
  is now referenced as plain code text so no import specifier is emitted.

## [0.5.1] - 2026-08-01
### Changed
- **core**: Added BigInt support in MsgPack
### Fixed
- **core**: Restarting or stopping `Destination.startAnnouncing` no longer emits a
  "straggler" announce. Previously, a periodic tick that fired just before a
  restart/stop could still broadcast after the cadence was replaced (the
  announce is async, with `await`s for `getPublicKey`/`sign` between the tick
  and the broadcast), which made the restart-burst test flaky (`3 !== 2`) and
  violated the documented "no extra immediate announce" contract. A monotonic
  generation token is now bumped on every (re)start/stop; `_emitAnnounce`
  stamps each periodic fire with the token active when it ticked and aborts
  right before broadcasting if the cadence has since changed. Direct
  `announce()` / `announcePathResponse()` calls are unaffected (always emit).
- **core**: Replaced the cross-package relative `{@link import("../../../node/…")}`
  reference in `RNodeInterface`'s class doc with the bare specifier
  `import("@reticulum/node")`, fixing the JSR
  `relative-package-import` release error.
- **core**: The reconnect backoff timer in `Interface._sleepInterruptible` no longer
  calls `timer.unref()`. An interface that is actively reconnecting keeps the
  event loop alive (it is doing real work), and the previous `unref()` made
  Deno's test runner report the reconnect-loop tests as
  "Promise resolution is still pending but the event loop has already
  resolved". `disconnect()` still aborts the in-flight backoff immediately.

## [0.5.0] - 2026-07-31
### Added
- **core**: RNode ID callsign beacon, hard reset, and display read (work doc #6): the
  remaining transport-agnostic protocol pieces of `RNodeInterface`, ported from
  the Python reference.
  - **ID beacon** — `idInterval`/`idCallsign` options (string or bytes; max 32
    encoded bytes) make the interface transmit its callsign as a raw KISS
    `CMD_DATA` frame `idInterval` seconds after its first outbound packet, then
    again after each subsequent first transmission in a quiet window. The beacon
    honours flow control (queues behind `CMD_READY`) exactly like an ordinary
    packet, and transmitting it clears the first-TX timestamp so it re-arms only
    on the next real packet (Python `first_tx`/`should_id`).
  - **`hardReset()`** — sends `CMD_RESET 0xF8` and waits 2.25 s for the radio to
    reboot (Python `hard_reset`).
  - **`readDisplay()` / `startDisplayUpdates()` / `stopDisplayUpdates()`** — the
    1024-byte on-device display snapshot via `CMD_DISP_READ` (Python
    `read_display`), distinct from the 512-byte host-writable framebuffer
    (`CMD_FB_READ`). Populates `rDisp`/`rDispLatency`; no-op on headless devices.
  New constants `DISPLAY_READ_SIZE`, `DISPLAY_READ_INTERVAL`, `CALLSIGN_MAX_LEN`
  join the exported `KISS` table and the `RNodeInterface` statics.
- **core**: Periodic re-announce scheduler (PROTOCOL-SPEC.md §7.5 / §9.7 —
  "non-optional": without it transit relays evict the path within minutes and
  peers can no longer reach you). `Destination.startAnnouncing({ intervalMs })`
  / `stopAnnouncing()` drive a `setInterval` loop that re-announces on a fixed
  cadence — the Python reference has no application-destination default, so the
  default is 30 min (matching Sideband and the manual's desktop recommendation).
  The first announce fires immediately so the destination is reachable right
  away; the cadence is clamped to a 60 s floor (sub-minute intervals trigger
  ingress rate limiting and burn ratchet-ring slots, §9.7); a failed fire is
  logged and does not stop the loop; re-calling `startAnnouncing` updates the
  interval without an extra immediate burst. `LXMRouter.startAnnouncing(name,
  { stampCost, intervalMs })` / `stopAnnouncing()` wrap it for the
  `lxmf.delivery` destination, replacing the one-shot `announce()` for the
  common "announce and keep announcing" case.
- **core**: Interface statistics for observability/UIs. The base `Interface` now carries
  the Python reference's cumulative byte counters (`rxb`/`txb`, counted as the
  on-the-wire RNS packet length, matching `self.rxb`/`self.txb`) and a
  `created` epoch timestamp, plus a `getStats()` snapshot returning
  `{ name, online, bitrate, rxb, txb, created }`. Apps derive a transfer rate
  by sampling `rxb`/`txb` over time. Counting is wired into every interface's
  single TX/RX chokepoint (`_recordOutbound` / `_dispatchPacket` helpers), so
  it covers both transport-routed and direct `send()` traffic. RNode keeps its
  own IFAC-aware counting.
- **core**: RNode radio telemetry is now fully parsed and exposed. `CMD_STAT_CHTM`
  previously discarded bytes 0–7 and only kept signal readings; it now also
  populates `rAirtimeShort`/`rAirtimeLong` (transmit airtime, %) and
  `rChannelLoadShort`/`rChannelLoadLong` (channel utilization, %) — the
  channel-utilization figure apps want to show. `CMD_STAT_PHYPRM` now
  populates the pre-amble and CSMA timing fields (`rPreambleSymbols`,
  `rPreambleTimeMs`, `rCsmaSlotTimeMs`, `rCsmaDifsMs`), the new
  `CMD_STAT_CSMA` handler populates the contention window
  (`rCsmaCwBand`/`rCsmaCwMin`/`rCsmaCwMax`), and the echoed
  `CMD_ST_ALOCK`/`CMD_LT_ALOCK` limits are stored as `rStAlock`/`rLtAlock`.
  `RNodeInterface.getStats()` extends the base snapshot with all of this plus
  signal quality (RSSI/SNR/Q), battery and temperature.
- **core**: RNode (LoRa radio) interface — transport-agnostic base (work doc #6): a port
  of the Python `RNS.Interfaces.RNodeInterface` KISS/RNode protocol.
  `src/interfaces/rnode.js` (`RNodeInterface`) owns the full protocol — the
  byte-oriented read-loop state machine, the detect → configure → validate
  handshake, flow control (`CMD_READY` gating), radio statistics, firmware
  validation, and on-air bitrate computation. The only transport hook is
  `_openTransport() → { readable, write, close }`, which a backend subclass
  overrides (now async, to accommodate Web Serial's `port.open()`). The full
  KISS command table is exported as a frozen `KISS` object. The Node.js serial
  backend lives in [`@reticulum/node`](../node).
- **core**: RNode Web Serial backend (`src/interfaces/rnode-webserial.js`,
  `RNodeWebSerialInterface`): the browser counterpart, over the Web Serial API
  (`navigator.serial`). `SerialPort` already exposes native Web Streams and
  handles termios internally, so this maps the transport directly (no
  `stty`/polling/carrier-detect workaround). Pass a `SerialPort` obtained from
  a user gesture via `options.serialPort`, or let `_openTransport()` call
  `requestPort()`. The serial-line flow-control open option is
  `serialFlowControl` (kept distinct from the base LoRa `flowControl` boolean).
- **core**: RNode framebuffer / display API on `RNodeInterface`, porting the Python
  `enable_external_framebuffer` / `disable_external_framebuffer` /
  `write_framebuffer` / `display_image` / `read_framebuffer`. The display is
  64×64 @ 1bpp; `writeFramebuffer(line, data)` writes one 8-byte line at a
  time, prefixed with the line index and KISS-escaped (the firmware does not
  accept a whole image in a single frame). `CMD_FB_EXT`/`CMD_FB_READ`/
  `CMD_FB_WRITE` and the `FB_*` geometry constants are exported on the `KISS`
  table and as `RNodeInterface` statics. On headless hardware (no display
  reported) the framebuffer methods are no-ops that log a warning.
- **core**: Owned ratchet private-key rings are now persisted across restarts (§7.4),
  fixing opportunistic-delivery decryption failures after a restart. A local
  `SINGLE` destination with ratchets enabled (`Destination.enableRatchets`,
  used by `LXMRouter` for `lxmf.delivery`) writes its private-key ring — signed
  by the destination's identity — to the `StorageAdapter` on every rotation and
  reloads it (signature-verified) on `enableRatchets`, so messages encrypted to
  a pre-restart ratchet still decrypt. The `StorageAdapter` contract gains a
  secret-slot pair `loadOwnedRatchets`/`saveOwnedRatchets` (backends MUST store
  owner-only, like `loadKey`/`saveKey`); `MemoryStorageAdapter` implements it
  in-memory. On a decrypt failure the owned ring is reloaded from storage and
  retried once (handles a concurrent process having rotated). The persisted
  layout mirrors `RNS.Destination._persist_ratchets`:
  `msgpack({ signature, ratchets: msgpack([[priv32, pub32], ...]) })`.
  `Destination.MAX_RATCHETS` is raised 128 → 512 to match the Python
  `RATCHET_COUNT`.
- **core**: Learned peer ratchets (`Destination.knownRatchets`, the *public* keys used
  to encrypt outbound) now retain only the single newest ratchet per
  destination with a 30-day expiry, matching `RNS.Identity` (`RATCHET_EXPIRY`,
  `_remember_ratchet`, `_clean_ratchets`). Previously every distinct ratchet
  heard was accumulated into an ever-growing, never-expiring ring (unbounded
  memory/disk growth, stale keys never dropped). A newer announce overwrites;
  re-announcing the same ratchet is a no-op (the receipt time is not
  refreshed); `Destination.recallRatchets` is replaced by `recallRatchet`
  (single value, drops expired entries on read); and the new
  `Destination.cleanKnownRatchets` drops expired entries and ratchets whose
  destination has been forgotten, run once on `Persistor.load`. The persisted
  ratchet record changes from a msgpack array to `{ratchet, received}`.
- **core**: `@reticulum/core` is now also tested on Deno
- **node**: Per-interface traffic counting for the Node.js interfaces. `TCPClientInterface`,
  `LocalClientInterface`, `HTTPClientInterface`, `HTTPServerExchangeClient` and
  the `AutoInterface` spawned peers now record cumulative `rxb`/`txb` byte
  counters (and expose `getStats()`) inherited from the base `Interface`, so
  apps can show transfer rates for any transport. See the `@reticulum/core`
  changelog for the base-class statistics API.
- **node**: RNode serial backend (`src/interfaces/rnode-serial.js`,
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
- **node**: `FileStorageAdapter` implements the new secret-slot pair
  `loadOwnedRatchets`/`saveOwnedRatchets` for a local destination's owned
  ratchet private-key ring, written at `<dir>/owned_ratchets/<hash>.key`. Like
  `identity.key`, the file is mode `0o600` and its directory `0o700`, so the
  secret key material is owner-only regardless of the process umask.
- **node**: `@reticulum/node` is now also tested on Deno

## [0.4.5] - 2026-07-27

## [0.4.4] - 2026-07-24
### Fixed
- **core**: Added handling for `0xcf` in MsgPack as Columba uses it for NomadNet requests

## [0.4.3] - 2026-07-24
### Fixed
- **core**: JSR package score: satisfy the "no slow types" and "every entrypoint has a
  module doc" scoring criteria. JSR's fast type-check does not auto-resolve a
  sibling `.d.ts` for a JavaScript entrypoint, so each of the 12 entrypoints
  now carries a `/* @ts-self-types="…types/…d.ts" */` directive pointing at
  its generated declaration, and `types/` is shipped to JSR (`jsr.json`
  `publish.include`; the declarations stay git-ignored build artifacts,
  un-ignored only at publish time (in CI, or locally via `scripts/jsr-dryrun.sh`)
  because `deno publish` honors `.gitignore`). Six entrypoints additionally had
  their module doc placed after the imports (or were missing one) and so were
  not recognized — these are now leading the file.
- **node**: JSR package score: satisfy the "no slow types" scoring criterion. JSR's fast
  type-check does not auto-resolve a sibling `.d.ts` for a JavaScript
  entrypoint, so the entrypoint now carries a
  `/* @ts-self-types="…types/…d.ts" */` directive pointing at its generated
  declaration, and `types/` is shipped to JSR.
- **webrtc-node**: JSR package score: satisfy the "no slow types" scoring criterion. JSR's fast
  type-check does not auto-resolve a sibling `.d.ts` for a JavaScript
  entrypoint, so the entrypoint now carries a
  `/* @ts-self-types="…types/…d.ts" */` directive pointing at its generated
  declaration, and `types/` is shipped to JSR.
- **websocket-server-node**: JSR package score: satisfy the "no slow types" scoring criterion. JSR's fast
  type-check does not auto-resolve a sibling `.d.ts` for a JavaScript
  entrypoint, so the entrypoint now carries a
  `/* @ts-self-types="…types/…d.ts" */` directive pointing at its generated
  declaration, and `types/` is shipped to JSR.

## [0.4.2] - 2026-07-24
### Fixed
- **core**: LXMF `LXMRouter.send()` now reaches mobile clients (Columba, Sideband on
  mobile). When no link was supplied it delivered a single **opportunistic**
  packet, but mobile LXMF clients listen for replies over a **DIRECT** link —
  so a bot responding to an opportunistic/propagation-delivered message (where
  the inbound `link` is `null`) sent its reply to a channel the client never
  read, and the message silently disappeared. `send()` now matches the Python
  reference's default delivery method (`LXMRouter.process_outbound`, which is
  `LXMessage.DIRECT`): it establishes a DIRECT link to the recipient and sends
  the body over it (with the once-per-link `LINKIDENTIFY` the responder
  requires before it will accept application DATA), falling back to a single
  opportunistic packet only when no link can be established (peer unreachable
  or identity unknown). `Link.initiate` does implicit path discovery, so this
  reaches a client the same way an explicit `createLink()` does. The established
  link is cached per recipient hash (`directLinks`) and reused across sends.
  No echo-bot code change is needed — `send(reply, identity, link)` now does
  the right thing when `link` is `null`.
- **core**: Outbound DIRECT links now **receive replies** (the backchannel). The router
  only wired up the `data`/`resource` inbound listeners on *accepted* (inbound)
  links, never on links it initiated — so a reply arriving on an outbound
  delivery link was dropped. Mirrors Python, which calls
  `delivery_link_established` on outbound direct links as well as inbound ones.
  The listeners are factored into `_attachLinkMessageListeners(link)`, shared by
  both paths. New round-trip test `test/lxmf/echo_direct_repro.test.js`.

## [0.4.1] - 2026-07-23
### Fixed
- **core**: Persist identity learned via `LINKIDENTIFY` (work doc #16): the LXMF router's
  link `identify` handler now calls
  `rns.persistor.markContacted(peerDeliveryDest.destinationHash)` after
  `Destination.recall(...)`, so a peer that authenticated itself over a link is
  remembered across a restart. Previously the identity was held in memory only,
  so after a restart `recall(message.sourceHash)` returned null — message
  signatures couldn't be verified and the sender couldn't be identified. Uses
  the same debounced "communicated-with" signal as the transport layer's
  routable-send path.

## [0.4.0] - 2026-07-23
### Changed (breaking)
- **core**: Scoped rename + JSR distribution (work doc #24): the package is renamed
  `reticulum-js` → **`@reticulum/core`** and moved to `packages/core/`. Update
  imports `"reticulum-js"` → `"@reticulum/core"` (and deep imports
  `"reticulum-js/src/..."` → `"@reticulum/core/src/..."`). The legacy
  `reticulum-js` npm package is deprecated in favour of `@reticulum/core`.
- **core**: `LogLevel` (`src/utils/log.js`) is realigned with the Python reference
  `RNS.LOG_*` enum (`RNS/__init__.py:65-74`): names, ordering and numeric
  values now match Python exactly. Work doc #21.
  - New scheme: `NONE=-1`, `CRITICAL=0`, `ERROR=1`, `WARNING=2`, `NOTICE=3`,
    `INFO=4`, `VERBOSE=5`, `DEBUG=6`, `PATHING=7`, `EXTREME=8`. (Previously
    `NONE=0…EXTREME=6`, offset by one and gappy.)
  - `VERBOSE` and `DEBUG` were previously **inverted** relative to Python
    (`DEBUG` used to be *less* verbose than `VERBOSE`); they now match, with
    `VERBOSE` (5) < `DEBUG` (6). Code that compared levels by raw value rather
    than by name needs review.
  - `LogLevel.LOG` → `LogLevel.NOTICE` and `LogLevel.WARN` →
    `LogLevel.WARNING`, renamed at all call sites (no aliases). Neither name
    exists in Python. New levels `CRITICAL`, `NOTICE`, `INFO`, `PATHING` added
    to mirror Python.
  - The default threshold is now `NOTICE` (Python's `LOG_NOTICE`) rather than
    the old `LOG`. Same numeric position (3), so default *verbosity* is
    unchanged: `ERROR`/`WARNING`/`NOTICE` show, `INFO` and above stay hidden.
  - `log()`'s default message level stays `DEBUG` (now value 6), so the ~140
    bare `log("Mod", msg)` call sites remain hidden unless the operator raises
    the threshold to `DEBUG`.
- **core**: Monorepo split (work doc #22): the Node.js-only interfaces —
  `TCPClientInterface`/`TCPServerInterface` (`tcp`), `AutoInterface`
  (`auto`), `LocalClientInterface` (`local-client`),
  `HttpPostServerInterface` (`http-server`) — and the interface registry
  (`listInterfaces`/`getInterface`/`getSchema`/`registerInterface`) moved to
  the new [`@reticulum/node`](../node) companion package.
  Import them from `@reticulum/node` instead of
  `@reticulum/core/src/interfaces/...`. The core package is now browser-safe
  (zero `node:` imports). The `WebSocketServerInterface` stub was removed
  from `src/interfaces/websocket.js` (it is inherently Node-only); the real
  server lives in
  [`@reticulum/websocket-server-node`](../websocket-server-node).
  (`WebSocketClientInterface` stays in core.)
### Added
- **core**: JSR publishing (work doc #24): a `jsr.json` makes the browser-safe core
  natively consumable from Deno and the browser via [JSR](https://jsr.io)
  (`@reticulum/core`); CI mirrors each tagged release to JSR using GitHub OIDC.
  Companions remain npm-only.
- **core**: Selective persistence layer (work doc #16): learned peers, ratchet rings
  and path entries now survive a restart when a `StorageAdapter` is supplied
  to `Reticulum({ storageAdapter })`. The contract is backend-agnostic and the
  core stays zero-dependency / browser-safe; the Node.js reference
  `FileStorageAdapter` ships in
  [`@reticulum/node`](../node).
  - New `src/storage/` module: the `StorageAdapter` typedef (async KV —
    `loadKey`/`saveKey` for the identity blob; namespaced `get`/`set`/`delete`/
    `keys` for everything else, the same shape `InterfaceDiscovery` already
    feature-detected), `StorageNamespace` (`identities`/`ratchets`/`paths`),
    and `MemoryStorageAdapter` (reference in-memory backend).
  - `Persistor` (`src/storage/persistor.js`) owns the *policy*: only
    destinations we **communicate with** (`markContacted`, called by
    `TransportCore.sendPacket` on outbound routable sends and by
    `LXMRouter._processIncomingMessage` for validated inbound senders) **or
    explicitly favorite** (`rns.persistor.store(hash, { announce })`) are
    persisted. Values are msgpack; the `known_destinations` tuple
    (`[time, packet_hash, public_key, app_data, 0]`) matches Python
    (`RNS/Identity.py:107`) so a blob is interchangeable. Writes are debounced;
    `store()` and `rns.persistor.flush()` flush immediately — call the latter
    on graceful shutdown. `load()` hydrates at startup
    (`rns.persistorLoadPromise`).
  - `Reticulum` constructs the `Persistor` from `storageAdapter` and hands it
    to `this.transport.persistor`; `config.storageAdapter` is now typed as
    `StorageAdapter`. `TransportCore.sendPacket` falls back to the default
    interface for hydrated path entries (which carry no live `interface` ref)
    instead of throwing.
  - New public exports: `Persistor`, `MemoryStorageAdapter`,
    `StorageNamespace`. Tests in `test/storage/` (storage contract, Persistor
    policy + round-trips, and the `Reticulum`/`TransportCore` wiring).
- **core**: Inbound packet-hash dedup (`TransportCore.packetHashlist`, work doc #16
  stretch): a non-announce packet whose hash has already been seen is now
  dropped, porting Python's `Transport.packet_filter` / `packet_hashlist`. A
  two-set ring (`packetHashlist` + `packetHashlistPrev`) rotates once it exceeds
  `hashlistMaxsize/2` (default `50000` — leaf-appropriate vs Python's
  transport-node `1e6`). Contexts that legitimately recur or carry their own
  sequencing bypass it (`KEEPALIVE`, `RESOURCE`, `RESOURCE_REQ`,
  `RESOURCE_PRF`, `CACHE_REQUEST`, `CHANNEL`); announces are exempt (their
  replay protection is the RoutingTable `random_blob` check). Fixes duplicate
  delivery from identical retransmissions. In-memory only for now (persisting
  the ring has marginal value across a restart). Tests in
  `test/transport/dedup.test.js`.
- **core**: `Reticulum.stop()`: graceful shutdown — stops interface discovery,
  disconnects every attached interface (best-effort; a failing `disconnect()` is
  logged, not thrown), and flushes the persistence layer so the final debounced
  batch isn't lost. Idempotent. Links/channels are owned by the application and
  terminate when their interfaces close.
- **core**: Controllable log level: the threshold is no longer hard-coded (was a
  module-private `const` with a `// TODO: Read from env`). Work doc #21.
  - `RETICULUM_LOG_LEVEL` environment variable, read once at module load,
    accepts a level name (`"DEBUG"`) or a number (`6`). Read defensively via
    `globalThis.process.env` / `globalThis.Deno.env`, so the core stays
    dependency-free and browser-safe; browsers have no env and fall back to
    the default.
  - `Reticulum({ logLevel })` constructor option (`src/core/reticulum.js`)
    sets the threshold at construction, mirroring Python's `loglevel=`. Takes
    precedence over the env var; accepts a name or a number.
  - New public exports from the main entry (`src/index.js`):
    `LogLevel`, `setLogLevel(level)`, `getLogLevel()`,
    `parseLogLevel(value, fallback)` (clamps numeric input to
    `[CRITICAL, EXTREME]` like Python; unknown names fall back), and the
    `LOG_LEVEL_ENV` constant (`"RETICULUM_LOG_LEVEL"`).
  - Precedence (highest first): `Reticulum({ logLevel })` →
    `RETICULUM_LOG_LEVEL` → default `NOTICE`. Smoketest in `test/utils/log.test.js`.
- **core**: `WebRTCInterface` (`src/interfaces/webrtc.js`): bridges an open WebRTC
  `RTCDataChannel` into RNS streams — the "transport upgrade" half of work
  doc #19. Once a signaling orchestrator has exchanged SDP over a Reticulum
  Link+Resource and opened a data channel, that channel is wrapped by this
  interface and registered with the transport as a high-bandwidth (~50 Mbit/s)
  direct peer link. Message-oriented like the WebSocket interface in raw
  framing: each binary message carries exactly one RNS packet, no HDLC
  byte-stuffing. Registered in the interface registry under `"webrtc"`.
  - Written against the duck-typed `RTCDataChannel` shape (`.send()`,
    `.binaryType`, `.readyState`, `message`/`open`/`close`/`error` events) so
    it runs in a browser and is exercisable in Node tests via a mock channel
    pair (Node has no native WebRTC). Not a reconnecting dialer — a channel
    close is terminal since re-establishing WebRTC requires re-running
    signaling.
  - Only the interface half lands in this change; the signaling orchestrator
    (custom-destination announce + Link + Resource SDP exchange, then
    `addInterface`) is a follow-up.
- **core**: WebRTC transport signaling orchestrator (`src/webrtc/signaling.js`,
  `WebRTCSignaling`): completes the WebRTC transport upgrade started by
  `WebRTCInterface`. Runs the two-stage lifecycle from work doc #19 — (1)
  discovery via a shared `"rns.webrtc"` SINGLE destination announcing a
  one-byte capability flag (`0x01`) as `app_data`, surfaced as `"peer"`
  events after name-hash aspect filtering; (2) SDP exchange over an encrypted
  Reticulum Link where the offer/answer travel as Reticulum Resources
  (auto-fragmented across the 500-byte MTU) inside a 1-byte-type framing
  envelope (`0x01` offer / `0x02` answer / `0x03` reserved for future trickle
  ICE) + UTF-8 SDP. Once the `RTCDataChannel` opens it is wrapped in a
  `WebRTCInterface` and registered with the transport; the signaling Link is
  then torn down. First cut is non-trickle (waits for
  `iceGatheringState === "complete"` and ships the full local description).
  - **Dependency-injection-first:** the `RTCPeerConnection` factory is injected
    (`createPeerConnection` option) and auto-detects the browser global when
    omitted, so the core stays browser-safe/WinterTC-pure and the full
    negotiation state machine is mock-testable in Node (Node has no native
    WebRTC; the `@reticulum/webrtc-node` companion package injects a runtime — see work doc #19
    update #3). `rtcConfig` passes through STUN/TURN.
  - `test/webrtc/signaling.js`: unit tests plus a true end-to-end case — two
    real `Reticulum` instances bridged by a loopback interface pair, a mock
    `RTCPeerConnection` pair injected via the seam, running the real link
    handshake + Resource transfer, with a packet round-tripping through the
    established channel.
  - Public exports added to `src/index.js` (`WebRTCSignaling` and the
    capability/SDP constants as `WEBRTC_*`).
  - Cross-language spec in `documents/WebRTC Transport.md` so Python/Node/other
    ports can interoperate (this transport has no Python reference; the JS
    implementation defines the wire format).
- **core**: Interface discovery (consumer/discoverer side): a leaf node can now
  **discover transports it can connect to** by listening for the
  `rnstransport.discovery.interface` announce aspect, instead of requiring a
  hardcoded host:port or a local shared instance. A port of the consumer half
  of the Python reference `RNS/Discovery.py` (`InterfaceAnnounceHandler` + the
  consumer subset of `InterfaceDiscovery`); the producer `InterfaceAnnouncer`
  and `BlackholeUpdater` remain a follow-up.
  - New module `src/transport/discovery.js` exporting:
    - `InterfaceDiscovery` (EventTarget) — subscribes to the existing transport
      `"announce"` event and **aspect-filters by the precomputed 10-byte
      `name_hash`** of `rnstransport.discovery.interface` (no new
      announce-handler registry), verifies the LXMF stamp, normalizes the
      record, and dispatches a `"discovered"` event with the parsed `info`
      (name, type, reachable_on, port, transport_id, hops, stamp value, geo)
      plus a generated `config_entry`. Surfaced via `rns.discovery`
      (`rns.discovery.startPromise` awaits readiness).
    - `parseDiscoveryAnnounce(appData, announcedIdentity, opts)` — splits
      `flags || payload`, decrypts when `FLAG_ENCRYPTED`, verifies the trailing
      32-byte LXMF stamp at `expand_rounds = 20` / `requiredValue` (default
      `16`, the value RNS 1.4.0 raised `DEFAULT_STAMP_VALUE` to; configurable
      per network), then unpacks and validates the msgpack `info` dict.
    - `listDiscoveredInterfaces({ onlyAvailable, onlyTransport })` with the
      stale/unknown/available status model and the 1/3/7-day pruning
      thresholds.
    - Optional `discoverySources` authorization (only accept discoveries from
      the listed network identities).
    - Producer primitives `generateDiscoveryStamp` / `buildDiscoveryAppData`
      exposed so callers/tests can mint valid announces.
    - `sanitizeName`, `isIpAddress`, `isHostname`, `buildConfigEntry` ported
      byte-for-byte from `RNS/Discovery.py`.
  - `Reticulum({ enableDiscovery: true })` constructs and auto-starts an
    `InterfaceDiscovery` on the instance's transport, mirroring Python's
    `discover_interfaces` config option. A no-op / `null` when the flag is off,
    so the core stays browser-safe.
  - Public exports for the discovery API added to `src/index.js`.
  - **Persistence** is forward-compatible with work doc #16: `InterfaceDiscovery`
    feature-detects the proposed KV storage interface and persists discovered
    interfaces (status, `last_heard`, `heard_count`) across restarts; when the
    adapter lacks it (or there is none), discoveries stay in memory.
  - **Surface-only v1** — no auto-connect; the `config_entry` is generated for a
    human operator to add the interface. Announce processing is serialized per
    instance (a promise chain mirroring Python's `discovery_lock`) so
    concurrent announces for the same interface can't lose `heard_count`
    increments.
  - Verified against the installed RNS reference (1.4.0): a fixture generated
    from real `InterfaceAnnounceHandler.received_announce` output is parsed
    byte-for-byte — `config_entry`, `discovery_hash`, `transport_id`,
    `network_id`, geo, and stamp value all match.
- **core**: Interface `bitrate`: every interface now declares a nominal physical
  bitrate (bits/s) as `iface.bitrate`, ported from `self.bitrate` on
  `RNS.Interfaces.Interface` in the Python reference. The base `Interface`
  default is `62500`; per-interface values match Python where one exists
  (TCP client/server `10000000`, `LocalClientInterface` `1000000000`,
  `AutoInterface`/`AutoInterfacePeer` `10000000`) and are set sensibly for
  the JS-specific interfaces (WebSocket `10000000`, HTTP POST
  client/server/peer `1000000`). Server interfaces that spawn client
  interfaces (`TCPServerInterface`, `AutoInterface`, `HttpPostServerInterface`)
  now copy their bitrate onto each spawned child, mirroring Python's
  `spawned_interface.bitrate = self.bitrate`.
  - The `bitrate` value is now put to use for interface ordering — see
    `TransportCore.prioritizeInterfaces()` below. Per-bitrate link timeouts,
    MTU derivation, and announce rate limiting remain a follow-up.
- **core**: Interface prioritization by bitrate (`TransportCore.prioritizeInterfaces()`,
  work doc #20 Phase 1): the interface set is now kept ordered
  highest-bitrate-first, a direct port of the Python reference's
  `Transport.prioritize_interfaces()`
  (`Transport.interfaces.sort(key=lambda i: i.bitrate, reverse=True)`,
  try/except-wrapped). Re-sorted eagerly on `addInterface`/`removeInterface`
  (JS has no per-interface jobs loop). Because routing is path-table driven
  (same as Python), the sort governs iteration order — `broadcast()` and any
  "first available" walk now visit higher-bitrate interfaces first — rather
  than changing which interface carries a given routed packet. Interfaces with
  a missing/non-numeric/zero bitrate sort last instead of throwing (Python's
  comparator would raise mid-sort and be swallowed by its try/except, leaving
  the list unsorted). `Reticulum.MINIMUM_BITRATE = 5` added for parity with
  `RNS.Reticulum.MINIMUM_BITRATE` (config-time validation only, as in Python —
  it does not skip interfaces in routing). Smoketested in
  `test/transport/prioritize.test.js`. The genuine per-bitrate behaviours
  (link timeouts `~1/bitrate`, announce rate limiting, MTU derivation) are
  Phase 2/3.
- **node**: New package, carved out of [`@reticulum/core`](../core) (work doc #22):
  the Node.js-only Reticulum interfaces and the interface registry, so the
  core can stay browser-safe. Hosts `TCPClientInterface`/`TCPServerInterface`
  (`tcp`), `AutoInterface` (`auto`), `LocalClientInterface` (`local-client`,
  including shared-instance endpoint discovery and `~/.reticulum/config`
  parsing), `HttpPostServerInterface` (`http-server`), and the registry
  (`listInterfaces`/`getInterface`/`getSchema`/`registerInterface`, which also
  aggregates the browser-safe interfaces from `@reticulum/core`). Depends on
  `@reticulum/core`.
- **node**: `FileStorageAdapter` (`src/storage/file.js`, work doc #16): the Node.js
  reference `StorageAdapter`, exported from the package index. Constructed with
  a client-chosen root folder — `new FileStorageAdapter(directory)` — under
  which it writes `<dir>/identity.key` and `<dir>/<namespace>/<key>.bin`. Uses
  `node:fs/promises` (non-blocking); reads return `null`/`[]` on missing
  records, `delete` is idempotent, and a guard rejects path-traversing keys /
  namespaces. `examples/*` now import it instead of each carrying an inline
  loadKey/saveKey-only copy.
- **webrtc-node**: New package (work doc #22): supplies the `createPeerConnection` factory
  backed by [werift](https://github.com/shinyoshiaki/werift) that the core's
  `WebRTCSignaling` ([`@reticulum/core`](../core)) expects via dependency
  injection, closing the WebRTC transport loop on Node (Node has no native
  `RTCPeerConnection`). Re-exports werift's `RTCPeerConnection`. Depends on
  `@reticulum/core` and `werift`.
- **websocket-server-node**: New package (work doc #22): real `WebSocketServerInterface` backed by
  [ws](https://github.com/websockets/ws), replacing the stub removed from the
  [`@reticulum/core`](../core) core. Listens for inbound WebSocket
  connections and spawns a `WebSocketClientInterface` (from `@reticulum/core`) per
  accepted connection, mirroring `TCPServerInterface`. Not registered in the
  [`@reticulum/node`](../node) registry, to avoid forcing a
  `ws` dependency there. Depends on `@reticulum/core` and `ws`.
