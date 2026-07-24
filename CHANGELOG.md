# Changelog

## [Unreleased]
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
