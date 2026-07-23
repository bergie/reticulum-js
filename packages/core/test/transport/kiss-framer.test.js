import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import {
  createKissFramerStream,
  createKissUnframerStream,
  kissEscape,
  kissFrame,
  kissUnescape,
} from "../../src/transport/kiss-framer.js";

// KISS wire constants, mirrored from the Python reference `KISS` class so the
// tests can assert on the exact framing bytes.
const FEND = 0xc0;
const FESC = 0xdb;
const TFEND = 0xdc;
const TFESC = 0xdd;
const CMD_DATA = 0x00;

// --- 1. Helper Utilities ---

/**
 * Feeds an array of Uint8Array chunks into the unframer and collects packets.
 */
async function runUnframerTest(chunks, ifacSize = 0) {
  const unframer = createKissUnframerStream(Packet, ifacSize);
  const writer = unframer.writable.getWriter();
  const reader = unframer.readable.getReader();
  const results = [];

  const pump = async () => {
    for (const chunk of chunks) {
      await writer.write(chunk);
    }
    await writer.close();
  };

  const consume = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      results.push(value);
    }
  };

  await Promise.all([pump(), consume()]);
  return results;
}

/**
 * Feeds an array of Packet objects into the framer and collects the frames.
 */
async function runFramerTest(packets) {
  const framer = createKissFramerStream();
  const writer = framer.writable.getWriter();
  const reader = framer.readable.getReader();
  const results = [];

  const pump = async () => {
    for (const packet of packets) {
      await writer.write(packet);
    }
    await writer.close();
  };

  const consume = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      results.push(value);
    }
  };

  await Promise.all([pump(), consume()]);
  return results;
}

function makePacket(payload) {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 1,
    transportType: 0,
    destinationType: DestType.SINGLE,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16),
    payload,
  });
}

/** Builds an expected KISS frame `FEND | CMD_DATA | escaped | FEND`. */
function expectedFrame(raw) {
  const escaped = kissEscape(raw);
  const frame = new Uint8Array(escaped.length + 3);
  frame[0] = FEND;
  frame[1] = CMD_DATA;
  frame.set(escaped, 2);
  frame[frame.length - 1] = FEND;
  return frame;
}

// --- 2. The Test Suite ---

describe("KISS escape utilities", () => {
  test("kissEscape and kissUnescape should be inverses", () => {
    const data = new Uint8Array([0xc0, 0x01, 0xdb, 0x02, 0x00, 0xff]);
    assert.deepEqual(kissUnescape(kissEscape(data)), data);
  });

  test("kissEscape uses FESC-first precedence (matches Python KISS.escape)", () => {
    // 0xC0 must expand to 0xDB 0xDC. If FESC were not escaped first, the
    // 0xDB introduced by the FEND expansion would itself be re-escaped to
    // 0xDB 0xDD 0xDC — a double-escape bug.
    assert.deepEqual(
      kissEscape(new Uint8Array([0xc0])),
      new Uint8Array([0xdb, 0xdc]),
    );
    assert.deepEqual(
      kissEscape(new Uint8Array([0xdb])),
      new Uint8Array([0xdb, 0xdd]),
    );
  });

  test("kissFrame wraps payload as FEND | CMD_DATA | escaped | FEND", () => {
    const raw = new Uint8Array([0xaa, 0xc0, 0xbb]);
    assert.deepEqual(
      kissFrame(raw),
      new Uint8Array([FEND, CMD_DATA, 0xaa, 0xdb, 0xdc, 0xbb, FEND]),
    );
  });

  test("kissUnescape throws on an invalid escape pair", () => {
    assert.throws(
      () => kissUnescape(new Uint8Array([0xdb, 0x01])),
      /Invalid escape sequence/,
    );
  });
});

describe("KISS Framer TransformStream", () => {
  test("Perfect alignment: 1 packet = 1 frame, with CMD_DATA byte", async () => {
    const packet = makePacket(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const results = await runFramerTest([packet]);

    assert.equal(results.length, 1);
    assert.deepEqual(results[0], expectedFrame(packet.serialize()));
  });

  test("Round-trips a payload byte-for-byte equal to 0xC0/0xDB", async () => {
    const packet = makePacket(new Uint8Array([0xc0, 0xdb, 0xc0, 0xdb]));
    const frames = await runFramerTest([packet]);
    const packets = await runUnframerTest(frames);

    assert.equal(packets.length, 1);
    assert.deepEqual(packets[0].payload, packet.payload);
  });
});

describe("KISS Unframer TransformStream", () => {
  test("Perfect alignment: 1 frame = 1 packet", async () => {
    const packet = makePacket(new Uint8Array([0xaa, 0xbb]));
    const results = await runUnframerTest([expectedFrame(packet.serialize())]);

    assert.equal(results.length, 1);
    assert.ok(results[0] instanceof Packet);
    assert.deepEqual(results[0].payload, packet.payload);
  });

  test("Fragmentation: 1 frame split across multiple chunks", async () => {
    const packet = makePacket(new Uint8Array([1, 2, 3, 4, 5]));
    const frame = expectedFrame(packet.serialize());

    const results = await runUnframerTest([
      frame.slice(0, 3),
      frame.slice(3, 6),
      frame.slice(6),
    ]);

    assert.equal(results.length, 1);
    assert.deepEqual(results[0].payload, packet.payload);
  });

  test("Coalescing: multiple frames in one chunk", async () => {
    const p1 = makePacket(new Uint8Array([1]));
    const p2 = makePacket(new Uint8Array([2]));
    const combined = new Uint8Array([
      ...expectedFrame(p1.serialize()),
      ...expectedFrame(p2.serialize()),
    ]);

    const results = await runUnframerTest([combined]);

    assert.equal(results.length, 2);
    assert.deepEqual(results[0].payload, p1.payload);
    assert.deepEqual(results[1].payload, p2.payload);
  });

  test("Strips the port nibble: any port's data frame maps to CMD_DATA", async () => {
    // The Python reference strips the command-byte high nibble, so a data
    // frame addressed to port 3 (command byte 0x30) is still treated as data.
    const packet = makePacket(new Uint8Array([0x42]));
    const escaped = kissEscape(packet.serialize());
    const frame = new Uint8Array(escaped.length + 3);
    frame[0] = FEND;
    frame[1] = 0x30; // CMD_DATA | (port 3 << 4)
    frame.set(escaped, 2);
    frame[frame.length - 1] = FEND;

    const results = await runUnframerTest([frame]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].payload, packet.payload);
  });

  test("Non-data command frames are consumed and never emitted", async () => {
    // A CMD_READY (0x0f) frame carries no RNS packet and must be dropped.
    const nonData = new Uint8Array([FEND, 0x0f, 0x01, FEND]);
    const packet = makePacket(new Uint8Array([0x99]));
    const data = expectedFrame(packet.serialize());

    const results = await runUnframerTest([nonData, data]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].payload, packet.payload);
  });

  test("Bytes outside any frame (no leading FEND) are ignored", async () => {
    const packet = makePacket(new Uint8Array([0x77]));
    const results = await runUnframerTest([
      new Uint8Array([0x01, 0x02, 0xaa]), // line noise before first FEND
      expectedFrame(packet.serialize()),
    ]);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].payload, packet.payload);
  });
});
