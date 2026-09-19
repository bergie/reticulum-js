# Changelog

## [Unreleased]

## [0.8.1] - 2026-09-19

## [0.8.0] - 2026-09-19
### Added
- Initial release of `@reticulum/lxmf` — LXMF (Lightweight Extensible Message
  Format) messaging for reticulum-js, carved out of `@reticulum/core` (work
  doc #35). Same modules, same wire format, same public symbols as the former
  `@reticulum/core/src/lxmf/` subpaths: `LXMRouter`, `LXMessage`,
  `MessageStore`, `PropagationNode`, `LXMPeer`, paper messaging, announce-data
  helpers, and the `LXStamper` namespace.
- Depends on `@reticulum/core`. Import from the package root:
  `import { LXMRouter, LXMessage } from "@reticulum/lxmf";`
  The generic PoW stamp primitives now live in
  `@reticulum/core`'s `utils/stamper.js`; the LXMF-specific validators
  (peering keys, propagation-node stamps) stay here.

### Fixed
- **The same inbound message is now dispatched exactly once, no matter how many paths deliver it (Python `LXMRouter.lxmf_delivery`'s `has_message` check).** A sender retry, or the same message arriving over a link *and* again as an opportunistic packet *and* once more via a propagation-node sync (Sideband's auto outbox stores a copy whenever the direct delivery proof is lost or slow), dispatched a `message` event per arrival — so every handler ran N times and a single command produced several identical replies. Matching the Python reference (`locally_delivered_transient_ids` keyed by `LXMessage.hash` before the delivery callback fires, `has_message` to query it), `_dispatchMessage` — the single chokepoint behind link, opportunistic, propagation-sync, embedded-node local-delivery and paper-URI ingestion — now drops any message whose id was already delivered, recording each delivered id in a bounded in-memory cache (`locallyDeliveredMessageIds`, oldest-evicted past 4096 entries; Python persists its equivalent and prunes it after `MESSAGE_EXPIRY * 6` in the jobs loop). The new public `hasMessage(messageId)` mirrors Python `has_message`. Because propagation-node clients deduplicate inbound by message hash, a duplicate copy is still acked to the node so it is purged (`syncFromPropagationNode` counts it under `duplicates`, marks the transient id processed and includes it in the ack list — Python `message_get_response` acks every fetched message, duplicates included, and records `locally_processed` before attempting delivery). The transport still emits the opportunistic PROOF on decrypt before the dedup check, exactly like Python `delivery_packet`, so a retrying sender still sees its proof and stops retransmitting. Covered by `test/dedup.test.js`: a repeated link delivery dispatches once, a link + opportunistic cross-path pair dispatches once, distinct messages dispatch separately, and a synced copy of an already-delivered message is not re-dispatched but is acked and counted as a duplicate
