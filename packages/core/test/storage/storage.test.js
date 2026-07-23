/**
 * {@link MemoryStorageAdapter} — the reference in-memory backend for the
 * {@link StorageAdapter} contract (work doc #16).
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import {
  MemoryStorageAdapter,
  StorageNamespace,
} from "../../src/storage/storage.js";
import { fromHex } from "../../src/utils/encoding.js";

describe("MemoryStorageAdapter — identity key blob", () => {
  test("loadKey returns null when nothing was saved", async () => {
    const a = new MemoryStorageAdapter();
    assert.strictEqual(await a.loadKey(), null);
  });

  test("saveKey / loadKey round-trip the 128-byte private-key blob", async () => {
    const a = new MemoryStorageAdapter();
    const blob = fromHex("00".repeat(128));
    await a.saveKey(blob);
    const loaded = await a.loadKey();
    assert.deepStrictEqual(loaded, blob);
  });

  test("saveKey stores a copy (caller mutation does not corrupt the store)", async () => {
    const a = new MemoryStorageAdapter();
    const blob = fromHex("0102".repeat(64));
    await a.saveKey(blob);
    blob[0] = 0xff;
    const loaded = await a.loadKey();
    assert.strictEqual(
      loaded[0],
      1,
      "store must hold the bytes passed at save time",
    );
  });
});

describe("MemoryStorageAdapter — namespaced KV", () => {
  test("get returns null for an unknown namespace/key", async () => {
    const a = new MemoryStorageAdapter();
    assert.strictEqual(await a.get("identities", "deadbeef"), null);
  });

  test("set / get round-trip a record", async () => {
    const a = new MemoryStorageAdapter();
    const value = fromHex("cafe");
    await a.set(StorageNamespace.IDENTITIES, "aabb", value);
    assert.deepStrictEqual(
      await a.get(StorageNamespace.IDENTITIES, "aabb"),
      value,
    );
  });

  test("set overwrites an existing record", async () => {
    const a = new MemoryStorageAdapter();
    await a.set(StorageNamespace.RATCHETS, "k", fromHex("01"));
    await a.set(StorageNamespace.RATCHETS, "k", fromHex("02"));
    assert.deepStrictEqual(
      await a.get(StorageNamespace.RATCHETS, "k"),
      fromHex("02"),
    );
  });

  test("namespaces are independent", async () => {
    const a = new MemoryStorageAdapter();
    await a.set(StorageNamespace.IDENTITIES, "k", fromHex("01"));
    await a.set(StorageNamespace.PATHS, "k", fromHex("02"));
    assert.deepStrictEqual(
      await a.get(StorageNamespace.IDENTITIES, "k"),
      fromHex("01"),
    );
    assert.deepStrictEqual(
      await a.get(StorageNamespace.PATHS, "k"),
      fromHex("02"),
    );
  });

  test("keys lists records in a namespace", async () => {
    const a = new MemoryStorageAdapter();
    await a.set(StorageNamespace.IDENTITIES, "a", fromHex("00"));
    await a.set(StorageNamespace.IDENTITIES, "b", fromHex("00"));
    await a.set(StorageNamespace.RATCHETS, "c", fromHex("00"));
    const ids = (await a.keys(StorageNamespace.IDENTITIES)).sort();
    const ratchets = await a.keys(StorageNamespace.RATCHETS);
    assert.deepStrictEqual(ids, ["a", "b"]);
    assert.deepStrictEqual(ratchets, ["c"]);
  });

  test("keys for an empty namespace is []", async () => {
    const a = new MemoryStorageAdapter();
    assert.deepStrictEqual(await a.keys(StorageNamespace.PATHS), []);
  });

  test("delete removes a record", async () => {
    const a = new MemoryStorageAdapter();
    await a.set(StorageNamespace.IDENTITIES, "k", fromHex("01"));
    await a.delete(StorageNamespace.IDENTITIES, "k");
    assert.strictEqual(await a.get(StorageNamespace.IDENTITIES, "k"), null);
  });

  test("delete on an absent record is a no-op", async () => {
    const a = new MemoryStorageAdapter();
    await a.delete(StorageNamespace.IDENTITIES, "missing");
    assert.deepStrictEqual(await a.keys(StorageNamespace.IDENTITIES), []);
  });

  test("get returns a copy — mutating it does not corrupt the store", async () => {
    const a = new MemoryStorageAdapter();
    const value = fromHex("010203");
    await a.set(StorageNamespace.IDENTITIES, "k", value);
    const loaded = await a.get(StorageNamespace.IDENTITIES, "k");
    loaded[0] = 0xff;
    const again = await a.get(StorageNamespace.IDENTITIES, "k");
    assert.strictEqual(again[0], 1, "store must hand out independent copies");
  });
});
