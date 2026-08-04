/**
 * rfed filesystem persistence (work doc #25) — `loadRFedStores`/`saveRFedStores`
 * round-trips the four in-memory stores (BlobStore, SubscriptionTable,
 * DeferredQueue, NotifyRegistry) through the on-disk layout
 * (`blobs/<ch_hex>/<id_hex>.bin` + the three `*.rmp` tables), preserving blob
 * `received` timestamps (via mtime) and subscriber identities (rebuilt from
 * their public keys).
 */
import assert from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Identity, toHex } from "@reticulum/core";
import {
  BlobStore,
  DeferredQueue,
  NotifyRegistry,
  SubscriptionTable,
} from "@reticulum/core/src/rfed/index.js";
import { bytesEqual } from "@reticulum/core/src/utils/encoding.js";
import { loadRFedStores, saveRFedStores } from "../../src/storage/rfed.js";

/** Creates an isolated temp dir and returns it plus a cleanup fn. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "rjs-rfed-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

describe("rfed FS persistence — round-trip", () => {
  test("empty store: load on a missing dir yields fresh stores", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const stores = await loadRFedStores(dir);
      assert.strictEqual(stores.blobStore.allMessageIds().length, 0);
      assert.strictEqual(stores.subscriptions.length, 0);
      assert.strictEqual(stores.deferred.totalLen(), 0);
      assert.strictEqual(stores.notify.count, 0);
    } finally {
      cleanup();
    }
  });

  test("save then load reproduces blobs, subscriptions, deferred, notify", async () => {
    const { dir, cleanup } = tempDir();
    try {
      // Build a populated store set.
      const chA = rnd(16);
      const chB = rnd(16);
      const blobStore = new BlobStore();
      const idA = blobStore.store(chA, rnd(64));
      const idB = blobStore.store(chB, rnd(64));

      const subscriptions = new SubscriptionTable();
      const subIdentity = await Identity.generate();
      await subscriptions.subscribe(subIdentity, chA);

      const deferred = new DeferredQueue();
      deferred.enqueue(subIdentity.identityHash, chA, rnd(32), 256);

      const notify = new NotifyRegistry();
      const relayHex = toHex(rnd(16));
      notify.register(subIdentity.identityHash, chA, relayHex);

      await saveRFedStores(dir, { blobStore, subscriptions, deferred, notify });

      // On-disk layout: blobs/<ch_hex>/<id_hex>.bin + three .rmp files.
      const blobsTree = readdirSync(join(dir, "blobs"));
      assert.ok(blobsTree.includes(toHex(chA)));
      assert.ok(blobsTree.includes(toHex(chB)));
      assert.ok(
        readdirSync(join(dir, "blobs", toHex(chA))).includes(
          `${toHex(idA)}.bin`,
        ),
      );
      for (const f of [
        "subscriptions.rmp",
        "deferred_delivery.rmp",
        "notify_registrations.rmp",
      ]) {
        assert.ok(readdirSync(dir).includes(f), `missing ${f}`);
      }

      // Load into fresh stores and compare.
      const loaded = await loadRFedStores(dir);
      assert.strictEqual(loaded.blobStore.allMessageIds().length, 2);
      assert.ok(
        bytesEqual(
          loaded.blobStore.get(idA) ?? new Uint8Array(),
          blobStore.get(idA),
        ),
      );
      assert.ok(
        bytesEqual(
          loaded.blobStore.get(idB) ?? new Uint8Array(),
          blobStore.get(idB),
        ),
      );

      // Channel attribution survived (metaFor).
      const meta = loaded.blobStore.metaFor(idA);
      assert.ok(meta && bytesEqual(meta.channelHash, chA));

      assert.strictEqual(loaded.subscriptions.length, 1);
      assert.ok(
        loaded.subscriptions.isSubscribed(subIdentity.identityHash, chA),
      );

      assert.strictEqual(loaded.deferred.totalLen(), 1);
      assert.ok(loaded.deferred.hasPending(subIdentity.identityHash));

      assert.strictEqual(loaded.notify.count, 1);
      assert.strictEqual(
        loaded.notify.getForSubscriber(subIdentity.identityHash, chA).length,
        1,
      );
    } finally {
      cleanup();
    }
  });

  test("subscription identity is rebuilt from its public key", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const ch = rnd(16);
      const subscriptions = new SubscriptionTable();
      const id = await Identity.generate();
      const entry = await subscriptions.subscribe(id, ch);

      await saveRFedStores(dir, {
        blobStore: new BlobStore(),
        subscriptions,
        deferred: new DeferredQueue(),
        notify: new NotifyRegistry(),
      });

      const loaded = await loadRFedStores(dir);
      const rebuilt = loaded.subscriptions.subscribersFor(ch)[0];
      assert.ok(rebuilt);
      // Same identity hash + delivery hash (rebuilt from the stored pubkey).
      assert.deepStrictEqual(
        toHex(rebuilt.subscriberHash),
        toHex(id.identityHash),
      );
      assert.deepStrictEqual(
        toHex(rebuilt.deliveryHash),
        toHex(entry.deliveryHash),
      );
    } finally {
      cleanup();
    }
  });

  test("save rewrites the blobs tree (stale blobs are removed)", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const ch = rnd(16);
      const bs1 = new BlobStore();
      const keep = bs1.store(ch, rnd(16));
      await saveRFedStores(dir, {
        blobStore: bs1,
        subscriptions: new SubscriptionTable(),
        deferred: new DeferredQueue(),
        notify: new NotifyRegistry(),
      });

      // Second save with a different store that omits `keep`.
      const bs2 = new BlobStore();
      bs2.store(ch, rnd(16));
      await saveRFedStores(dir, {
        blobStore: bs2,
        subscriptions: new SubscriptionTable(),
        deferred: new DeferredQueue(),
        notify: new NotifyRegistry(),
      });

      const loaded = await loadRFedStores(dir);
      assert.strictEqual(loaded.blobStore.allMessageIds().length, 1);
      assert.strictEqual(loaded.blobStore.get(keep), null); // stale, removed
    } finally {
      cleanup();
    }
  });
});
