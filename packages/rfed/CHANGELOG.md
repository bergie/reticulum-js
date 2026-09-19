# Changelog

## [Unreleased]
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
