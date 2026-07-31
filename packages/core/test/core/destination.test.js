import assert from "node:assert";
import test from "node:test";
import {
  createAnnounceRandomHash,
  Destination,
  Direction,
} from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";
import { bytesEqual } from "../../src/utils/encoding.js";

test("Destination SINGLE/PLAIN/GROUP hash computation", async () => {
  const identity = await Identity.generate();

  const singleDest = await Destination.SINGLE("myapp", Direction.OUT, identity);
  assert.strictEqual(singleDest.type, DestType.SINGLE);
  assert.strictEqual(singleDest.direction, Direction.OUT);
  assert.ok(singleDest.destinationHash);
  assert.strictEqual(singleDest.nameHash.length, 10);
  assert.strictEqual(singleDest.destinationHash.length, 16);

  const plainDest = await Destination.PLAIN("someapp", Direction.IN);
  assert.strictEqual(plainDest.type, DestType.PLAIN);
  assert.strictEqual(plainDest.direction, Direction.IN);
  assert.ok(plainDest.destinationHash);
  assert.strictEqual(plainDest.destinationHash.length, 16);

  const groupDest = await Destination.GROUP("mygroup", Direction.OUT, identity);
  assert.strictEqual(groupDest.type, DestType.GROUP);
  assert.strictEqual(groupDest.direction, Direction.OUT);
  assert.ok(groupDest.destinationHash);
  assert.strictEqual(groupDest.destinationHash.length, 16);

  const inDest = await Destination.IN("myapp", DestType.SINGLE, identity);
  assert.strictEqual(inDest.direction, Direction.IN);
  assert.ok(inDest.destinationHash);

  const outDest = await Destination.OUT("myapp", DestType.SINGLE, identity);
  assert.strictEqual(outDest.direction, Direction.OUT);
  assert.ok(outDest.destinationHash);
});

// --- announce random_hash (SPEC.md §4.1, §9.10) -----------------------------

/** Decodes a 5-byte big-endian uint40 the way `timebase_from_random_blob` does. */
function decodeUint40(/** @type {Uint8Array} */ bytes5) {
  const buf = new ArrayBuffer(8);
  new Uint8Array(buf).set(bytes5, 3);
  return Number(new DataView(buf).getBigUint64(0, false));
}

test("createAnnounceRandomHash: zero timestamp yields zeros in the low half", () => {
  const rh = createAnnounceRandomHash(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), 0);
  assert.strictEqual(rh.length, 10);
  assert.deepStrictEqual(
    Array.from(rh.subarray(0, 5)),
    [1, 2, 3, 4, 5], // only the first 5 random bytes are used
  );
  assert.deepStrictEqual(Array.from(rh.subarray(5, 10)), [0, 0, 0, 0, 0]);
  assert.strictEqual(decodeUint40(rh.subarray(5, 10)), 0);
});

test("createAnnounceRandomHash: timestamp is big-endian uint40 in bytes [5:10]", () => {
  const ts = 1_750_000_000; // a value that needs 4 bytes; uint40 pads to 5
  const rh = createAnnounceRandomHash(new Uint8Array(16), ts);
  assert.strictEqual(decodeUint40(rh.subarray(5, 10)), ts);
  // The leading byte must be zero: 1.75e9 fits in 4 bytes, so a 5-byte BE
  // encoding is zero-extended. This is exactly what Python's
  // int(time.time()).to_bytes(5, "big") produces.
  assert.strictEqual(rh[5], 0);
});

test("createAnnounceRandomHash: round-trips the full uint40 range edge", () => {
  const max = 0xffffffffff; // max uint40
  const rh = createAnnounceRandomHash(new Uint8Array(5), max);
  assert.strictEqual(decodeUint40(rh.subarray(5, 10)), max);
  assert.deepStrictEqual(
    Array.from(rh.subarray(5, 10)),
    [0xff, 0xff, 0xff, 0xff, 0xff],
  );
});

test("createAnnounceRandomHash: rejects out-of-range timestamps", () => {
  assert.throws(() => createAnnounceRandomHash(new Uint8Array(5), -1));
  assert.throws(() =>
    createAnnounceRandomHash(new Uint8Array(5), 0x10000000000),
  ); // 2^40
  // Non-integer seconds are rejected to match Python's int(time.time()).
  assert.throws(() =>
    createAnnounceRandomHash(new Uint8Array(5), 1_750_000_000.5),
  );
});

