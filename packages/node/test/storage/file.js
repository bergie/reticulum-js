/**
 * {@link FileStorageAdapter} — the Node.js reference `StorageAdapter`
 * (@reticulum/core work doc #16): identity key + per-namespace record files on
 * disk, plus an integration round-trip with `Persistor`.
 */
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Persistor, StorageNamespace } from "@reticulum/core";
import {
  bytesEqual,
  fromHex,
  toHex,
} from "@reticulum/core/src/utils/encoding.js";
import { FileStorageAdapter } from "../../src/storage/file.js";

/** Creates an isolated temp dir and returns it plus a cleanup fn. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "rjs-storage-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("FileStorageAdapter — identity key blob", () => {
  test("loadKey returns null when absent", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      assert.strictEqual(await a.loadKey(), null);
    } finally {
      cleanup();
    }
  });

  test("saveKey / loadKey round-trip the private-key blob at <dir>/identity.key", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      const blob = fromHex("00".repeat(128));
      await a.saveKey(blob);
      assert.ok(
        existsSync(join(dir, "identity.key")),
        "lives at <dir>/identity.key",
      );
      const loaded = await a.loadKey();
      assert.ok(loaded && bytesEqual(loaded, blob));
    } finally {
      cleanup();
    }
  });
});

describe("FileStorageAdapter — namespaced KV", () => {
  test("get returns null for an unknown namespace/key", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      assert.strictEqual(await a.get("identities", "aabb"), null);
    } finally {
      cleanup();
    }
  });

  test("set / get round-trip a record at <dir>/<namespace>/<key>.bin", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      const value = fromHex("cafe");
      await a.set(StorageNamespace.IDENTITIES, "aabb", value);
      assert.ok(
        existsSync(join(dir, "identities", "aabb.bin")),
        "record lives at the expected path",
      );
      const loaded = await a.get(StorageNamespace.IDENTITIES, "aabb");
      assert.ok(loaded && bytesEqual(loaded, value));
    } finally {
      cleanup();
    }
  });

  test("set overwrites an existing record", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      await a.set(StorageNamespace.RATCHETS, "k", fromHex("01"));
      await a.set(StorageNamespace.RATCHETS, "k", fromHex("02"));
      const loaded = await a.get(StorageNamespace.RATCHETS, "k");
      assert.ok(loaded && bytesEqual(loaded, fromHex("02")));
    } finally {
      cleanup();
    }
  });

  test("namespaces are independent directories", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      await a.set(StorageNamespace.IDENTITIES, "k", fromHex("01"));
      await a.set(StorageNamespace.PATHS, "k", fromHex("02"));
      const id = await a.get(StorageNamespace.IDENTITIES, "k");
      const path = await a.get(StorageNamespace.PATHS, "k");
      assert.ok(id && bytesEqual(id, fromHex("01")));
      assert.ok(path && bytesEqual(path, fromHex("02")));
    } finally {
      cleanup();
    }
  });

  test("keys lists records (stripping .bin), empty namespace is []", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      await a.set(StorageNamespace.IDENTITIES, "a", fromHex("00"));
      await a.set(StorageNamespace.IDENTITIES, "b", fromHex("00"));
      await a.set(StorageNamespace.RATCHETS, "c", fromHex("00"));

      const ids = (await a.keys(StorageNamespace.IDENTITIES)).sort();
      const ratchets = await a.keys(StorageNamespace.RATCHETS);
      const empty = await a.keys(StorageNamespace.PATHS);

      assert.deepStrictEqual(ids, ["a", "b"]);
      assert.deepStrictEqual(ratchets, ["c"]);
      assert.deepStrictEqual(empty, []);
    } finally {
      cleanup();
    }
  });

  test("delete removes a record; deleting an absent record is a no-op", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      await a.set(StorageNamespace.IDENTITIES, "k", fromHex("01"));
      await a.delete(StorageNamespace.IDENTITIES, "k");
      assert.strictEqual(await a.get(StorageNamespace.IDENTITIES, "k"), null);
      // No throw:
      await a.delete(StorageNamespace.IDENTITIES, "missing");
      await a.delete("absent-namespace", "missing");
    } finally {
      cleanup();
    }
  });

  test("a second adapter on the same directory recalls what the first wrote", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      await a.saveKey(fromHex("ab".repeat(64)));
      await a.set(StorageNamespace.IDENTITIES, "peer", fromHex("1234"));

      const b = new FileStorageAdapter(dir);
      const key = await b.loadKey();
      const rec = await b.get(StorageNamespace.IDENTITIES, "peer");
      assert.ok(key && bytesEqual(key, fromHex("ab".repeat(64))));
      assert.ok(rec && bytesEqual(rec, fromHex("1234")));
    } finally {
      cleanup();
    }
  });

  test("rejects path-traversing keys/namespaces", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const a = new FileStorageAdapter(dir);
      await assert.rejects(() =>
        a.set("identities", "../escape", fromHex("00")),
      );
      await assert.rejects(() => a.set("../escape", "k", fromHex("00")));
      await assert.rejects(() => a.keys("identities/.."));
    } finally {
      cleanup();
    }
  });
});

describe("FileStorageAdapter — Persistor integration", () => {
  test("a contacted identity survives a restart via Persistor", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const knownDestinations = new Map();
      const knownRatchets = new Map();

      // Instance 1: write a contacted peer.
      const p1 = new Persistor({
        adapter: new FileStorageAdapter(dir),
        knownDestinations,
        knownRatchets,
        debounceMs: 0,
      });
      const dest = fromHex("ee".repeat(16));
      const publicKey = fromHex("21".repeat(64));
      knownDestinations.set(toHex(dest), [
        Date.now() / 1000,
        fromHex("99".repeat(16)),
        publicKey,
        null,
        0,
      ]);
      p1.markContacted(dest);
      await p1.flush();

      // Instance 2: fresh maps, same directory → hydrate recalls the peer.
      const knownDestinations2 = new Map();
      const p2 = new Persistor({
        adapter: new FileStorageAdapter(dir),
        knownDestinations: knownDestinations2,
        knownRatchets: new Map(),
        debounceMs: 0,
      });
      await p2.load();

      const entry = knownDestinations2.get(toHex(dest));
      assert.ok(entry, "peer hydrated after restart");
      assert.ok(bytesEqual(entry[2], publicKey), "public key preserved");
      assert.ok(
        p2.persistedDestinations.has(toHex(dest)),
        "persisted set rebuilt",
      );
    } finally {
      cleanup();
    }
  });
});
