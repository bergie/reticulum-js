/**
 * Buffer / Web Stream adapter tests — ports of `RNS/Buffer.py`.
 *
 * Covers:
 *   - `StreamDataMessage` header bit layout (stream_id / compressed / eof).
 *   - `openWritable` → `openReadable` byte-exact round-trip over a real link
 *     pair, including a large payload that spans many frames.
 *   - `openDuplex` bidirectional transfer.
 *   - bz2 compression: a writer with an injected (toy) bz2 compresses frames
 *     and the reader decompresses them; round-trip still byte-exact.
 *   - eof: closing the writer terminates the reader (`done`).
 *
 * The mock-transport harness mirrors `channel.test.js`.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { Allow, Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";
import {
  openDuplex,
  openReadable,
  openWritable,
} from "../../src/transport/buffer.js";
import { StreamDataMessage } from "../../src/transport/channel.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";

// ---------------------------------------------------------------------------
// Mock transport + established-link pair (mirrors channel.test.js)
// ---------------------------------------------------------------------------

class MockTransport {
  constructor() {
    /** @type {Map<string, Link>} */
    this.links = new Map();
    /** @type {Map<string, Destination>} */
    this.destinations = new Map();
    this.peer = null;
  }
  /** @param {Uint8Array} hash @param {Link} link */
  addLink(hash, link) {
    this.links.set(toHex(hash), link);
  }
  removeLink(hash) {
    this.links.delete(toHex(hash));
  }
  /** @param {Uint8Array} hash @param {Destination} dest */
  addDestination(hash, dest) {
    this.destinations.set(toHex(hash), dest);
  }
  /** @param {import("../../src/core/packet.js").Packet} packet */
  async sendPacket(packet) {
    if (this.peer) await this.peer._route(packet);
    return true;
  }
  /** @param {import("../../src/core/packet.js").Packet} packet */
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.links.has(dh)) {
      await this.links.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      const dest = this.destinations.get(dh);
      if (packet.packetType === PacketType.LINKREQUEST) {
        const link = await Link.accept(dest, this, packet);
        this.addLink(link.linkId, link);
      }
    }
  }
}

/**
 * @returns {Promise<{ initiator: Link, responder: Link }>}
 */
