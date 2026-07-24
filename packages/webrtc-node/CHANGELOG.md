# Changelog

## [Unreleased]
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
