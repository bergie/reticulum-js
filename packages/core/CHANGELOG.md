# Changelog

## [Unreleased]
### Fixed
- Persist identity learned via `LINKIDENTIFY` (work doc #16): the LXMF router's
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
- Scoped rename + JSR distribution (work doc #24): the package is renamed
  `reticulum-js` → **`@reticulum/core`** and moved to `packages/core/`. Update
  imports `"reticulum-js"` → `"@reticulum/core"` (and deep imports
  `"reticulum-js/src/..."` → `"@reticulum/core/src/..."`). The legacy
  `reticulum-js` npm package is deprecated in favour of `@reticulum/core`.
- `LogLevel` (`src/utils/log.js`) is realigned with the Python reference
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
- Monorepo split (work doc #22): the Node.js-only interfaces —
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
- JSR publishing (work doc #24): a `jsr.json` makes the browser-safe core
  natively consumable from Deno and the browser via [JSR](https://jsr.io)
  (`@reticulum/core`); CI mirrors each tagged release to JSR using GitHub OIDC.
  Companions remain npm-only.
- Selective persistence layer (work doc #16): learned peers, ratchet rings
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
- Inbound packet-hash dedup (`TransportCore.packetHashlist`, work doc #16
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
- `Reticulum.stop()`: graceful shutdown — stops interface discovery,
  disconnects every attached interface (best-effort; a failing `disconnect()` is
  logged, not thrown), and flushes the persistence layer so the final debounced
  batch isn't lost. Idempotent. Links/channels are owned by the application and
  terminate when their interfaces close.
- Controllable log level: the threshold is no longer hard-coded (was a
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
- `WebRTCInterface` (`src/interfaces/webrtc.js`): bridges an open WebRTC
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
- WebRTC transport signaling orchestrator (`src/webrtc/signaling.js`,
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
- Interface discovery (consumer/discoverer side): a leaf node can now
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

- Interface `bitrate`: every interface now declares a nominal physical
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
- Interface prioritization by bitrate (`TransportCore.prioritizeInterfaces()`,
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

## [0.3.0] - 2026-07-18
### Removed (breaking)
- Network interfaces are no longer re-exported from the package main entry
  (`src/index.js`). The eight interface classes (`AutoInterface`,
  `HttpPostClientInterface`, `HttpPostServerInterface`, `LocalClientInterface`,
  `TCPClientInterface`, `TCPServerInterface`, `WebSocketClientInterface`,
  `WebSocketServerInterface`) and the interface-registry helpers
  (`listInterfaces`, `getInterface`, `getSchema`, `registerInterface`) must now
  be imported directly by subpath, e.g.
  `import { TCPClientInterface } from "reticulum-js/src/interfaces/tcp.js"`.
  **Why:** several interfaces import Node.js builtins (`node:net`,
  `node:dgram`, `node:http`, `node:crypto`, `node:stream`) at module top level,
  and ESM eagerly evaluates the whole static import graph — so re-exporting
  them from the main entry meant `import { Reticulum } from "reticulum-js"`
  pulled in those builtins and failed in browsers / bundlers without Node
  shims. The registry was the same: `src/interfaces/registry.js` statically
  imports every interface, so it is Node-only too. Removing these re-exports
  makes the core (and everything else in the main entry) browser-safe.
- `Reticulum.connectToSharedInstance()` has been removed from the `Reticulum`
  core class, along with its write-only shared-instance role state
  (`isSharedInstance` / `isConnectedToSharedInstance` /
  `isStandaloneInstance` / `sharedInstanceInterface`, none of which were read
  anywhere). It is replaced by a static factory on the interface itself (see
  *Changed*). The core no longer references the local-client interface or the
  config reader at all, so importing `Reticulum` pulls in zero Node.js
  builtins.
- `src/core/config.js` has been deleted. Its contents — the Python
  `~/.reticulum/config` discovery helpers (`getSharedInstanceEndpoint`,
  `loadConfig`, `parseConfigFile`, `resolveConfigDir`, `supportsAbstractAfUnix`,
  `asBool`/`asInt`, and the `DEFAULT_SHARED_INSTANCE_PORT` / `AF_UNIX_PREFIX`
  constants) — moved into `src/interfaces/local_client.js`, the only consumer.
  They are no longer re-exported from the main entry (they need `node:fs` /
  `node:os` / `node:path`); import them from
  `reticulum-js/src/interfaces/local_client.js` instead.

### Changed (breaking)
- Shared-instance connection is now a static factory on the interface:
  `const shared = await LocalClientInterface.connectToSharedInstance()`
  (from `reticulum-js/src/interfaces/local_client.js`). It discovers the
  endpoint from the Python config, connects, and returns the connected
  `LocalClientInterface` (or `null` if `share_instance = No` / unreachable) —
  but, unlike the old `Reticulum` method, it does **not** attach the interface
  to the transport; the caller now does `rns.addInterface(shared, true)`.
  `examples/*` and the README usage snippet updated to the new pattern.

### Added
- Link `Channel`: reliable, bi-directional, size-constrained typed-message
  exchange over an active `Link`, a port of the Python reference
  `RNS/Channel.py`. A `Channel` lets two peers exchange `MessageBase`
  subclasses (each declaring a unique `MSGTYPE < 0xf000`) for as long as the
  link is open, with automatic retries, an adaptive send window, and
  in-order / dedup'd delivery. Each message rides in an `Envelope`
  (`msgtype ‖ sequence ‖ length ‖ data`, big-endian) inside a Token-encrypted
  `context = CHANNEL (0x0e)` DATA packet; the receiver re-proves every
  CHANNEL packet before handing the plaintext to the channel. Obtain a
  channel with `link.getChannel()`, register types with
  `channel.registerMessageType(Class)`, receive with
  `channel.addMessageHandler(cb)`, and send with `channel.send(msg)`. The
  adaptive-window constants (`WINDOW*`, `RTT*`, `FAST_RATE_THRESHOLD`) match
  Python verbatim, so pacing/retry behaviour is compatible. Two JS-specific
  adaptations: Python's ring locks become synchronous critical sections + a
  send Promise chain, and the per-packet `PacketReceipt` callbacks become a
  `proof`-event listener + `setTimeout` (our link has no per-packet receipt
  object); the latter needed an `_earlyDelivered` stash to handle the
  zero-latency proof race Python avoids via real network latency. Public API
  (`Channel`, `MessageBase`, `Envelope`, `ChannelException`, `CEType`,
  `MessageState`, `SystemMessageTypes`, `LinkChannelOutlet`) exported from
  `src/index.js`.
- Link Channel **Web Stream buffer layer**: byte streams over a `Channel`,
  the JS analog of Python `RNS/Buffer.py`. `StreamDataMessage` (system
  `MSGTYPE 0xff00`, wire `header(2) ‖ data` packing `stream_id` / `compressed` /
  `eof`) frames a continuous byte flow, multiplexed by `stream_id`. Obtain a
  stream from a channel: `channel.openReadable(streamId)` →
  `ReadableStream<Uint8Array>`, `channel.openWritable(streamId)` →
  `WritableStream<Uint8Array>`, `channel.openDuplex(rxId, txId)` →
  `{ readable, writable }` (also exported as standalone `openReadable` /
  `openWritable` / `openDuplex`). The writable side chunks writes to the
  per-frame budget and backpressures on the channel send window; `close()` sends
  a final `eof` frame. Compression reuses the resource-layer bz2 injection
  (`link.bz2`, or an `options.bz2` override): the writer compresses a frame
  when it actually shrinks (segment-size search mirroring Python); the reader
  decompresses, erroring the stream if a compressed frame arrives with no bz2
  available.
- KISS stream framing (`src/transport/kiss-framer.js`): `createKissFramerStream`,
  `createKissUnframerStream`, `kissEscape`, `kissUnescape`, and `kissFrame`. The
  unframer is a byte-for-byte port of the Python reference
  `KISSInterface.readLoop` state machine — it strips the port nibble
  (`byte & 0x0F`) so any port's data frame maps to `CMD_DATA`, silently consumes
  non-data command frames, drops frames exceeding `maxMtu`, and resyncs on
  malformed escapes. Escape precedence is FESC-first, matching Python
  `KISS.escape`. Foundations for serial/RNode interfaces, and now selectable on
  TCP and WebSocket (see below).
- Optional KISS framing on `TCPClientInterface` / `TCPServerInterface`
  (`framing: "hdlc" | "kiss"`, default `"hdlc"`), mirroring the Python
  `kiss_framing = yes` TCP option. The server propagates the mode to spawned
  client interfaces.
- Optional KISS framing on `WebSocketClientInterface` /
  `WebSocketServerInterface` (`framing: "raw" | "kiss"`, default `"raw"`), for
  RNode firmware versions that expose a KISS-framed WebSocket link. In KISS mode
  each outbound packet is wrapped as `FEND | CMD_DATA | escaped | FEND` per
  binary message, and inbound message bytes are piped through the streaming KISS
  unframer so frames split across (or coalesced within) messages still parse.

### Changed
- Split the transport framer into two explicit modules. The former
  `src/transport/framer.js` (HDLC-only) is now `src/transport/hdlc-framer.js`,
  and its factories are renamed `createHdlcFramerStream` /
  `createHdlcUnframerStream` — the old `createRNSFramerStream` /
  `createRNSUnframerStream` names were a misnomer, since they were never "RNS
  framing". `hdlcEscape`/`hdlcUnescape` now use an `ESC_MASK` XOR instead of
  hardcoded `0x5e`/`0x5d` (bit-exact, clearer parity with Python's
  `HDLC.escape`). The unused `FramingMode` enum was removed. Consumers
  (`tcp.js`, `local_client.js`) updated; `LocalClientInterface` stays HDLC.

## [0.2.1] - 2026-07-18
### Added
- Shared-instance client support: a local Reticulum program can now attach to
  a running shared instance — a Python `rnsd` or (future) our own daemon — over
  the shared-instance loopback socket, sharing its interfaces instead of
  opening its own. Mirrors the client side of the Python reference
  `RNS.Interfaces.LocalInterface.LocalClientInterface` and
  `Reticulum.__start_local_interface`. `Reticulum.connectToSharedInstance()`
  auto-discovers the endpoint from `~/.reticulum/config`
  (`shared_instance_port`, `shared_instance_type`, `instance_name`) and connects
  over standard HDLC framing — byte-for-byte identical to TCP/RNode interfaces,
  so framing parity with the Python daemon is exact. Sets
  `isConnectedToSharedInstance` and returns the connected interface, or `null`
  if `share_instance = No` / nothing is reachable (the background reconnect is
  cancelled, no leak), so a caller can fall back to a standalone interface.
  Verified live against a running Python `rnsd`: outbound announces and inbound
  mesh announces flow through the daemon's interfaces.
- `LocalClientInterface` (`src/interfaces/local_client.js`): localhost-pinned
  HDLC-framed client, reusing the base `Interface` reconnect machinery and the
  shared framer streams, with an optional Unix domain socket / named pipe via
  `socketPath` for Linux abstract-AF_UNIX parity. Default `reconnectWait` 8s
  (Python `LocalClientInterface.RECONNECT_WAIT`). Registered as `local-client`.
  Doubles as the daemon-side per-connection wrapper (adopted `socket`, initiator
  `false`, never reconnects) for the future `LocalServerInterface`.
- Reticulum config discovery (`src/core/config.js`): `parseConfigFile`,
  `resolveConfigDir`, `loadConfig`, `getSharedInstanceEndpoint` read the
  Python `~/.reticulum/config` (configobj/INI format) with faithful value
  coercion (`as_bool`/`as_int`) and Python config-dir resolution. Scoped to the
  `[reticulum]` shared-instance fields for now; general interface synthesis is
  deferred.

### Changed
- All examples (`auto_interface`, `lxmf_echobot`, `lxmf_sender`,
  `nomadnet_fetch`) now prefer the local shared instance via
  `connectToSharedInstance()` and fall back to their previous standalone
  interface when no shared instance is reachable.

## [0.2.0] - 2026-07-18
### Added
- `AutoInterface`: zero-config IPv6-multicast local-network (LAN/Wi-Fi)
  peering, a port of the Python `RNS/Interfaces/AutoInterface.py`. Nodes on
  the same link discover each other via the group-derived multicast address
  and authenticated discovery token (`SHA-256(group || own_link_local)`),
  then exchange raw RNS packets (one per UDP datagram, no KISS framing) over a
  per-peer unicast data socket spawned as an `AutoInterfacePeer`. Implements
  the full peer lifecycle: announce loop, reverse-peering, peer expiry
  (`PEERING_TIMEOUT` 22s), link-local-address rebind, a multicast-echo carrier
  watchdog, and the multi-interface dedup deque. Node.js only; IPv6 link-local
  scope handling (`addr%ifname`) matches the Python receiver semantics.
  Registered as `auto`. IFAC and announce ingress/egress rate control are
  deferred (v1: IFAC disabled, rate control stubbed).
- Automatic reconnection for client interfaces (`TCPClientInterface`,
  `WebSocketClientInterface`): the initiator (outbound dialer) reconnects after
  a connection drop with a fixed backoff, indefinitely by default, matching the
  Python reference (`RECONNECT_WAIT`, `RECONNECT_MAX_TRIES`,
  `INITIAL_CONNECT_TIMEOUT`). Adopted/server-spawned sockets never reconnect.
  New options: `autoReconnect` (default `true`), `reconnectWait` (default `5`s),
  `maxReconnectTries` (default unlimited), `connectTimeout` (default `5`s),
  plus `i2pTunneled` on TCP for the longer I2P keepalive interval. The shared
  loop lives on the base `Interface`.
- New `reconnecting` event on client interfaces, fired before each reconnect
  attempt with detail `{ attempt, waitSeconds, maxTries }` for observability.
- TCP socket tuning on (re)connect: `TCP_NODELAY` and `SO_KEEPALIVE` via
  `setNoDelay` / `setKeepAlive`, mirroring the Python reference
  `TCP_PROBE_AFTER` (5s, or 10s when `i2pTunneled`). The granular Linux
  `TCP_USER_TIMEOUT` / `TCP_KEEPCNT` knobs are not reachable from Node's API.
- LXMF paper messaging: encrypt a message to an `lxm://` URI / QR code with
  `LXMessage.toPaperUri` (and `toPaperData`), and ingest it back with
  `LXMRouter.ingestUri` (or `LXMessage.fromPaperUri`). Byte-compatible with
  the Python LXMF reference.
- URL-safe base64 codec (`bytesToBase64Url` / `base64UrlToBytes`) in the
  encoding utilities.
- Standard (RFC 4648) base64 codec (`bytesToBase64` / `base64ToBytes`) in
  the encoding utilities, alongside the URL-safe variant. The decoder
  tolerates standard and URL-safe, padded and unpadded input.
- Interface configuration schemas: every interface exposes a static
  `getConfigurationSchema()` returning a JSON Schema (draft-07) describing its
  constructor options, for dynamically-generated setup UIs. The base
  `Interface` declares the common options (`name`, `ifacSize`); subclasses
  inherit and extend them. Defaults/examples include the standard rnsd port
  `4242`.
- Interface registry (`listInterfaces`, `getInterface`, `getSchema`,
  `registerInterface`) to enumerate available interfaces and their schemas.
- [HTTP POST exchange](https://github.com/jrl290/Reticulum-post/tree/main)
  client interface (`HttpPostClientInterface`): a pull-poll transport that
  exchanges batches of raw RNS packets over plain HTTP
  (`POST /v1/interfaces/register` + `POST /v1/interfaces/exchange`),
  base64-encoded in JSON with no HDLC framing. Non-canonical (no Python
  reference equivalent); wire-compatible with the third-party Reticulum-post
  router. Platform-neutral (WinterTC `fetch`), with an adaptive poll
  interval and automatic re-registration on auth failure. Registered as
  `http-client`.
- HTTP POST exchange server interface (`HttpPostServerInterface`): a Node.js
  replacement for the third-party Reticulum-post PHP router. Listens for
  inbound exchange clients and spawns a peer interface
  (`HttpPostPeerInterface`) per registered client via the `connection` event,
  mirroring `TCPServerInterface`. In-memory only: path state lives in
  `TransportCore` and per-peer queues live on each spawned peer, so the PHP
  router's SQLite complexity is shed entirely. Deliver-once semantics and a
  configurable idle-peer reaper. Registered as `http-server`.

### Fixed
- `LXMRouter.submitToPropagationNode` (and the large-message branch of
  `send`) now await the outgoing Resource transfer reaching COMPLETE before
  resolving. Previously they called `Resource.advertise()` and returned
  immediately, reporting success before any message bytes had crossed the
  wire — the propagation node only received the advertisement, never pulled
  the `lxmf_data` via `RESOURCE_REQ`, so the message was silently lost when
  the sender process wound down or the link dropped (and the recipient had
  nothing to sync). Direct/opportunistic delivery was unaffected because
  those paths send a single packet that completes inside the `await`. The
  new wait races the transfer against link closure and a 60s timeout, since
  the JS Resource has no sender-side watchdog yet.

### Changed
- Client interface event semantics: `closed` is now reserved for terminal
  states (deliberate `disconnect()`, reconnect exhaustion, or a non-initiator
  teardown). A transient drop now fires `disconnected` followed by
  `reconnecting` (and eventually `connected`) instead of `closed`. Set
  `autoReconnect: false` to restore the old one-shot "drop closes the
  interface" behaviour.

## [0.1.0] - 2026-07-14
### Added
- Now ships TypeScript type definitions

## [0.0.1] - 2026-07-14
### Added
- Initial version of reticulum-js
