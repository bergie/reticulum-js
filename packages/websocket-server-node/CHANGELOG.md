# Changelog

## [Unreleased]
### Changed
- **Documented the `WebSocketServerInterfaceOptions` typedef**: added a leading
  description (it previously had only `@property` tags, which JSR does not count
  as documented). Local JSR-doc proxy now reports 100% symbol coverage.

## [0.6.1] - 2026-08-05

## [0.6.0] - 2026-08-05
### Added
- Optional TLS termination (`ssl: true` with `certFile`/`keyFile`), mirroring
  the Python reference `WebSocketServerInterface` `ssl`/`certfile`/`keyfile`
  config keys. When enabled the server wraps a Node.js `https.Server` (with the
  PEM certificate chain and private key) and hands it to `ws`, so clients
  connect over `wss://`. Needed for browser apps running in a secure context
  (HTTPS), which cannot open `ws://`. Constructor validation matches the Python
  reference: SSL requires both `certFile` and `keyFile`, and providing either
  without `ssl` is rejected. Verified interoperable in both directions with the
  Python reference over `wss://`.

## [0.5.3] - 2026-08-02

## [0.5.2] - 2026-08-01

## [0.5.1] - 2026-08-01

## [0.5.0] - 2026-07-31

## [0.4.5] - 2026-07-27

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