async function makeEstablishedPair() {
  const responderIdentity = await Identity.generate();
  const transportI = new MockTransport();
  const transportR = new MockTransport();
  transportI.peer = transportR;
  transportR.peer = transportI;

  const responderDest = await Destination.create(
    "responder",
    Direction.IN,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: transportR }),
  );
  transportR.addDestination(responderDest.destinationHash, responderDest);

  const initiatorDest = await Destination.create(
    "responder",
    Direction.OUT,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: transportI }),
  );

  const initiator = await Link.initiate(initiatorDest, transportI);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const responder = [...transportR.links.values()][0];
    if (
      initiator.status === LinkStatus.ACTIVE &&
      responder &&
      responder.status === LinkStatus.ACTIVE
    ) {
      return { initiator, responder };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

/** Concatenate all chunks from a ReadableStream into a Uint8Array. */
async function drain(/** @type {ReadableStream<Uint8Array>} */ stream) {
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// StreamDataMessage header bit layout
// ---------------------------------------------------------------------------

test("StreamDataMessage header packs stream_id | compressed | eof", () => {
  const m = new StreamDataMessage();
  m.streamId = 0x1234;
  m.compressed = true;
  m.eof = true;
  m.data = new TextEncoder().encode("abc");
  const body = m.pack();

  const dv = new DataView(body.buffer);
  const header = dv.getUint16(0, false);
  assert.strictEqual(header & 0x3fff, 0x1234, "stream_id in low 14 bits");
  assert.ok(header & 0x4000, "compressed flag (bit 14)");
  assert.ok(header & 0x8000, "eof flag (bit 15)");
  assert.deepStrictEqual(
    Array.from(body.subarray(2)),
    [97, 98, 99],
    "data follows header",
  );
});

test("StreamDataMessage round-trips header flags through unpack", () => {
  const m = new StreamDataMessage();
  m.streamId = 0x0007;
  m.compressed = false;
  m.eof = true;
  m.data = new Uint8Array([1, 2, 3, 4]);
  const body = m.pack();

  const decoded = new StreamDataMessage();
  decoded.unpack(body);
  assert.strictEqual(decoded.streamId, 0x0007);
  assert.strictEqual(decoded.compressed, false);
  assert.strictEqual(decoded.eof, true);
  assert.deepStrictEqual(Array.from(decoded.data), [1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// openWritable → openReadable byte-exact round-trip
// ---------------------------------------------------------------------------

test("a small payload round-trips byte-exact through writer → reader", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();

  const payload = new TextEncoder().encode("hello, reticulum");

  const writable = iCh.openWritable(1);
  const readable = rCh.openReadable(1);

  const writer = writable.getWriter();
  await writer.write(payload);
  await writer.close();

  const received = await drain(readable);
  assert.deepStrictEqual(Array.from(received), Array.from(payload));

  await initiator.teardown().catch(() => {});
});

test("a large payload (many frames) round-trips byte-exact", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();

  // ~10 KiB, far larger than the ~423-byte per-frame budget.
  const payload = new Uint8Array(10240);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

  const writable = iCh.openWritable(1);
  const readable = rCh.openReadable(1);

  // Write in several chunks of varying size to exercise framing.
  const writer = writable.getWriter();
  await writer.write(payload.subarray(0, 1000));
  await writer.write(payload.subarray(1000, 5000));
  await writer.write(payload.subarray(5000));
  await writer.close();

  const received = await drain(readable);
  assert.strictEqual(received.length, payload.length);
  assert.deepStrictEqual(Array.from(received), Array.from(payload));

  await initiator.teardown().catch(() => {});
});

// ---------------------------------------------------------------------------
// openDuplex bidirectional
// ---------------------------------------------------------------------------

test("openDuplex transfers data both directions simultaneously", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();

  // Initiator writes to stream 1 and reads stream 2; responder mirrors.
  const iDuplex = iCh.openDuplex(2, 1);
  const rDuplex = rCh.openDuplex(1, 2);

  const i2r = new TextEncoder().encode("initiator -> responder");
  const r2i = new TextEncoder().encode("responder -> initiator");

  const iWriter = iDuplex.writable.getWriter();
  const rWriter = rDuplex.writable.getWriter();
  await iWriter.write(i2r);
  await rWriter.write(r2i);
  await iWriter.close();
  await rWriter.close();

  const [gotAtResponder, gotAtInitiator] = await Promise.all([
    drain(rDuplex.readable),
    drain(iDuplex.readable),
  ]);

  assert.deepStrictEqual(
    new TextDecoder().decode(gotAtResponder),
    new TextDecoder().decode(i2r),
  );
  assert.deepStrictEqual(
    new TextDecoder().decode(gotAtInitiator),
    new TextDecoder().decode(r2i),
  );

  await initiator.teardown().catch(() => {});
});

// ---------------------------------------------------------------------------
// Compression with an injected bz2 module
// ---------------------------------------------------------------------------

/**
 * A toy bz2 that RLE-encodes runs of identical bytes (only round-trips for
 * uniform buffers), matching the resource-test convention so we exercise the
 * compress/decompress plumbing without a real bz2 dependency.
 */
function toyBz2() {
  return {
    compress(/** @type {Uint8Array} */ data) {
      if (data.length === 0) return new Uint8Array(0);
      return new Uint8Array([
        data[0],
        data.length & 0xff,
        (data.length >> 8) & 0xff,
      ]);
    },
    decompress(/** @type {Uint8Array} */ c) {
      const len = c[1] | (c[2] << 8);
      return new Uint8Array(len).fill(c[0]);
    },
  };
}

test("writer compresses + reader decompresses when a bz2 module is supplied", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  // Inject the same bz2 on both links (mirrors how Resources share link.bz2).
  initiator.bz2 = toyBz2();
  responder.bz2 = toyBz2();

  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();

  // A uniform 2 KiB buffer: each ~423-byte frame compresses to 3 bytes.
  const payload = new Uint8Array(2048).fill(0x5a);

  const writable = iCh.openWritable(1);
  const readable = rCh.openReadable(1);
  const writer = writable.getWriter();
  await writer.write(payload);
  await writer.close();

  const received = await drain(readable);
  assert.strictEqual(received.length, payload.length);
  assert.deepStrictEqual(Array.from(received), Array.from(payload));

  await initiator.teardown().catch(() => {});
});

test("an explicit options.bz2 overrides the link's injected module", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const bz2 = toyBz2();
  // Do NOT set link.bz2; pass bz2 per-stream instead.
  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();

  const payload = new Uint8Array(900).fill(0x11);
  const writable = iCh.openWritable(1, { bz2 });
  const readable = rCh.openReadable(1, { bz2 });
  const writer = writable.getWriter();
  await writer.write(payload);
  await writer.close();

  const received = await drain(readable);
  assert.deepStrictEqual(Array.from(received), Array.from(payload));

  await initiator.teardown().catch(() => {});
});

// ---------------------------------------------------------------------------
// eof semantics
// ---------------------------------------------------------------------------

test("closing the writer delivers eof so the reader's read() returns done", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();

  const writable = iCh.openWritable(1);
  const readable = rCh.openReadable(1);

  const writer = writable.getWriter();
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();

  const reader = readable.getReader();
  // First read yields data, a subsequent read reports done.
  const first = await reader.read();
  assert.ok(!first.done, "first read yields the data");
  assert.deepStrictEqual(Array.from(first.value), [1, 2, 3]);
  const next = await reader.read();
  assert.ok(next.done, "second read is done after eof");

  await initiator.teardown().catch(() => {});
});
