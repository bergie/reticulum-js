# Changelog

## [Unreleased]
### Changed
- **Documented the re-exported `RTCPeerConnection`**: added a doc comment on the
  `export { RTCPeerConnection }` statement describing the package's intent. The
  symbol's declaration lives in `werift`, so `deno doc`/JSR read werift's own
  doc for the type (this local comment documents intent rather than moving the
  package's 50% symbol-doc figure, which is structural to the single external
  re-export).

## [0.6.1] - 2026-08-05

## [0.6.0] - 2026-08-05

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
- New package (work doc #22): supplies the `createPeerConnection` factory
  backed by [werift](https://github.com/shinyoshiaki/werift) that the core's
  `WebRTCSignaling` ([`@reticulum/core`](../core)) expects via dependency
  injection, closing the WebRTC transport loop on Node (Node has no native
  `RTCPeerConnection`). Re-exports werift's `RTCPeerConnection`. Depends on
  `@reticulum/core` and `werift`.
