/**
 * {@link Persistor} — the selective persistence coordinator (work doc #16).
 *
 * Verifies the two inclusion paths (implicit `markContacted` from the transport
 * layer; explicit `store` for favorited contacts), that only persisted
 * destinations are written, the msgpack round-trip for identities / ratchets /
 * paths, hydrate-on-startup, the debounce, and graceful no-op when disabled.
 *
 * Tests inject their own maps so `Destination` static state is never polluted.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import { Persistor } from "../../src/storage/persistor.js";
import {
  MemoryStorageAdapter,
  StorageNamespace,
} from "../../src/storage/storage.js";
import { bytesEqual, fromHex, toHex } from "../../src/utils/encoding.js";

/** Fresh per-test persistence surface: isolated maps + memory adapter. */
function freshSurface() {
  return {
    adapter: new MemoryStorageAdapter(),
    knownDestinations: new Map(),
    knownRatchets: new Map(),
    routingTable: { routes: new Map() },
  };
}

/** Builds an in-memory known_destinations entry tuple (Python layout). */
function identityEntry(packetHash, publicKey, appData = null) {
  return [Date.now() / 1000, packetHash, publicKey, appData, 0];
}

describe("Persistor — enabled detection", () => {
  test("disabled when adapter is null", () => {
    const p = new Persistor({ ...freshSurface(), adapter: null });
    assert.strictEqual(p.enabled, false);
  });

  test("disabled when adapter lacks the KV methods", () => {
    const p = new Persistor({
      adapter: { loadKey() {}, saveKey() {} }, // legacy identity-only adapter
    });
    assert.strictEqual(p.enabled, false);
  });

  test("enabled for a full StorageAdapter", () => {
    const p = new Persistor({ adapter: new MemoryStorageAdapter() });
    assert.strictEqual(p.enabled, true);
  });
});

describe("Persistor — communicate-with gating", () => {
  test("markContacted + flush writes only the contacted identity", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 0 });
    const contacted = fromHex("aabbccddeeff00112233445566778899");
    const overheard = fromHex("00112233445566778899aabbccddeeff");

    s.knownDestinations.set(
      toHex(contacted),
      identityEntry(fromHex("11"), fromHex("22".repeat(64))),
    );
    s.knownDestinations.set(
      toHex(overheard),
      identityEntry(fromHex("33"), fromHex("44".repeat(64))),
    );

    p.markContacted(contacted);
    await p.flush();

    const keys = await s.adapter.keys(StorageNamespace.IDENTITIES);
    assert.deepStrictEqual(keys, [toHex(contacted)]);
    assert.ok(
      !keys.includes(toHex(overheard)),
      "an overheard-but-uncontacted peer must not be persisted",
    );
  });

  test("markContacted accepts a hex string too", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 0 });
    const hex = "aabbccddeeff00112233445566778899";
    s.knownDestinations.set(
      hex,
      identityEntry(fromHex("11"), fromHex("22".repeat(64))),
    );

    p.markContacted(hex);
    await p.flush();

    assert.deepStrictEqual(await s.adapter.keys(StorageNamespace.IDENTITIES), [
      hex,
    ]);
  });

  test("ratchet ring round-trips for a contacted destination", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 0 });
    const dest = fromHex("aa".repeat(16));
    const ring = [fromHex("01".repeat(32)), fromHex("02".repeat(32))];

    s.knownRatchets.set(toHex(dest), ring);
    p.markContacted(dest);
    await p.flush();

    const persisted = await s.adapter.get(
      StorageNamespace.RATCHETS,
      toHex(dest),
    );
    assert.ok(persisted, "ratchet ring should be persisted");
    const decoded = p.knownRatchets; // not decoded yet — load() does that
    assert.ok(decoded, "sanity");

    // Reload into fresh maps and confirm equality.
    const s2 = freshSurface();
    const p2 = new Persistor({ ...s2, adapter: s.adapter, debounceMs: 0 });
    await p2.load();
    const reloaded = s2.knownRatchets.get(toHex(dest));
    assert.ok(reloaded);
    assert.strictEqual(reloaded.length, 2);
    assert.ok(bytesEqual(reloaded[0], ring[0]));
    assert.ok(bytesEqual(reloaded[1], ring[1]));
  });

  test("path entry round-trips; the live interface reference is dropped", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 0 });
    const dest = fromHex("bb".repeat(16));
    const iface = { name: "tcp0" };
    const route = {
      interface: iface,
      nextHop: fromHex("cc".repeat(16)),
      hops: 2,
      timestamp: 1700000000000,
      expires: 1700000060000,
      randomBlobs: [fromHex("00112233445566778899")],
    };
    s.routingTable.routes.set(toHex(dest), route);

    p.markContacted(dest);
    await p.flush();

    const s2 = freshSurface();
    const p2 = new Persistor({ ...s2, adapter: s.adapter, debounceMs: 0 });
    await p2.load();
    const reloaded = s2.routingTable.routes.get(toHex(dest));
    assert.ok(reloaded);
    assert.strictEqual(
      reloaded.interface,
      null,
      "interface is re-associated later",
    );
    assert.strictEqual(reloaded.hops, 2);
    assert.strictEqual(reloaded.timestamp, 1700000000000);
    assert.ok(bytesEqual(reloaded.nextHop, route.nextHop));
    assert.strictEqual(reloaded.randomBlobs.length, 1);
    assert.ok(bytesEqual(reloaded.randomBlobs[0], route.randomBlobs[0]));
  });
});

