# Changelog

## [Unreleased]

## [0.4.0] - 2026-07-23
### Added
- New package (work doc #22): real `WebSocketServerInterface` backed by
  [ws](https://github.com/websockets/ws), replacing the stub removed from the
  [`@reticulum/core`](../core) core. Listens for inbound WebSocket
  connections and spawns a `WebSocketClientInterface` (from `@reticulum/core`) per
  accepted connection, mirroring `TCPServerInterface`. Not registered in the
  [`@reticulum/node`](../node) registry, to avoid forcing a
  `ws` dependency there. Depends on `@reticulum/core` and `ws`.
