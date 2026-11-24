/**
 * Event-loop liveness for RNS 1.6.0 announce stamp mining (regression test).
 *
 * `Destination.ensureStamp` used to mine announce stamps through the
 * single-core reference miner whose per-trial hashing dispatches to the
 * synchronous `node:crypto` primitives — a continuous event-loop block for
 * the whole search (~minutes at the rollout target 25.0, measured at 248 s
 * in a Signal K plugin CI run). Mining now dispatches through the engine
 * seam, so with `useNodeStamper()` installed the search runs in the stamp
 * worker thread and a `setInterval` heartbeat keeps firing throughout.
 *
 * @module test/core/announce-stamp-liveness.test
 */

import assert from "node:assert";
import { test } from "node:test";
import { Destination } from "@reticulum/core/src/core/destination.js";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { DestType } from "@reticulum/core/src/core/packet.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { setStamper } from "@reticulum/core/src/utils/stamper.js";
import {
  stampWorkerRunning,
  stopNodeStamper,
  useNodeStamper,
} from "../../src/utils/stamper.js";

test("announce stamp mining keeps the host event loop responsive", {
  timeout: 20000,
}, async () => {
  useNodeStamper();
  const identity = await Identity.generate();
  /** @type {any[]} */
  const captured = [];
  const fakeLayer = { broadcast: (pkt) => captured.push(pkt) };
  const dest = await Destination.IN(
    "liveness",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (fakeLayer),
  );

  // Pin a target cheap enough for CI but long enough that a starved event
  // loop would be detectable (2^20 ≈ 1M trials takes ≫ 100 ms even on a
  // fast host; the elapsed escape hatch keeps ultra-fast hosts honest).
  const originalValue = TransportCore.DESTINATION_VALUE;
  const originalCost = TransportCore.DESTINATION_COST;
  TransportCore.DESTINATION_VALUE = 20.0;
  TransportCore.DESTINATION_COST = 19.5;
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
  }, 100);
  try {
    dest.setStampValue(20.0);
    const started = Date.now();
    await dest.announce();
    const elapsed = Date.now() - started;

    assert.strictEqual(captured.length, 1, "announce went on air");
    assert.ok(
      stampWorkerRunning(),
      "mining must run in the stamp worker thread",
    );
    assert.ok(
      ticks >= 1 || elapsed < 150,
      `event loop starved during mining: ${ticks} heartbeats in ${elapsed} ms`,
    );
  } finally {
    clearInterval(heartbeat);
    setStamper(null);
    await stopNodeStamper();
    TransportCore.DESTINATION_VALUE = originalValue;
    TransportCore.DESTINATION_COST = originalCost;
  }
});
