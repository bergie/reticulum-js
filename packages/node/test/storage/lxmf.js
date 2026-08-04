/**
 * LXMF propagation-node filesystem persistence (work doc #27) —
 * `loadLXMFStore`/`saveLXMFStore` round-trips the {@link MessageStore} through
 * the on-disk `propagation_messages.rmp` msgpack file, preserving entry bytes,
 * per-peer handled/unhandled sets, and the running byte total.
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { MessageStore } from "@reticulum/core/src/lxmf/message_store.js";
import { bytesEqual } from "@reticulum/core/src/utils/encoding.js";
import { loadLXMFStore, saveLXMFStore } from "../../src/storage/lxmf.js";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "rjs-lxmf-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

describe("LXMF message-store filesystem persistence", () => {
  test("empty dir loads a fresh store", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = await loadLXMFStore(dir);
      assert.strictEqual(store.size, 0);
      assert.strictEqual(store.totalBytes, 0);
    } finally {
      cleanup();
    }
  });

  test("round-trips entries + per-peer sets + byte total", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const dest = rnd(16);
      const peer = rnd(16);
      const orig = new MessageStore({ storageLimitBytes: 100000 });
      const e = {
        transientId: rnd(32),
        destinationHash: dest,
        lxmfData: rnd(40),
        stampData: rnd(32),
        received: 1234.5,
        stampValue: 7,
        size: 72,
      };
      orig.add(e);
      orig.markUnhandledForPeer(e.transientId, peer);

      await saveLXMFStore(dir, orig);

      const loaded = await loadLXMFStore(dir);
      assert.strictEqual(loaded.size, 1);
      assert.strictEqual(loaded.totalBytes, 72);
      const got = loaded.get(e.transientId);
      assert.ok(got);
      assert.ok(bytesEqual(got.lxmfData, e.lxmfData));
      assert.strictEqual(got.stampValue, 7);
      assert.strictEqual(got.received, 1234.5);
      assert.ok(got.unhandledPeers.has(toHexLocal(peer)));
      assert.ok(got.handledPeers instanceof Set);
    } finally {
      cleanup();
    }
  });

  test("loaded store honors configured limits", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const dest = rnd(16);
      const orig = new MessageStore();
      orig.add({
        transientId: rnd(32),
        destinationHash: dest,
        lxmfData: rnd(40),
        stampData: rnd(32),
        received: 0, // ancient
        stampValue: 0,
        size: 72,
      });
      await saveLXMFStore(dir, orig);

      // Load with a TTL that prunes the ancient entry.
      const loaded = await loadLXMFStore(dir, { messageTtlSecs: 60 });
      assert.strictEqual(loaded.size, 1); // prune is explicit, not on load
      const res = loaded.prune();
      assert.strictEqual(res.aged, 1);
      assert.strictEqual(loaded.size, 0);
    } finally {
      cleanup();
    }
  });
});

/** toHex without pulling the encoding export through the package root. */
function toHexLocal(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
