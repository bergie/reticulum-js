/**
 * rfed FedSync engine (work doc #25, Phase 4) — peer tracking + sync scheduling.
 *
 * Mirrors the Rust `rfed::sync::FedSync` semantics: peers are learned from
 * `rfed.node` announces (`peerHeard`), pruned when stale, and surfaced as
 * due-for-sync by `tick()` with exponential backoff on failure. Static peers
 * are seeded so they are attempted immediately on startup (Rust
 * `seed_static_peers`), and `fromStaticOnly` restricts tracking to the
 * configured list (Rust `from_static_only`).
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { FedSync } from "../../src/rfed/fed_sync.js";
import { toHex } from "../../src/utils/encoding.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
/** Advances `Date.now()`-based clocks by faking the peer `lastHeard`/due math. */
const now = () => Date.now() / 1000;

describe("FedSync — peer tracking", () => {
  test("peerHeard tracks a peer and tick() returns it as due", () => {
    const sync = new FedSync();
    const peer = rnd(16);
    assert.strictEqual(sync.peerCount, 0);

    sync.peerHeard(peer);
    assert.strictEqual(sync.peerCount, 1);
    // A freshly-heard peer is alive and immediately due (nextSyncAttempt = now+5).
    assert.deepStrictEqual(sync.tick(), [peer]);
  });

  test("peerHeard ignores self-announces when localNodeHash is set", () => {
    const self = rnd(16);
    const sync = new FedSync({ localNodeHash: self });
    sync.peerHeard(self);
    assert.strictEqual(sync.peerCount, 0);
    assert.deepStrictEqual(sync.tick(), []);
  });

  test("fromStaticOnly ignores peers not in the configured static list", () => {
    const staticPeer = rnd(16);
    const other = rnd(16);
    const sync = new FedSync({
      staticPeers: [staticPeer],
      fromStaticOnly: true,
    });
    sync.peerHeard(other);
    assert.strictEqual(sync.peerCount, 0);

    sync.peerHeard(staticPeer);
    assert.strictEqual(sync.peerCount, 1);
    assert.deepStrictEqual(sync.tick(), [staticPeer]);
  });

  test("by default, all discovered peers are tracked even with static peers", () => {
    // Rust default: from_static_only = false → static peers are seeded, but
    // other announced peers are still tracked.
    const staticPeer = rnd(16);
    const discovered = rnd(16);
    const sync = new FedSync({ staticPeers: [staticPeer] });
    sync.peerHeard(discovered);
    assert.strictEqual(sync.peerCount, 1);
  });
});

describe("FedSync — backoff", () => {
  test("syncOk resets backoff and reschedules; tick() returns nothing until due", () => {
    const sync = new FedSync();
    const peer = rnd(16);
    sync.peerHeard(peer);
    // Consume the due peer.
    assert.deepStrictEqual(sync.tick(), [peer]);

    sync.syncStarted(peer);
    sync.syncOk(peer);
    // Just succeeded → not due again immediately.
    assert.deepStrictEqual(sync.tick(), []);
  });

  test("syncErr increases backoff so a failing peer is retried less often", () => {
    const sync = new FedSync({ pruneAgeSecs: 100000 });
    const peer = rnd(16);
    sync.peerHeard(peer);
    sync.tick(); // consume

    sync.syncStarted(peer);
    sync.syncErr(peer);
    // Backoff doubled to 20s → not due immediately.
    assert.deepStrictEqual(sync.tick(), []);

    // Force the peer due by rewinding nextSyncAttempt.
    const hex = toHex(peer);
    sync.peers.get(hex).nextSyncAttempt = now() - 1;
    assert.deepStrictEqual(sync.tick(), [peer]);
  });
});

describe("FedSync — static peer seeding", () => {
  test("seedStaticPeers makes configured peers immediately due + alive", () => {
    const a = rnd(16);
    const b = rnd(16);
    const sync = new FedSync({ staticPeers: [a, b] });
    assert.strictEqual(sync.peerCount, 0);

    sync.seedStaticPeers();
    assert.strictEqual(sync.peerCount, 2);
    const due = sync.tick().map(toHex).sort();
    assert.deepStrictEqual(due, [toHex(a), toHex(b)].sort());
  });

  test("static peers survive pruneStalePeers even when never heard from", () => {
    const a = rnd(16);
    const sync = new FedSync({
      staticPeers: [a],
      pruneAgeSecs: 0, // everything stale
    });
    sync.seedStaticPeers();
    // lastHeard = 0 → would be pruned if not static.
    sync.pruneStalePeers();
    assert.strictEqual(sync.peerCount, 1);
  });
});

describe("FedSync — pruning", () => {
  test("pruneStalePeers drops peers not heard from within pruneAgeSecs", () => {
    const sync = new FedSync({ pruneAgeSecs: 100 });
    const fresh = rnd(16);
    const stale = rnd(16);
    sync.peerHeard(fresh);
    sync.peerHeard(stale);
    // Force the stale peer into the past.
    sync.peers.get(toHex(stale)).lastHeard = now() - 1000;

    const pruned = sync.pruneStalePeers();
    assert.strictEqual(pruned, 1);
    assert.strictEqual(sync.peerCount, 1);
    assert.deepStrictEqual(sync.tick(), [fresh]);
  });
});
