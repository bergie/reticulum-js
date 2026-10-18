# Changelog

## [Unreleased]

## [0.9.13] - 2026-10-18
### Fixed
- `LXMPeer.sync()` can no longer be re-entered mid-sync (Python `LXMPeer.sync` IDLE-gate parity): an overlapping driver pass — the sync interval firing while a stalled transfer is still pending — previously started a second link and a second full container against the same peer, piling up in-flight syncs. The gate covers the whole sync, and link establishment moved inside the guarded region so any failure resets the state machine instead of wedging the peer out of all future syncs.
- `LXMPeer.sync()` now bounds its outbound transfer wait at `RESOURCE_TRANSFER_TIMEOUT_MS` (default 60 s, overridable per peer via `transferTimeoutMs`). The JS Resource has no sender-side watchdog, so a stalled receiver on a keepalive-sustained link — pings answered, parts never pulled — previously hung the sync forever holding the container buffers and the link; the timeout unwinds it through the existing failure teardown.
- `LXMRouter.syncPeers()` skips overlapping passes: a pass that outlives its driver's interval no longer lets the next interval start a concurrent second pass over the same peers.
- `LXMRouter.processedTransientIds` (the sync-dedup map) is now TTL-pruned after 180 days (Python `MESSAGE_EXPIRY * 6` parity) via the new `LXMRouter.tickMaintenance()`, and the insert path prunes lazily at most every 5 minutes, so the map no longer grows without bound on long-running nodes even when no driver calls maintenance.
- Messages parked while their sender's identity is unknown are now parked in per-link buckets instead of one slot per link: several messages from the same not-yet-identified sender (or from distinct unknown senders, opportunistically) previously clobbered each other — only the last survived and was delivered on identify. Parked buckets are dropped when their link closes (LINKIDENTIFY can never arrive on a dead link; previously the parked wire buffers were pinned for the router's lifetime, one per dead link), and the total parked count is capped at the new exported `MAX_PARKED_MESSAGES` (128), dropping oldest first, so unknown-sender floods cannot pin memory.
- `PropagationNode.locallyProcessed` / `locallyDelivered` (the ingest-dedup caches) are now timestamped and TTL-pruned after 180 days (the same Python `MESSAGE_EXPIRY * 6` parity) via `tickMaintenance()` — which now also returns a `dedupPruned` count — and lazily on the ingest path, so the caches no longer grow without bound on long-running nodes.
- Propagation-node admission control, mirroring the Python reference's `offer_request` levers: `/offer` replies `ERROR_THROTTLED` (0xf6) when `maxInboundSyncs` (default 3, Python `MAX_INBOUND_SYNCS`) peer-sync transfers are already in flight, when another stamp batch is validating (`sequentialValidation`, lxmd default on), or when the peer is in the `throttledPeers` window (`stampThrottleSecs`, default 180, Python `PN_STAMP_THROTTLE` — applied when an inbound batch contains invalid stamps, which also tears its transfer down). `staticPeerHashes` bypass the gates, as Python's static peers do. This is the node-side counterpart to the transfer watchdog and window scaling: it bounds how much ingest work and buffer a busy node carries at once.
- The `/offer` want-list never re-wants a processed transient id: stored, locally delivered, and ingest-filter-dropped ids are all recorded in `locallyProcessed`, so a dropped mirror is not re-pulled on the next sync round — and not re-pulled in bulk when a peer re-peers after rotation or restart and offers its backlog afresh. (Previously only stored ids were excluded; locally delivered messages were re-pulled once per re-offer.)
- New `ingestFilter` option on the propagation node: an application hook deciding which **mirrored** blobs — offer-born peer-sync transfers — to store. The hook never sees direct submissions to the node: for those the node is the origin custodian and the only copy, so dropping one would silently destroy the sender's message (a black hole); the protocol's per-peer handled state is distribution bookkeeping, not garbage collection, so dropping a mirror only declines to mirror it. `ingestBlobs()` gained an `origin` parameter (`"peer-sync"` / `"submission"`) and reports a `dropped` count. This is the metered-connectivity lever: a boat's node can keep third-party submits (custody) while declining to mirror the mesh's third-party backlog (bytes).
- `LXMPeer.sync()` now honors the Python reference's client-side levers: a failing sync attempt arms a cumulative backoff (`SYNC_BACKOFF_STEP_SECS`, 12 min — the next attempt is postponed; a link that reaches ready resets it), and an `ERROR_THROTTLED` offer response postpones the next sync by `PN_STAMP_THROTTLE_SECS` (180 s) without marking the offered messages handled. Before this, a failing or throttled peer was re-synced on every pass, hammering the peer and re-pinning transfer buffers.
- Peer-table promiscuity caps (Python lxmd parity) — an uncapped autopeering node peers with every discovered node and keeps them forever, so N peers × per-sync transfer footprints pile up even with no memory leak: the peer table is capped at `MAX_PEERS` (20, overridable via `enableAutopeer(maxPeeringCost, { maxPeers })`), `rotatePeers()` (run from `syncPeers()`) drops the least-useful peers — unreachable first, then lowest acceptance rate below `ROTATION_AR_MAX` — to restore `ROTATION_HEADROOM_PCT` (10%) headroom, static peers (`staticPeers` option) are exempt, peers not heard from for 14 days (`PEER_MAX_UNREACHABLE_SECS`, Python `LXMPeer.MAX_UNREACHABLE`) are unpeered by `syncPeers()`, and autopeering only considers announces within `AUTOPEER_MAXDEPTH` (4) hops.
- Admission-control peers are now keyed by the peer's derived `lxmf.propagation` destination hash (Python's `remote_hash`) instead of the identity hash — this is the form operators configure `staticPeerHashes` in, so the bypass actually matches real static-peer configuration.

