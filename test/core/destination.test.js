import assert from "node:assert";
import test from "node:test";
import {
  createAnnounceRandomHash,
  Destination,
  Direction,
} from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";

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
