/**
 * Propagation-node dedup-cache TTL (growth regression).
 *
 * `PropagationNode.locallyProcessed` / `locallyDelivered` remember every
 * ingested transient id so a re-submitted blob is not re-processed. Without a
 * TTL sweep the caches grow without bound over a node's lifetime; they are
 * pruned after PROCESSED_TID_TTL_SECS (Python `MESSAGE_EXPIRY * 6` parity)
 * via `tickMaintenance()` and lazily on the ingest path.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { toHex } from "@reticulum/core/src/index.js";
import { PROCESSED_TID_TTL_SECS } from "../src/constants.js";
import { PropagationNode } from "../src/propagation_node.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/** A blob over the minimum size with a cost-0 stamp (32 zero bytes). */
function blob(seed) {
  const lxmf = rnd(160);
  lxmf[0] = seed;
  const stamped = new Uint8Array(lxmf.length + 32);
  stamped.set(lxmf, 0);
  return stamped;
}

describe("propagation dedup cache TTL", () => {
  test("tickMaintenance prunes aged dedup entries, keeps fresh ones", async () => {
    const pn = new PropagationNode({ stampCost: 0 });
    const now = Date.now() / 1000;

    const fresh = "aa";
    const aged = "bb";
    pn.locallyProcessed.set(fresh, now - 10);
    pn.locallyProcessed.set(aged, now - PROCESSED_TID_TTL_SECS - 1);
    pn.locallyDelivered.set("cc", now - PROCESSED_TID_TTL_SECS - 60);

    const { aged: agedStore, dedupPruned } = pn.tickMaintenance();
    assert.equal(agedStore, 0, "store prune is separate");
    assert.equal(dedupPruned, 2, "both aged entries must be pruned");
    assert.equal(pn.locallyProcessed.has(fresh), true);
    assert.equal(pn.locallyProcessed.has(aged), false);
    assert.equal(pn.locallyDelivered.size, 0);
  });

  test("ingest prunes lazily without a maintenance driver", async () => {
    const pn = new PropagationNode({ stampCost: 0 });
    const now = Date.now() / 1000;

    // A previously ingested entry has aged past the TTL, and no driver has
    // ever run maintenance.
    const stamped = blob(1);
    const tidHex = toHex(
      await Identity.fullHash(stamped.subarray(0, stamped.length - 32)),
    );
    pn.locallyProcessed.set(tidHex, now - PROCESSED_TID_TTL_SECS - 1);
    pn._lastDedupPrune = now - 301; // lazy sweep due

    // Ingesting a new blob sweeps the aged entry out inline.
    const res = await pn.ingestBlobs([blob(2)]);
    assert.equal(res.stored, 1);
    assert.equal(
      pn.locallyProcessed.has(tidHex),
      false,
      "the lazy sweep on ingest must drop the expired entry",
    );
    assert.equal(pn.locallyProcessed.size, 1, "only the fresh entry remains");
  });

  test("dedup still works within the TTL (no re-store)", async () => {
    const pn = new PropagationNode({ stampCost: 0 });
    const stamped = blob(3);

    const first = await pn.ingestBlobs([stamped]);
    const second = await pn.ingestBlobs([stamped]);
    assert.equal(first.stored, 1);
    assert.equal(
      second.stored,
      0,
      "a duplicate within the TTL must not be re-processed or re-stored",
    );
  });
});
