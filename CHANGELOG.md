# Changelog
## [unreleased]
### Added
- LXMF paper messaging: encrypt a message to an `lxm://` URI / QR code with
  `LXMessage.toPaperUri` (and `toPaperData`), and ingest it back with
  `LXMRouter.ingestUri` (or `LXMessage.fromPaperUri`). Byte-compatible with
  the Python LXMF reference.
- URL-safe base64 codec (`bytesToBase64Url` / `base64UrlToBytes`) in the
  encoding utilities.

## [0.1.0] - 2026-07-14
### Added
- Now ships TypeScript type definitions

## [0.0.1] - 2026-07-14
### Added
- Initial version of reticulum-js
