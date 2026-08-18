/**
 * Tests for node-global ingress-control config (work doc #31): the
 * `ingressControl` block on the `Reticulum` constructor config is applied to
 * every interface at `addInterface` time, mirroring the Python reference's
 * `[reticulum]`-section `ic_*` options that every interface reads via
 * `_default_ic_*()` getters (no per-interface form exists there).
 */
import assert from "node:assert";
import test from "node:test";
import { Reticulum } from "../../src/core/reticulum.js";
import { Interface } from "../../src/interfaces/base.js";

/** A minimal concrete interface: the abstract stream getters shadowed off. */
class StubInterface extends Interface {
  readable = null;
  writable = null;
}

test("applyIngressConfig assigns only provided keys", () => {
  const iface = new Interface();
  iface.applyIngressConfig({ icBurstFreq: 42, icPrBurstFreqNew: 1.5 });
  assert.strictEqual(iface.icBurstFreq, 42);
  assert.strictEqual(iface.icPrBurstFreqNew, 1.5);
  // Absent keys keep the class constants.
  assert.strictEqual(iface.icBurstFreqNew, Interface.IC_BURST_FREQ_NEW);
  assert.strictEqual(iface.icBurstHold, Interface.IC_BURST_HOLD);
  assert.strictEqual(iface.icPrBurstFreq, Interface.IC_PR_BURST_FREQ);
});

test("addInterface applies the node-global ingress config to interfaces", () => {
  const rns = new Reticulum({
    ingressControl: { icBurstFreq: 25, icBurstHold: 30, icNewTime: 60 },
  });
  const iface = new StubInterface();
  rns.addInterface(iface);

  assert.strictEqual(iface.icBurstFreq, 25);
  assert.strictEqual(iface.icBurstHold, 30);
  assert.strictEqual(iface.icNewTime, 60);
  // Untouched keys keep defaults; the programmatic opt-out still works.
  assert.strictEqual(iface.icPrBurstFreq, Interface.IC_PR_BURST_FREQ);
  iface.ingressControl = false;
  assert.strictEqual(iface.shouldIngressLimitPr(), false);
});

test("interfaces without a config block keep the Python defaults", () => {
  const rns = new Reticulum();
  const iface = new StubInterface();
  rns.addInterface(iface);
  assert.strictEqual(iface.icBurstFreq, Interface.IC_BURST_FREQ);
  assert.strictEqual(iface.icPrBurstFreq, Interface.IC_PR_BURST_FREQ);
});
