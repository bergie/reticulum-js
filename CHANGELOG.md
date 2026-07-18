# Changelog
## [unreleased]
### Added
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
