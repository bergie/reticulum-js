# Changelog

## [Unreleased]

## [0.4.0] - 2026-07-23
### Added
- New package (work doc #22): supplies the `createPeerConnection` factory
  backed by [werift](https://github.com/shinyoshiaki/werift) that the core's
  `WebRTCSignaling` ([`@reticulum/core`](../core)) expects via dependency
  injection, closing the WebRTC transport loop on Node (Node has no native
  `RTCPeerConnection`). Re-exports werift's `RTCPeerConnection`. Depends on
  `@reticulum/core` and `werift`.
