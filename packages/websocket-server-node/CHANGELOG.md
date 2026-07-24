# Changelog

## [Unreleased]

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
- New package (work doc #22): real `WebSocketServerInterface` backed by
  [ws](https://github.com/websockets/ws), replacing the stub removed from the
  [`@reticulum/core`](../core) core. Listens for inbound WebSocket
  connections and spawns a `WebSocketClientInterface` (from `@reticulum/core`) per
  accepted connection, mirroring `TCPServerInterface`. Not registered in the
  [`@reticulum/node`](../node) registry, to avoid forcing a
  `ws` dependency there. Depends on `@reticulum/core` and `ws`.