describe("Persistor — explicit store (favorited contacts)", () => {
  test("store pins an already-learned destination without communicating", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 0 });
    const dest = fromHex("dd".repeat(16));
    s.knownDestinations.set(
      toHex(dest),
      identityEntry(fromHex("11"), fromHex("22".repeat(64))),
    );

    await p.store(dest);

    assert.deepStrictEqual(await s.adapter.keys(StorageNamespace.IDENTITIES), [
      toHex(dest),
    ]);
  });

  test("store with an announce ingests identity + ratchet, then persists", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 0 });
    const identity = await Identity.generate();
    const ratchet = fromHex("7a".repeat(32));
    const dest = fromHex("ee".repeat(16));

    await p.store(dest, {
      announce: {
        destinationHash: dest,
        identity,
        appData: new TextEncoder().encode("Alice"),
        ratchet,
        packetHash: fromHex("99".repeat(16)),
      },
    });

    assert.deepStrictEqual(await s.adapter.keys(StorageNamespace.IDENTITIES), [
      toHex(dest),
    ]);
    assert.deepStrictEqual(await s.adapter.keys(StorageNamespace.RATCHETS), [
      toHex(dest),
    ]);

    // Reload and confirm the identity + ratchet survive a restart.
    const s2 = freshSurface();
    const p2 = new Persistor({ ...s2, adapter: s.adapter, debounceMs: 0 });
    await p2.load();
    const entry = s2.knownDestinations.get(toHex(dest));
    assert.ok(entry);
    assert.ok(bytesEqual(entry[2], identity.publicKey), "public key preserved");
    assert.ok(
      bytesEqual(entry[3], new TextEncoder().encode("Alice")),
      "app_data preserved",
    );
    const ring = s2.knownRatchets.get(toHex(dest));
    assert.ok(ring && bytesEqual(ring[0], ratchet), "ratchet preserved");
  });

  test("store flushes immediately (favorite survives even with debounce on)", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 3000 });
    const dest = fromHex("ff".repeat(16));
    s.knownDestinations.set(
      toHex(dest),
      identityEntry(fromHex("11"), fromHex("22".repeat(64))),
    );

    await p.store(dest);

    // No need to wait for the 3s debounce — store must have flushed already.
    assert.deepStrictEqual(await s.adapter.keys(StorageNamespace.IDENTITIES), [
      toHex(dest),
    ]);
    assert.strictEqual(
      p._flushTimer,
      null,
      "store must cancel any pending debounce",
    );
  });
});

describe("Persistor — hydrate-on-startup", () => {
  test("load() rebuilds the persisted set and recalls identities", async () => {
    const s = freshSurface();
    const write = new Persistor({ ...s, debounceMs: 0 });
    const identity = await Identity.generate();
    const dest = fromHex("11".repeat(16));
    await write.store(dest, {
      announce: { identity, packetHash: fromHex("00".repeat(16)) },
    });

    // A second "instance" sharing the adapter hydrates from it.
    const s2 = freshSurface();
    const read = new Persistor({ ...s2, adapter: s.adapter, debounceMs: 0 });
    await read.load();

    assert.ok(read.persistedDestinations.has(toHex(dest)));
    const entry = s2.knownDestinations.get(toHex(dest));
    assert.ok(entry && bytesEqual(entry[2], identity.publicKey));
  });

  test("load() skips a corrupt record without throwing", async () => {
    const s = freshSurface();
    await s.adapter.set(
      StorageNamespace.IDENTITIES,
      "bogus",
      fromHex("ff"), // not valid msgpack for an identity entry
    );
    const p = new Persistor({ ...s, debounceMs: 0 });
    await p.load(); // must not throw
    assert.strictEqual(s.knownDestinations.has("bogus"), false);
  });
});

describe("Persistor — debounce", () => {
  test("markContacted with debounce schedules a flush that fires later", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 15 });
    const dest = fromHex("aa".repeat(16));
    s.knownDestinations.set(
      toHex(dest),
      identityEntry(fromHex("11"), fromHex("22".repeat(64))),
    );

    p.markContacted(dest);
    // Immediately: nothing written yet (it's debounced).
    assert.deepStrictEqual(
      await s.adapter.keys(StorageNamespace.IDENTITIES),
      [],
    );
    // After the window elapses, the debounced flush has run.
    await new Promise((r) => setTimeout(r, 40));
    assert.deepStrictEqual(await s.adapter.keys(StorageNamespace.IDENTITIES), [
      toHex(dest),
    ]);
  });

  test("flush() cancels a pending debounced flush", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, debounceMs: 1000 });
    const dest = fromHex("bb".repeat(16));
    s.knownDestinations.set(
      toHex(dest),
      identityEntry(fromHex("11"), fromHex("22".repeat(64))),
    );

    p.markContacted(dest);
    assert.ok(p._flushTimer, "a debounce timer is pending");
    await p.flush();
    assert.strictEqual(p._flushTimer, null, "flush cancels the timer");
    assert.deepStrictEqual(await s.adapter.keys(StorageNamespace.IDENTITIES), [
      toHex(dest),
    ]);
  });
});

describe("Persistor — disabled is a clean no-op", () => {
  test("with adapter null, nothing throws and nothing is written", async () => {
    const s = freshSurface();
    const p = new Persistor({ ...s, adapter: null, debounceMs: 0 });
    const dest = fromHex("cc".repeat(16));
    s.knownDestinations.set(
      toHex(dest),
      identityEntry(fromHex("11"), fromHex("22".repeat(64))),
    );

    p.markContacted(dest);
    await p.store(dest);
    await p.flush();
    await p.load();

    assert.deepStrictEqual(
      await s.adapter.keys(StorageNamespace.IDENTITIES),
      [],
    );
    assert.strictEqual(p.persistedDestinations.size, 0);
  });
});
