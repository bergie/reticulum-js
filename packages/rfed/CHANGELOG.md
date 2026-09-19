# Changelog

## [Unreleased]

## [0.8.2] - 2026-09-19
### Changed
- `RFedNode`'s `/rfed/pull` handler now answers an unidentified caller with
  the bare msgpack integer `0xF0` (`ERROR_NO_IDENTITY`) and a malformed
  payload with `0xF4` (`ERROR_INVALID_DATA`), matching the reference rfed.
  Previously both returned an empty page `([], false)` — a client could not
  distinguish refusal from an empty deferred queue.
- `RFedClient.pull()` now throws on a numeric (≥ `0xF0`) node response
  instead of silently returning an empty result, so callers can re-identify
  on a fresh link.

### Added
- Link + Resource support for channel publishes, matching the reference
  node. `rfed.channel.publish` now accepts link requests: payloads at or
  under the link MDU (431 B) still arrive as a single fire-and-forget DATA
  packet, and anything larger is sent by `RFedClient` as a Resource over a
  link and ingested identically. Previously an oversized publish was
  fragmented into packets the node silently dropped.

## [0.8.1] - 2026-09-19

## [0.8.0] - 2026-09-19
### Added
- Initial release of `@reticulum/rfed` — rfed (Reticulum Federation) for
  reticulum-js, carved out of `@reticulum/core` (work doc #35). Same modules,
  same wire format, same public symbols as the former
  `@reticulum/core/src/rfed/` subpaths: `RFedNode`, `RFedClient`, `BlobStore`,
  `FedSync`, channel/stamp/notify/subscription helpers, and the
  `RFedConstants` namespace. Wire-compatible with the Rust `rfed` reference
  (protocol version 1).
- Depends on `@reticulum/lxmf` and `@reticulum/core`. Import from the package
  root: `import { RFedNode } from "@reticulum/rfed";`. The shared PoW stamp
  primitives now live in `@reticulum/core`'s `utils/stamper.js`.