test("Destination.announce embeds a real timestamp in random_hash[5:10]", async () => {
  const identity = await Identity.generate();
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const captured = [];
  const fakeLayer = {
    /** @param {import("../../src/core/packet.js").Packet} pkt */
    broadcast: (pkt) => captured.push(pkt),
  };

  const dest = await Destination.IN(
    "myapp",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (fakeLayer),
  );

  const before = Math.floor(Date.now() / 1000);
  await dest.announce();
  const after = Math.floor(Date.now() / 1000);

  assert.strictEqual(captured.length, 1);
  const pkt = captured[0];
  assert.strictEqual(pkt.packetType, PacketType.ANNOUNCE);
  assert.strictEqual(pkt.contextByte, ContextType.NONE);

  // Announce body layout (no ratchet): pubKey(64) || nameHash(10) ||
  // randomHash(10) || signature(64) || appData. random_hash is at [74:84].
  const randomHash = pkt.payload.subarray(74, 84);
  assert.strictEqual(randomHash.length, 10);

  const emitted = decodeUint40(randomHash.subarray(5, 10));
  assert.ok(
    emitted >= before && emitted <= after,
    `emitted timestamp ${emitted} not within [${before}, ${after}]`,
  );
});

test("Destination.announce refreshes the random half of random_hash each call", async () => {
  const identity = await Identity.generate();
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const captured = [];
  const fakeLayer = {
    /** @param {import("../../src/core/packet.js").Packet} pkt */
    broadcast: (pkt) => captured.push(pkt),
  };
  const dest = await Destination.IN(
    "myapp",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (fakeLayer),
  );

  await dest.announce();
  await dest.announce();

  assert.strictEqual(captured.length, 2);
  const rh1 = captured[0].payload.subarray(74, 84);
  const rh2 = captured[1].payload.subarray(74, 84);
  // The 5 random bytes MUST differ between back-to-back announces; a constant
  // random_hash would make the destination invisible after the first announce
  // (SPEC.md §7.3.2).
  assert.notDeepStrictEqual(
    Array.from(rh1.subarray(0, 5)),
    Array.from(rh2.subarray(0, 5)),
  );
});

test("Destination.announce output round-trips through Identity.validateAnnounce", async () => {
  const identity = await Identity.generate();
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const captured = [];
  const fakeLayer = {
    /** @param {import("../../src/core/packet.js").Packet} pkt */
    broadcast: (pkt) => captured.push(pkt),
  };
  const dest = await Destination.IN(
    "myapp",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (fakeLayer),
  );

  await dest.announce();
  const pkt = captured[0];
  const result = await Identity.validateAnnounce(
    pkt.destinationHash,
    pkt.contextFlag,
    pkt.payload,
  );
  assert.ok(result, "validateAnnounce should accept our own announce");
  assert.ok(bytesEqual(result.identity.identityHash, identity.identityHash));
  assert.strictEqual(result.ratchet, null);
});

