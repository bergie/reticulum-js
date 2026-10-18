/**
 * Processed-transient-id TTL (dedup-map growth regression).
 *
 * `LXMRouter.processedTransientIds` remembers every synced/ingested message id
 * for dedup (matching the Python reference's `locally_processed_transient_ids`).
 * Without a TTL sweep the map grows without bound over a node's lifetime —
 * Python cleans it in its jobs loop after `MESSAGE_EXPIRY * 6`. The JS router
 * prunes on `tickMaintenance()` and lazily on the insert path.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { LXMRouter } from "../src/router.js";

async function makeRouter() {
  const identity = await Identity.generate();
  const core = new TransportCore();
  return new LXMRouter(identity, {
    transport: {
      rememberIdentity: core.rememberIdentity.bind(core),
      recallIdentity: core.recallIdentity.bind(core),
    },
    registerDestination() {},
  });
}

test("tickMaintenance() prunes aged processed transient ids", async () => {
  const router = await makeRouter();
  const now = Date.now() / 1000;
  const ttl = 30 * 24 * 60 * 60 * 6; // Python MESSAGE_EXPIRY * 6

  router.processedTransientIds.set("fresh", now - 10);
  router.processedTransientIds.set("aged", now - ttl - 10);
  router.processedTransientIds.set("aged2", now - ttl * 10);

  const { processed } = router.tickMaintenance();
  assert.strictEqual(processed, 2, "both aged entries must be pruned");
  assert.strictEqual(
    router.processedTransientIds.has("fresh"),
    true,
    "fresh entries must survive",
  );
  assert.equal(router.processedTransientIds.has("aged"), false);
  assert.equal(router.processedTransientIds.has("aged2"), false);
});

test("the insert path prunes lazily without a driver", async () => {
  const router = await makeRouter();
  const now = Date.now() / 1000;
  const ttl = 30 * 24 * 60 * 60 * 6;

  // Backdate the last prune so the next insert is due to sweep, then fill
  // the map with aged entries as a driver-less run would have accumulated.
  router._lastProcessedPrune = now - 301;
  router.processedTransientIds.set("ancient", now - ttl - 60);

  router._rememberProcessedTransientId("current");

  assert.equal(
    router.processedTransientIds.has("ancient"),
    false,
    "the lazy sweep on insert must drop expired entries",
  );
  assert.equal(router.processedTransientIds.has("current"), true);
  assert.ok(router._lastProcessedPrune >= now - 1, "prune timestamp advanced");
});

test("inserts within the prune interval do not sweep", async () => {
  const router = await makeRouter();
  const now = Date.now() / 1000;
  const ttl = 30 * 24 * 60 * 60 * 6;

  router._lastProcessedPrune = now - 10; // interval (300s) not elapsed
  router.processedTransientIds.set("aged", now - ttl - 60);

  router._rememberProcessedTransientId("current");
  assert.equal(
    router.processedTransientIds.has("aged"),
    true,
    "no sweep is due yet — the aged entry stays until the next sweep",
  );
});
