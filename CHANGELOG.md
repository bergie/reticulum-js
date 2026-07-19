# Changelog
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