## [0.9.12] - 2026-10-17

## [0.9.11] - 2026-10-17
### Fixed
- `LXMPeer.sync()` now tears its link down when anything after link establishment fails (identify error, failed `/offer` request, transfer failure). Previously every failed sync leaked a zombie ACTIVE link whose watchdog later stale-tore it down — the trigger that turned a `@reticulum/core` pending-REQUEST orphan into an unhandled-rejection process crash during propagation peer syncs.

## [0.9.10] - 2026-10-17
### Fixed
- The link backchannel `data` listener attached by `lxmrouter._attachlinkmessagelisteners` now catches processing failures instead of leaking them as unhandled rejections (which crash the process under node's default `--unhandled-rejections=throw`). `dispatchevent` discards listener promises, so a throwing `_processincomingmessage` (malformed payload, storage failure) previously killed the process; the delivery-destination listener already had this guard.

## [0.9.9] - 2026-10-16
### Added

- `LXMRouter` accepts an optional third `options` argument with `options.stampEngine`: a pluggable proof-of-work stamp engine (work doc #45) installed process-wide via core's `setStamper`, replacing the WebCrypto default for every stamp operation (message stamp generation, propagation blob validation, peering). Omitting it keeps the browser-safe default; `@reticulum/node` ships a fast ready-made engine (`nodeStamper`) for Node.js consumers.

### Fixed

- Inbound link handlers pass the `link_request` event's `receivingInterface` to `acceptLink`, pinning each accepted link's return path to its arrival interface (work doc #43).

## [0.9.8] - 2026-10-10

## [0.9.7] - 2026-10-05
### Fixed
- Router-initiated links now carry the compression provider (`link.bz2`), so compressed inbound Resources on them can be assembled (Reticulum PROTOCOL-SPEC.md §10.2). The Python reference compresses Resource transfers by default (`RNS.Resource(auto_compress=True)`), so without this a sync from a Python propagation node failed with "Resource is compressed but no bz2 module was provided". Covered: the outbound propagation link used by `submitToPropagationNode` / `syncFromPropagationNode` (the /get responses and acks), DIRECT delivery links (a peer may send large LXMF messages back over the link we initiated), and `LXMPeer` peer-sync links (Python `LXMPeer` responses default to auto-compress). Links stay uncompressed when no provider is configured. Outgoing `LXMPeer` transfer Resources now pass the provider as well, matching the Python reference's default auto-compress — a transfer is only flagged compressed when compression actually shrinks the data, so peers without a provider are unaffected.

## [0.9.6] - 2026-10-04

## [0.9.5] - 2026-10-04

## [0.9.4] - 2026-10-03
### Fixed
- Peer-mesh distribution is now wired into the propagation node itself via a
  new `onStored` hook (`PropagationNodeOptions`), so messages stored through
  *any* ingest path — link Resources, in-process embedded-node submits, paper
  ingestion — are queued for distribution to peered propagation nodes.
  Previously only the link-Resource path distributed, so embedded-node
  submissions that bypassed the link (as Signal K's in-process deliverer does)
  sat in the store forever and were never offered to peers. Verified
  interoperable against a Python LXMF propagation node (LXMF 1.0.1):
  Signal K-style embedded submit → JS node peer sync → Python node → Python
  client delivery.
- Newly established propagation-node peerings now get a retroactive backlog
  catch-up: all currently stored messages are marked unhandled for the new
  peer so they are offered on the next sync pass. Over-offering is safe — the
  peer only requests what it lacks via `/offer` — and this lets a node that
  stored messages before any peer existed (or before an upgrade) converge with
  peers it acquires later.
- The propagation node now refuses an inbound propagation Resource whose data
  exceeds the per-sync limit it announces (`perSyncLimitKb` × 1000 B), as
  `LXMRouter.propagation_resource_advertised` does in LXMF 1.1.1 (rfed upstream
  5fd1fd8 brought its node in line with the reference). The cap is applied at
  advertisement time via the link's Resource size cap, so an oversized transfer
  never starts; previously every advertised Resource was accepted and ingested
  regardless of size. A failed propagation submit now also tears down the cached
  propagation link so the next submit opens a fresh one.

## [0.9.3] - 2026-10-03
### Added
- `LXMRouter.prototype.send(message, senderIdentity, options)` (work doc #39): supports an options bag `{ linkId, fallback = "opportunistic", solicit = true, timeoutMs }` with automated fallback escalation (DIRECT link -> opportunistic -> propagation store-and-forward) and identity solicitation via `recallOrSolicitIdentity`. Existing calls passing a bare `linkId` as 3rd parameter remain supported for backwards compatibility.
- `Message` guarantees stable `timestamp` and `messageId` across repeated `serialize()` calls and delivery retries on the same instance, ensuring wire-level deduplication across retries.

## [0.9.2] - 2026-09-27
### Fixed
- `LXMRouter.send()` no longer leaks inbound `data`/`resource` listeners on a
  reused cached DIRECT delivery link. The backchannel listeners
  (`_attachLinkMessageListeners`) were re-attached on every send to a cached
  link, growing the listener set until Node's EventTarget emitted
  `MaxListenersExceededWarning` (11 `data` listeners) and re-dispatching each
  inbound message once per attached copy. Listeners are now attached once per
  link and tracked in an `attachedLinks` set alongside the existing
  `identifiedLinks`/`directLinks` caches, and evicted when the link closes.

## [0.9.1] - 2026-09-27

## [0.9.0] - 2026-09-21
### Changed
- Cache access is now instance-scoped (work doc #37): the router and peers
  recall and remember identities/ratchets via `rns.transport` instead of the
  deprecated `Destination` class statics, so a fragmented install (two
  physical copies of `@reticulum/core` in one process) shares one state
  through the `Reticulum` instance. The router also warns at construction
  (`warnIfFragmented`) when it was bundled against a different physical copy
  of core than the provided `Reticulum` instance.

## [0.8.2] - 2026-09-19

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
