# Changelog

## [Unreleased]
### Added
- New package (work doc #22): supplies the `createPeerConnection` factory
  backed by [werift](https://github.com/shinyoshiaki/werift) that the core's
  `WebRTCSignaling` ([`reticulum-js`](../reticulum-js)) expects via dependency
  injection, closing the WebRTC transport loop on Node (Node has no native
  `RTCPeerConnection`). Re-exports werift's `RTCPeerConnection`. Depends on
  `reticulum-js` and `werift`.
