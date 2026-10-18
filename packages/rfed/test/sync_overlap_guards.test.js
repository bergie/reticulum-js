/**
 * Overlap guards on the RFedNode driver ticks (pile-up regression).
 *
 * The runner drives `syncPeers()` / `tickBackupDelivery()` on intervals whose
 * callbacks discard the returned promise. A pass that legitimately outlives
 * one interval (a slow peer, a large gap, a wedged link) previously let the
 * next interval start a SECOND concurrent pass — syncing the same peer over
 * two links at once and piling up in-flight sessions. The guards make an
 * overlapping pass a no-op instead.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { RFedNode } from "../src/node.js";

function makeNode() {
  const identity = new Identity();
  return new RFedNode({
    identity,
    rns: { coreInstanceToken: undefined },
  });
}

test("syncPeers() skips overlapping passes", async () => {
  const node = makeNode();

  // One peer due for sync; its sync hangs until we release it.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let syncCalls = 0;
  node._getPeersDueForSync = () => [new Uint8Array(16)];
  node.syncWithPeer = async () => {
    syncCalls++;
    await gate;
    return 1;
  };

  const pass1 = node.syncPeers();
  const pass2 = await node.syncPeers();
  assert.strictEqual(pass2, 0, "the overlapping pass must skip and report 0");
  assert.strictEqual(syncCalls, 1, "only one sync may run");
  release();
  assert.strictEqual(await pass1, 1);

  // After the first pass finished, a new pass runs again.
  assert.strictEqual(await node.syncPeers(), 1);
  assert.strictEqual(syncCalls, 2);
});

test("syncPeers() clears its guard when the pass throws", async () => {
  const node = makeNode();
  node._getPeersDueForSync = () => {
    throw new Error("fedSync tick exploded");
  };

  await assert.rejects(() => node.syncPeers(), /fedSync tick exploded/);
  // The guard must not wedge: the next pass runs normally.
  node._getPeersDueForSync = () => [];
  assert.strictEqual(await node.syncPeers(), 0);
});

test("tickBackupDelivery() skips overlapping passes", async () => {
  const node = makeNode();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let pushCalls = 0;
  node._pendingBackupPushes.push([new Uint8Array(16), new Uint8Array(16)]);
  node._resolveBackup = () => new Uint8Array(16);
  node._pushSubscriptionsToBackup = async () => {
    pushCalls++;
    await gate;
    return true;
  };

  const pass1 = node.tickBackupDelivery();
  const pass2 = await node.tickBackupDelivery();
  assert.deepStrictEqual(
    pass2,
    { pushed: 0, pruned: 0, adopted: 0, repushed: 0 },
    "the overlapping pass must skip and report all-zero counts",
  );
  assert.strictEqual(pushCalls, 1, "only one backup push may run");
  release();
  const result1 = await pass1;
  assert.strictEqual(result1.pushed, 1);
  assert.strictEqual(pushCalls, 1);
});
