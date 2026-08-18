/**
 * Tests for interface ingress burst control (Python `Interface`
 * `should_ingress_limit` / `should_ingress_limit_pr` — work doc #31).
 *
 * Constants and latch/hold semantics mirror the Python reference
 * (`RNS/Interfaces/Interface.py`): burst latches when the incoming
 * announce/PR frequency exceeds the age-dependent threshold, stays latched
 * for IC_BURST_HOLD seconds, and unlatches once the frequency drops back
 * below the threshold (the unlatching call still reports limited).
 */
import assert from "node:assert";
import test from "node:test";
import { Interface } from "../../src/interfaces/base.js";

/** Wall-clock seconds, matching the deque timebase. */
const nowSec = () => Date.now() / 1000;

/** Marks an interface as established (age > IC_NEW_TIME = 2 h). */
function agedInterface() {
  const iface = new Interface();
  iface.created = Date.now() - 3 * 60 * 60 * 1000;
  return iface;
}

test("frequencies need more than IC_DEQUE_MIN_SAMPLE samples", () => {
  const iface = new Interface();
  const now = nowSec();
  iface.iaFreqDeque = [now - 0.1, now]; // 2 samples — not enough (> 2 required)
  assert.strictEqual(iface.incomingAnnounceFrequency(), 0);
  assert.strictEqual(iface.shouldIngressLimit(), false);
});

test("an announce burst latches on an established interface above 10/s", () => {
  const iface = agedInterface();
  const now = nowSec();
  // 4 samples over ~0.15 s ≈ 26 Hz.
  iface.iaFreqDeque = [now - 0.15, now - 0.1, now - 0.05, now];
  assert.ok(iface.incomingAnnounceFrequency() > 10);
  assert.strictEqual(iface.shouldIngressLimit(), true);
  assert.strictEqual(iface.icBurstActive, true);
  // Burst activation arms the held-announce release penalty
  // (IC_BURST_HOLD + IC_BURST_PENALTY semantics live in Python's
  // should_ingress_limit; here we just record the arm time).
  assert.ok(iface.icHeldRelease > nowSec() + 14);
});

test("a moderate announce rate does not latch an established interface", () => {
  const iface = agedInterface();
  const now = nowSec();
  // 4 samples over ~1.2 s ≈ 3.3 Hz — below the established threshold (10).
  iface.iaFreqDeque = [now - 1.2, now - 0.8, now - 0.4, now];
  assert.strictEqual(iface.shouldIngressLimit(), false);
  assert.strictEqual(iface.icBurstActive, false);
});

test("new interfaces use the stricter 3/s announce threshold", () => {
  const iface = new Interface(); // just constructed — age < 2 h
  const now = nowSec();
  // ~3.3 Hz: no burst when established, burst when new.
  iface.iaFreqDeque = [now - 1.2, now - 0.8, now - 0.4, now];
  assert.strictEqual(iface.shouldIngressLimit(), true);
  assert.strictEqual(iface.icBurstFreqNew, 3);
});

test("a PR burst latches above 8/s and holds despite frequency dropping", () => {
  const iface = agedInterface();
  const now = nowSec();
  iface.ipFreqDeque = [now - 0.3, now - 0.2, now - 0.1, now]; // ≈ 13 Hz
  assert.strictEqual(iface.shouldIngressLimitPr(), true);
  assert.strictEqual(iface.icPrBurstActive, true);

  // Frequency collapses (samples decay), but IC_BURST_HOLD (15 s) hasn't
  // elapsed — still limiting.
  iface.ipFreqDeque = [nowSec() - 0.2];
  assert.strictEqual(iface.shouldIngressLimitPr(), true);
});

test("an announce burst unlatches after the hold once quiet", () => {
  const iface = agedInterface();
  iface.icBurstActive = true;
  iface.icBurstActivated = nowSec() - 20; // hold (15 s) elapsed
  const now = nowSec();
  iface.iaFreqDeque = [now - 5, now - 4]; // sparse: frequency reads 0

  // The unlatching call still reports limited (Python returns True after
  // clearing the flag); the next call flows normally.
  assert.strictEqual(iface.shouldIngressLimit(), true);
  assert.strictEqual(iface.icBurstActive, false);
  assert.strictEqual(iface.shouldIngressLimit(), false);
});

