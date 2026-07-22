/**
 * Interface prioritization by bitrate (work doc #20, Phase 1).
 *
 * Mirrors the Python reference's `Transport.prioritize_interfaces()`
 * (`Transport.interfaces.sort(key=lambda i: i.bitrate, reverse=True)`,
 * wrapped in try/except). Because JS outbound routing is path-table driven
 * (a packet leaves on the interface its path was learned through), the sort
 * governs iteration order — which is verified here via the broadcast walk.
 */
import assert from "node:assert";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Reticulum } from "../../src/core/reticulum.js";
import { Interface } from "../../src/interfaces/base.js";
import { TransportCore } from "../../src/transport/transport.js";

/**
 * Minimal interface whose outbound path records the order in which packets are
 * written, so a test can assert iteration order. Inbound is unused.
 */
class RecordingInterface extends Interface {
  /**
   * @param {string} name
   * @param {number} bitrate
   */
  constructor(name, bitrate) {
    super();
    this.name = name;
    this.bitrate = bitrate;
    this.online = true;
    /** @type {Packet[]} */
    this.sent = [];
    this._writable = new WritableStream({
      write: (/** @type {Packet} */ packet) => {
        this.sent.push(packet);
      },
    });
    this._readable = new ReadableStream({});
  }
  get readable() {
    return this._readable;
  }
  get writable() {
    return this._writable;
  }
  get isOpen() {
    return this.online;
  }
  async connect() {
    this.online = true;
  }
  async disconnect() {
    this.online = false;
  }
}

/** @returns {Packet} a minimal PLAIN DATA packet for broadcast tests. */
function plainPacket() {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: 0,
    payload: new TextEncoder().encode("x"),
  });
}

test("Reticulum.MINIMUM_BITRATE matches the Python reference (5)", () => {
  assert.strictEqual(Reticulum.MINIMUM_BITRATE, 5);
});

test("prioritizeInterfaces sorts interfaces highest-bitrate first", () => {
  const t = new TransportCore();
  const slow = new RecordingInterface("slow", 9_600);
  const fast = new RecordingInterface("fast", 50_000_000);
  const mid = new RecordingInterface("mid", 10_000_000);
  // Added out of order on purpose.
  t.addInterface(slow);
  t.addInterface(fast);
  t.addInterface(mid);

  const order = [...t.interfaces].map((i) => i.name);
  assert.deepStrictEqual(order, ["fast", "mid", "slow"]);
});

test("prioritizeInterfaces is re-run after add and after remove", () => {
  const t = new TransportCore();
  const a = new RecordingInterface("a", 1_000);
  t.addInterface(a);
  assert.deepStrictEqual(
    [...t.interfaces].map((i) => i.name),
    ["a"],
  );

  // A faster interface added later lands first.
  const b = new RecordingInterface("b", 100_000);
  t.addInterface(b);
  assert.deepStrictEqual(
    [...t.interfaces].map((i) => i.name),
    ["b", "a"],
  );

  // Removing the fastest leaves the slower one (no re-ordering artifact).
  t.removeInterface(b);
  assert.deepStrictEqual(
    [...t.interfaces].map((i) => i.name),
    ["a"],
  );
});

test("interfaces with missing/non-numeric/zero bitrate sort last, not throw", () => {
  const t = new TransportCore();
  const fast = new RecordingInterface("fast", 50_000_000);
  /** @type {any} */
  const noBitrate = new RecordingInterface("no-bitrate", 0);
  noBitrate.bitrate = undefined; // simulate a malformed interface
  /** @type {any} */
  const nullBitrate = new RecordingInterface("null-bitrate", 0);
  nullBitrate.bitrate = null;
  t.addInterface(noBitrate);
  t.addInterface(fast);
  t.addInterface(nullBitrate);

  // Does not throw, and the well-formed interface comes first.
  t.prioritizeInterfaces();
  const order = [...t.interfaces].map((i) => i.name);
  assert.strictEqual(order[0], "fast");
  // The two malformed ones occupy the tail (relative order not guaranteed).
  assert.deepStrictEqual(order.slice(1).sort(), ["no-bitrate", "null-bitrate"]);
});

test("prioritizeInterfaces is idempotent", () => {
  const t = new TransportCore();
  t.addInterface(new RecordingInterface("a", 1_000));
  t.addInterface(new RecordingInterface("b", 100_000));
  const before = [...t.interfaces].map((i) => i.name);
  t.prioritizeInterfaces();
  t.prioritizeInterfaces();
  const after = [...t.interfaces].map((i) => i.name);
  assert.deepStrictEqual(before, after);
});

test("broadcast visits interfaces in bitrate-prioritized order", () => {
  const t = new TransportCore();
  const slow = new RecordingInterface("slow", 9_600);
  const fast = new RecordingInterface("fast", 50_000_000);
  const mid = new RecordingInterface("mid", 10_000_000);
  t.addInterface(slow);
  t.addInterface(fast);
  t.addInterface(mid);

  // broadcast() writes through each interface's `_packetWriter` (acquired in
  // addInterface). Wrap each writer to record the visit order, then forward.
  /** @type {string[]} */
  const sequence = [];
  for (const iface of [slow, fast, mid]) {
    const w = iface._packetWriter;
    const origWrite = w.write.bind(w);
    w.write = (/** @type {any} */ packet) => {
      sequence.push(iface.name);
      return origWrite(packet);
    };
  }

  t.broadcast(plainPacket());

  assert.deepStrictEqual(sequence, ["fast", "mid", "slow"]);
});
