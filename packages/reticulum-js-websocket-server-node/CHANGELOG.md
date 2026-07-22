# Changelog

## [Unreleased]
### Added
- New package (work doc #22): real `WebSocketServerInterface` backed by
  [ws](https://github.com/websockets/ws), replacing the stub removed from the
  [`reticulum-js`](../reticulum-js) core. Listens for inbound WebSocket
  connections and spawns a `WebSocketClientInterface` (from `reticulum-js`) per
  accepted connection, mirroring `TCPServerInterface`. Not registered in the
  [`reticulum-js-node`](../reticulum-js-node) registry, to avoid forcing a
  `ws` dependency there. Depends on `reticulum-js` and `ws`.