test("a PR burst unlatches after the hold once quiet, via the cooldown", () => {
  const iface = agedInterface();
  iface.icPrBurstActive = true;
  iface.icPrBurstActivated = nowSec() - 20; // hold (15 s) elapsed
  iface.icPrBurstCooldown = 3; // as a real latch would have set it
  iface.ipFreqDeque = []; // no samples at all (PR unlatch has no min-sample check)

  // Upstream cooldown hysteresis ("Improved PR ingress limiter"): after the
  // hold, unlatching takes IC_PR_BURST_COOLDOWN+1 consecutive quiet
  // evaluations; each quiet call still reports limited.
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(iface.shouldIngressLimitPr(), true);
    assert.strictEqual(iface.icPrBurstActive, true);
  }
  assert.strictEqual(
    iface.shouldIngressLimitPr(),
    true,
    "unlatch call reports limited",
  );
  assert.strictEqual(iface.icPrBurstActive, false);
  assert.strictEqual(iface.shouldIngressLimitPr(), false);
});

test("a busy evaluation resets the PR unlatch cooldown", () => {
  const iface = agedInterface();
  iface.icPrBurstActive = true;
  iface.icPrBurstActivated = nowSec() - 20; // hold elapsed
  iface.icPrBurstCooldown = 3;
  const now = nowSec();

  // Two quiet evaluations burn part of the cooldown...
  iface.ipFreqDeque = [];
  iface.shouldIngressLimitPr();
  iface.shouldIngressLimitPr();
  assert.strictEqual(iface.icPrBurstCooldown, 1);

  // ...then renewed activity (above the 8/s threshold) resets it to 3.
  iface.ipFreqDeque = [now - 0.2, now - 0.1, now];
  assert.strictEqual(iface.shouldIngressLimitPr(), true);
  assert.strictEqual(iface.icPrBurstCooldown, 3);

  // And unlatching needs the full 4 quiet evaluations again.
  iface.ipFreqDeque = [];
  iface.shouldIngressLimitPr();
  iface.shouldIngressLimitPr();
  iface.shouldIngressLimitPr();
  assert.strictEqual(iface.icPrBurstActive, true);
  assert.strictEqual(iface.shouldIngressLimitPr(), true);
  assert.strictEqual(iface.icPrBurstActive, false);
});

test("ingress control can be disabled per interface", () => {
  const iface = agedInterface();
  iface.ingressControl = false;
  const now = nowSec();
  iface.iaFreqDeque = [now - 0.01, now - 0.005, now]; // huge frequency
  iface.ipFreqDeque = [now - 0.01, now - 0.005, now];
  assert.strictEqual(iface.shouldIngressLimit(), false);
  assert.strictEqual(iface.shouldIngressLimitPr(), false);
});

test("samples older than the decay window drop out of the ring", () => {
  const iface = new Interface();
  const now = nowSec();
  // Decay only runs once a reading is possible (n > 2, as in Python — a lone
  // stale sample returns 0 before the popleft). With three samples the
  // 12-second-old one exceeds AR_FREQ_DECAY (10 s) and decays out.
  iface.iaFreqDeque = [now - 12, now - 0.1, now];
  assert.ok(iface.incomingAnnounceFrequency() > 0);
  assert.strictEqual(iface.iaFreqDeque.length, 2, "stale sample decayed");
  assert.ok(iface.iaFreqDeque[0] > now - 1);
});

test("received* trackers cap the rings at FREQ_SAMPLES and propagate to parents", () => {
  const parent = new Interface();
  const child = new Interface();
  /** @type {any} */ (child).parentInterface = parent;

  for (let i = 0; i < 60; i++) {
    child.receivedAnnounce();
    child.receivedPathRequest();
    child.sentPathRequest();
  }
  assert.strictEqual(child.iaFreqDeque.length, 48);
  assert.strictEqual(child.ipFreqDeque.length, 48);
  assert.strictEqual(child.opFreqDeque.length, 48);
  // Spawned interfaces propagate one sample per event to the parent medium.
  assert.strictEqual(parent.iaFreqDeque.length, 48);
  assert.strictEqual(parent.ipFreqDeque.length, 48);
  assert.strictEqual(parent.opFreqDeque.length, 48);
});

test("outgoing PR frequency needs more than one sample", () => {
  const iface = new Interface();
  iface.opFreqDeque = [nowSec()];
  assert.strictEqual(iface.outgoingPrFrequency(), 0);
  const now = nowSec();
  iface.opFreqDeque = [now - 0.2, now, now];
  assert.ok(iface.outgoingPrFrequency() > 1);
});