test("Destination.rememberRatchet / recallRatchet store the newest ratchet", () => {
  const destHash = crypto.getRandomValues(new Uint8Array(16));
  const ratchetA = crypto.getRandomValues(new Uint8Array(32));
  const ratchetB = crypto.getRandomValues(new Uint8Array(32));

  // Clean slate (other tests may have populated the static map).
  const key = Array.from(destHash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  Destination.knownRatchets.delete(key);

  Destination.rememberRatchet(destHash, ratchetA);
  let ratchet = Destination.recallRatchet(destHash);
  assert.ok(ratchet);
  assert.ok(bytesEqual(ratchet, ratchetA));

  // Only the single newest is retained: a newer ratchet overwrites.
  Destination.rememberRatchet(destHash, ratchetB);
  ratchet = Destination.recallRatchet(destHash);
  assert.ok(ratchet);
  assert.ok(bytesEqual(ratchet, ratchetB));

  // Re-announcing the SAME ratchet is a no-op (received is not refreshed).
  Destination.rememberRatchet(destHash, ratchetB);
  ratchet = Destination.recallRatchet(destHash);
  assert.ok(bytesEqual(ratchet, ratchetB));

  Destination.knownRatchets.delete(key);
});

test("Destination.recallRatchet returns null for an unknown destination", () => {
  const destHash = crypto.getRandomValues(new Uint8Array(16));
  assert.strictEqual(Destination.recallRatchet(destHash), null);
});

test("Destination.recallRatchet drops an expired ratchet", () => {
  const destHash = crypto.getRandomValues(new Uint8Array(16));
  const ratchet = crypto.getRandomValues(new Uint8Array(32));
  const key = Array.from(destHash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  Destination.knownRatchets.delete(key);

  // Seed an already-expired entry directly.
  Destination.knownRatchets.set(key, {
    ratchet: ratchet.slice(),
    received: Date.now() - Destination.RATCHET_EXPIRY_MS - 1,
  });
  assert.strictEqual(Destination.recallRatchet(destHash), null);
  // Recall deletes the expired entry.
  assert.ok(!Destination.knownRatchets.has(key));
});

test("Destination.cleanKnownRatchets drops expired and unknown-destination entries", () => {
  const knownRatchets = new Map();
  const knownDestinations = new Map();
  const keepHash = "11".repeat(16);
  const expiredHash = "22".repeat(16);
  const unknownHash = "33".repeat(16);
  knownDestinations.set(keepHash, true);
  knownDestinations.set(expiredHash, true);
  knownRatchets.set(keepHash, {
    ratchet: new Uint8Array(32),
    received: Date.now(),
  });
  knownRatchets.set(expiredHash, {
    ratchet: new Uint8Array(32),
    received: Date.now() - Destination.RATCHET_EXPIRY_MS - 1,
  });
  knownRatchets.set(unknownHash, {
    ratchet: new Uint8Array(32),
    received: Date.now(),
  });

  const removed = Destination.cleanKnownRatchets(
    knownRatchets,
    knownDestinations,
  );
  assert.strictEqual(removed, 2);
  assert.ok(knownRatchets.has(keepHash));
  assert.ok(!knownRatchets.has(expiredHash));
  assert.ok(!knownRatchets.has(unknownHash));
});

// --- periodic re-announce scheduler (PROTOCOL-SPEC.md §7.5 / §9.7) ----------

/**
 * Builds a SINGLE IN destination with a capturing broadcast fake layer.
 * @returns {Promise<{ dest: Destination, captured: import("../../src/core/packet.js").Packet[] }>}>
 */
async function makeAnnounceableDest() {
  const identity = await Identity.generate();
  /** @type {import("../../src/core/packet.js").Packet[]} */
  const captured = [];
  /** @type {any} */
  const fakeLayer = { broadcast: (pkt) => captured.push(pkt) };
  const dest = await Destination.IN(
    "myapp",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (fakeLayer),
  );
  return { dest, captured };
}

/** Waits ms milliseconds. */
const wait = (/** @type {number} */ ms) =>
  new Promise((r) => setTimeout(r, ms));

test("startAnnouncing fires an immediate announce then repeats periodically", async () => {
  // Allow tiny intervals for the test (the §9.7 60 s floor would otherwise
  // make periodic fires unobservable).
  const originalMin = Destination.MIN_ANNOUNCE_INTERVAL_MS;
  Destination.MIN_ANNOUNCE_INTERVAL_MS = 1;
  /** @type {Destination|null} */
  let dest = null;
  /** @type {any[]} */
  let captured = [];
  try {
    ({ dest, captured } = await makeAnnounceableDest());
    dest.startAnnouncing({ intervalMs: 5 });
    assert.ok(dest.isAnnouncing());
    await wait(10);
    assert.ok(captured.length >= 1, "at least the immediate announce landed");
    await wait(50);
    assert.ok(
      captured.length >= 2,
      `expected periodic fires, got ${captured.length}`,
    );
  } finally {
    dest?.stopAnnouncing();
    Destination.MIN_ANNOUNCE_INTERVAL_MS = originalMin;
  }
});

test("stopAnnouncing halts the periodic loop", async () => {
  const originalMin = Destination.MIN_ANNOUNCE_INTERVAL_MS;
  Destination.MIN_ANNOUNCE_INTERVAL_MS = 1;
  /** @type {Destination|null} */
  let dest = null;
  /** @type {any[]} */
  let captured = [];
  try {
    ({ dest, captured } = await makeAnnounceableDest());
    dest.startAnnouncing({ intervalMs: 5 });
    await wait(10);
    dest.stopAnnouncing();
    assert.ok(!dest.isAnnouncing());
    const countAtStop = captured.length;
    await wait(50);
    assert.strictEqual(
      captured.length,
      countAtStop,
      "no further announces after stop",
    );
  } finally {
    dest?.stopAnnouncing();
    Destination.MIN_ANNOUNCE_INTERVAL_MS = originalMin;
  }
});

test("startAnnouncing clamps sub-minute intervals to the §9.7 floor", async () => {
  /** @type {Destination|null} */
  let dest = null;
  try {
    ({ dest } = await makeAnnounceableDest());
    // 1 s is below the default 60 s floor.
    dest.startAnnouncing({ intervalMs: 1000 });
    assert.strictEqual(
      dest.announceIntervalMs,
      Destination.MIN_ANNOUNCE_INTERVAL_MS,
    );
    assert.ok(dest.isAnnouncing());
  } finally {
    dest?.stopAnnouncing();
  }
});

test("re-calling startAnnouncing updates the cadence without an extra immediate burst", async () => {
  const originalMin = Destination.MIN_ANNOUNCE_INTERVAL_MS;
  Destination.MIN_ANNOUNCE_INTERVAL_MS = 1;
  /** @type {Destination|null} */
  let dest = null;
  /** @type {any[]} */
  let captured = [];
  try {
    ({ dest, captured } = await makeAnnounceableDest());
    dest.startAnnouncing({ intervalMs: 5 });
    await wait(10);
    const afterFirst = captured.length;
    // Update the cadence while running — must not emit an extra immediate fire.
    dest.startAnnouncing({ intervalMs: 5 });
    await wait(2);
    assert.strictEqual(
      captured.length,
      afterFirst,
      "restart must not burst an immediate announce",
    );
    assert.strictEqual(dest.announceIntervalMs, 5);
  } finally {
    dest?.stopAnnouncing();
    Destination.MIN_ANNOUNCE_INTERVAL_MS = originalMin;
  }
});

test("a failed periodic announce does not stop the loop", async () => {
  const originalMin = Destination.MIN_ANNOUNCE_INTERVAL_MS;
  Destination.MIN_ANNOUNCE_INTERVAL_MS = 1;
  /** @type {Destination|null} */
  let dest = null;
  /** @type {any[]} */
  let captured = [];
  try {
    ({ dest, captured } = await makeAnnounceableDest());
    // Force every announce to fail by making broadcast throw.
    /** @type {any} */ (dest.interfaceLayer).broadcast = () => {
      throw new Error("transient broadcast failure");
    };
    dest.startAnnouncing({ intervalMs: 5 });
    await wait(20);
    assert.ok(dest.isAnnouncing(), "loop survives repeated failed announces");
    assert.strictEqual(captured.length, 0, "no announce landed while failing");

    // Restore broadcast; subsequent periodic fires must now succeed.
    /** @type {any} */ (dest.interfaceLayer).broadcast = (
      /** @type {any} */ pkt,
    ) => captured.push(pkt);
    await wait(20);
    assert.ok(captured.length >= 1, "announces resumed after recovery");
  } finally {
    dest?.stopAnnouncing();
    Destination.MIN_ANNOUNCE_INTERVAL_MS = originalMin;
  }
});

test("startAnnouncing throws without an identity or interface layer", async () => {
  const identity = await Identity.generate();
  const dest = new Destination(
    "myapp",
    Direction.IN,
    DestType.SINGLE,
    identity,
    null,
  );
  await dest._computeHashes();
  assert.throws(() => dest.startAnnouncing(), /not bound to an RNS instance/);

  // A PLAIN destination has no identity.
  /** @type {any} */
  const fakeLayer = { broadcast: () => {} };
  const plainDest = await Destination.IN(
    "myapp",
    DestType.PLAIN,
    null,
    /** @type {any} */ (fakeLayer),
  );
  assert.throws(() => plainDest.startAnnouncing(), /requires an identity/);
});
