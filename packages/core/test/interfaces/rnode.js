/**
 * @file rnode.js
 * @description Tests for the transport-agnostic RNodeInterface base class.
 *
 * No real hardware is needed: a fake transport subclass captures outbound
 * bytes and lets each test pump scripted KISS responses (detect, config
 * echoes, data frames, stats) inbound. This validates the read-loop state
 * machine, the detect → configure → validate handshake, flow control, and
 * stats parsing byte-for-byte against the Python reference semantics.
 */

import assert from "node:assert";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { KISS, RNodeInterface } from "../../src/interfaces/rnode.js";

/** Valid radio parameters used by most tests (EU 868 MHz band). */
const RADIO = {
  frequency: 868000000,
  bandwidth: 125000,
  txPower: 17,
  spreadingFactor: 7,
  codingRate: 5,
  postOpenDelayMs: 0,
  detectTimeout: 1,
  validateTimeout: 1,
};

/** KISS command bytes (also exported via the `KISS` table). */
const C = KISS;

/**
 * Builds a single KISS command frame: FEND | command | payload | FEND, with
 * KISS escaping of the payload (so tests can assert escape handling without
 * depending on the production framer).
 * @param {number} command
 * @param {number[]} payload
 * @returns {Uint8Array}
 */
function cmdFrame(command, payload = []) {
  const out = [C.FEND, command];
  for (const b of payload) {
    if (b === C.FEND) {
      out.push(C.FESC, C.TFEND);
    } else if (b === C.FESC) {
      out.push(C.FESC, C.TFESC);
    } else {
      out.push(b);
    }
  }
  out.push(C.FEND);
  return new Uint8Array(out);
}

/** Big-endian 4-byte split (Python `c1..c4` ordering for frequency/bandwidth). */
function be32(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/** Inverse of `cmdFrame` escaping: FESC TFEND→FEND, FESC TFESC→FESC. */
function unescape(bytes) {
  const out = [];
  let esc = false;
  for (const b of bytes) {
    if (esc) {
      out.push(b === C.TFEND ? C.FEND : b === C.TFESC ? C.FESC : b);
      esc = false;
    } else if (b === C.FESC) {
      esc = true;
    } else {
      out.push(b);
    }
  }
  return out;
}

/**
 * Resolves once `predicate()` is true, polling every 10ms (faster than the
 * production 50ms so tests stay snappy). Rejects after `timeoutMs`.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (predicate()) return resolve();
      } catch (e) {
        return reject(e);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * A controllable fake transport. `written` accumulates every byte sequence the
 * interface sends to the "radio"; `push()` injects inbound bytes.
 */
class FakeTransport extends RNodeInterface {
  constructor(options) {
    super(options);
    /** @type {Uint8Array[]} */ this.written = [];
    this._controller = null;
    // A plain ReadableStream we control via its enqueue controller.
    this._fakeReadable = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
    });
  }

  /** @returns {import("../../src/interfaces/rnode.js").RNodeTransport} */
  _openTransport() {
    return {
      readable: this._fakeReadable,
      write: (bytes) => {
        this.written.push(bytes);
      },
      close: () => {
        try {
          this._controller?.close();
        } catch (_e) {
          // already closed
        }
      },
    };
  }

  /** Injects raw bytes into the inbound stream (a "radio" transmission). */
  push(bytes) {
    this._controller?.enqueue(bytes);
  }
}

/**
 * Starts `iface.connect()` and drives it through a successful handshake by
 * responding to the detect/config sequence with matching echoes. Resolves once
 * the interface is online and `connect()` has settled.
 * @param {FakeTransport} iface
 */
async function bringOnline(iface) {
  const connectPromise = iface.connect();
  // Wait for detect() to be sent (it is the first write) and for the device to
  // be detected once we push the response.
  await waitFor(() => iface.written.length > 0);
  iface.push(
    new Uint8Array([
      ...cmdFrame(C.CMD_DETECT, [C.DETECT_RESP]),
      ...cmdFrame(C.CMD_FW_VERSION, [1, 52]),
      ...cmdFrame(C.CMD_PLATFORM, [C.PLATFORM_ESP32]),
      ...cmdFrame(C.CMD_MCU, [0x01]),
    ]),
  );
  await waitFor(() => iface.detected);
  // Config echoes for validateRadioState (must match the requested params).
  iface.push(
    new Uint8Array([
      ...cmdFrame(C.CMD_FREQUENCY, be32(iface.frequency)),
      ...cmdFrame(C.CMD_BANDWIDTH, be32(iface.bandwidth)),
      ...cmdFrame(C.CMD_TXPOWER, [iface.txPower]),
      ...cmdFrame(C.CMD_SF, [iface.sf]),
      ...cmdFrame(C.CMD_CR, [iface.cr]),
      ...cmdFrame(C.CMD_RADIO_STATE, [C.RADIO_STATE_ON]),
    ]),
  );
  await waitFor(() => iface.online);
  await connectPromise;
}

/** Builds a minimal valid DATA packet with the given payload. */
function mkPacket(payload) {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: 0,
    payload,
  });
}

test("constructor validates radio configuration", () => {
  assert.throws(
    () => new RNodeInterface({ ...RADIO, frequency: 10 }),
    /Invalid RNode configuration/,
  );
  assert.throws(
    () => new RNodeInterface({ ...RADIO, spreadingFactor: 20 }),
    /Invalid RNode configuration/,
  );
  assert.throws(
    () => new RNodeInterface({ ...RADIO, txPower: 99 }),
    /Invalid RNode configuration/,
  );
  assert.throws(
    () => new RNodeInterface({ ...RADIO, airtimeLimitShort: 200 }),
    /Invalid RNode configuration/,
  );
});

test("_openTransport is abstract on the base class", () => {
  const iface = new RNodeInterface(RADIO);
  assert.throws(() => iface._openTransport(), /must be implemented/);
});

test("detect() emits the exact Python query byte sequence", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);
  // The very first write is the detect sequence: FEND DETECT REQ FEND
  // FW_VERSION 0 FEND PLATFORM 0 FEND MCU 0 FEND (5 FENDs, 4 frames).
  assert.deepEqual(Array.from(iface.written[0]), [
    C.FEND,
    C.CMD_DETECT,
    C.DETECT_REQ,
    C.FEND,
    C.CMD_FW_VERSION,
    0x00,
    C.FEND,
    C.CMD_PLATFORM,
    0x00,
    C.FEND,
    C.CMD_MCU,
    0x00,
    C.FEND,
  ]);
  await iface.disconnect();
});

test("handshake configures the radio and applies state", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);

  assert.equal(iface.detected, true);
  assert.equal(iface.platform, C.PLATFORM_ESP32);
  assert.equal(iface.majVersion, 1);
  assert.equal(iface.minVersion, 52);
  assert.equal(iface.firmwareOk, true);
  assert.equal(iface.online, true);
  assert.equal(iface.bitrate > 0, true, "bitrate should be computed");

  // The config sequence writes: frequency, bandwidth, txpower, sf, cr, (no
  // alocks — none configured), radio state ON. Verify the radio-state command.
  const radioState = iface.written.find((w) => w[1] === C.CMD_RADIO_STATE);
  assert.ok(radioState, "should have sent a CMD_RADIO_STATE frame");
  assert.equal(radioState[2], C.RADIO_STATE_ON);

  // Frequency command escapes its 4-byte big-endian payload.
  const freq = iface.written.find((w) => w[1] === C.CMD_FREQUENCY);
  assert.ok(freq);
  assert.deepEqual([freq[2], freq[3], freq[4], freq[5]], be32(RADIO.frequency));
  await iface.disconnect();
});

test("too-old firmware aborts the handshake", async () => {
  const iface = new FakeTransport(RADIO);
  const connectPromise = iface.connect();
  await waitFor(() => iface.written.length > 0);
  // Respond to detect + an old firmware (1.40 < required 1.52).
  iface.push(
    new Uint8Array([
      ...cmdFrame(C.CMD_DETECT, [C.DETECT_RESP]),
      ...cmdFrame(C.CMD_FW_VERSION, [1, 40]),
    ]),
  );
  await assert.rejects(connectPromise, /too old/);
  assert.equal(iface.online, false);
  await iface.disconnect();
});

test("detect timeout aborts when the device never responds", async () => {
  const iface = new FakeTransport({ ...RADIO, detectTimeout: 0.2 });
  await assert.rejects(() => iface.connect(), /Could not detect RNode device/);
  assert.equal(iface.online, false);
});

test("CMD_DATA inbound is unescaped and dispatched as a packet", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);

  const payload = new TextEncoder().encode("hello rnode");
  const packet = mkPacket(payload);
  const received = new Promise((resolve) => {
    iface.addEventListener("packet", (event) => resolve(event.detail.packet));
  });
  iface.push(cmdFrame(C.CMD_DATA, Array.from(packet.serialize())));
  const got = await received;
  assert.deepEqual(Array.from(got.payload), Array.from(payload));
  assert.equal(iface.rxb, packet.serialize().length);
  await iface.disconnect();
});

test("outbound send() frames the packet as a KISS data frame", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);

  const payload = new TextEncoder().encode("outbound!");
  const packet = mkPacket(payload);
  await iface.send(packet);

  const dataFrame = iface.written.find((w) => w[1] === C.CMD_DATA);
  assert.ok(dataFrame, "should have written a CMD_DATA frame");
  assert.equal(dataFrame[0], C.FEND);
  assert.equal(dataFrame[dataFrame.length - 1], C.FEND);
  assert.equal(iface.txb, packet.serialize().length);
  await iface.disconnect();
});

test("flow control gates one packet per CMD_READY", async () => {
  const iface = new FakeTransport({ ...RADIO, flowControl: true });
  await bringOnline(iface);

  const before = iface.written.filter((w) => w[1] === C.CMD_DATA).length;
  // First send goes through (interface ready after handshake).
  await iface.send(mkPacket(new TextEncoder().encode("p1")));
  // With flow control, interfaceReady is now false → this one queues.
  await iface.send(mkPacket(new TextEncoder().encode("p2")));
  const sent = iface.written.filter((w) => w[1] === C.CMD_DATA).length - before;
  assert.equal(sent, 1, "only the first packet should have been transmitted");

  // A CMD_READY signal drains exactly one queued packet.
  iface.push(cmdFrame(C.CMD_READY, [0x00]));
  await waitFor(
    () =>
      iface.written.filter((w) => w[1] === C.CMD_DATA).length - before === 2,
  );
  await iface.disconnect();
});

test("stats commands update radio state", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);

  // RSSI byte = rStatRssi + RSSI_OFFSET. For -60 dBm: byte = 97.
  iface.push(
    new Uint8Array([
      ...cmdFrame(C.CMD_STAT_RSSI, [97]),
      ...cmdFrame(C.CMD_STAT_BAT, [0x02, 87]),
      ...cmdFrame(C.CMD_STAT_TEMP, [120 + 25]),
    ]),
  );
  await waitFor(() => iface.rStatRssi !== null);
  assert.equal(iface.rStatRssi, 97 - C.RSSI_OFFSET);
  assert.equal(iface.rBatteryState, 0x02);
  assert.equal(iface.rBatteryPercent, 87);
  assert.equal(iface.rTemperature, 25);
  await iface.disconnect();
});

test("CMD_ERROR initradio aborts the read loop", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);

  iface.push(cmdFrame(C.CMD_ERROR, [C.ERROR_INITRADIO]));
  // The read loop throws on INITRADIO → the interface goes offline.
  await waitFor(() => iface.online === false, 1000);
  assert.equal(iface.online, false);
  await iface.disconnect();
});

test("disconnect powers the radio off and sends leave", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);
  const before = iface.written.length;
  await iface.disconnect();

  const after = iface.written.slice(before);
  const radioOff = after.find((w) => w[1] === C.CMD_RADIO_STATE);
  const leave = after.find((w) => w[1] === C.CMD_LEAVE);
  assert.ok(radioOff, "should have powered the radio off");
  assert.equal(radioOff[2], C.RADIO_STATE_OFF);
  assert.ok(leave, "should have sent CMD_LEAVE");
  assert.equal(iface.online, false);
});

// -------------------------------------------------------------------------
// Framebuffer / display
// -------------------------------------------------------------------------

test("framebuffer geometry constants match the Python reference (64x64 @ 1bpp)", () => {
  assert.equal(RNodeInterface.FB_PIXEL_WIDTH, 64);
  assert.equal(RNodeInterface.FB_BITS_PER_PIXEL, 1);
  assert.equal(RNodeInterface.FB_BYTES_PER_LINE, 8);
  assert.equal(RNodeInterface.FB_SIZE_BYTES, 512);
  assert.equal(KISS.CMD_FB_EXT, 0x41);
  assert.equal(KISS.CMD_FB_READ, 0x42);
  assert.equal(KISS.CMD_FB_WRITE, 0x43);
});

test("display capability is true for ESP32 after detect, false before", async () => {
  const iface = new FakeTransport(RADIO);
  assert.equal(iface.display, false);
  await bringOnline(iface); // brings up an ESP32 platform
  assert.equal(iface.display, true);
  await iface.disconnect();
});

test("enable/disable external framebuffer toggle CMD_FB_EXT", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);
  const before = iface.written.length;
  iface.enableExternalFramebuffer();
  iface.disableExternalFramebuffer();
  const frames = iface.written
    .slice(before)
    .filter((w) => w[1] === C.CMD_FB_EXT);
  assert.equal(frames.length, 2);
  assert.equal(frames[0][2], 0x01);
  assert.equal(frames[1][2], 0x00);
  await iface.disconnect();
});

test("writeFramebuffer frames a CMD_FB_WRITE line with line-number prefix", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);
  const before = iface.written.length;
  iface.writeFramebuffer(3, [1, 2, 3, 4, 5, 6, 7, 8]);
  const frame = iface.written[before];
  assert.equal(frame[0], C.FEND);
  assert.equal(frame[1], C.CMD_FB_WRITE);
  const body = unescape(frame.slice(2, frame.length - 1));
  assert.deepEqual(body, [3, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(frame[frame.length - 1], C.FEND);
  await iface.disconnect();
});

test("writeFramebuffer escapes FEND/FESC bytes in line and data", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);
  const before = iface.written.length;
  // Line index 0xC0 (==FEND) and data containing FEND(0xC0) and FESC(0xDB).
  iface.writeFramebuffer(
    0xc0,
    [0xc0, 0xdb, 0x00, 0xc0, 0x01, 0x02, 0x03, 0x04],
  );
  const frame = iface.written[before];
  assert.ok(frame.includes(C.FESC), "payload should have been KISS-escaped");
  const body = unescape(frame.slice(2, frame.length - 1));
  assert.deepEqual(
    body,
    [0xc0, 0xc0, 0xdb, 0x00, 0xc0, 0x01, 0x02, 0x03, 0x04],
  );
  await iface.disconnect();
});

test("displayImage writes one CMD_FB_WRITE per 8-byte line", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);
  const before = iface.written.length;
  const image = new Uint8Array(20); // 2 full lines (16 bytes) + 4 trailing
  for (let i = 0; i < 20; i++) image[i] = i;
  const lines = iface.displayImage(image);
  assert.equal(lines, 2);
  const fbWrites = iface.written
    .slice(before)
    .filter((w) => w[1] === C.CMD_FB_WRITE);
  assert.equal(fbWrites.length, 2);
  assert.equal(unescape(fbWrites[0].slice(2, fbWrites[0].length - 1))[0], 0);
  assert.equal(unescape(fbWrites[1].slice(2, fbWrites[1].length - 1))[0], 1);
  await iface.disconnect();
});

test("readFramebuffer captures the 512-byte image with unescaping", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);

  // A 512-byte image that cycles 0..255 twice, so it contains FEND(0xC0) and
  // FESC(0xDB) and exercises the round-trip unescaping on read.
  const fb = new Uint8Array(512);
  for (let i = 0; i < 512; i++) fb[i] = i & 0xff;

  const pending = iface.readFramebuffer(2000);
  await waitFor(() => iface.written.some((w) => w[1] === C.CMD_FB_READ));
  iface.push(cmdFrame(C.CMD_FB_READ, Array.from(fb)));
  const result = await pending;

  assert.ok(result instanceof Uint8Array, "should resolve with a Uint8Array");
  assert.equal(result.length, 512);
  assert.deepEqual(Array.from(result), Array.from(fb));
  assert.equal(typeof iface.rFrameBufferLatency, "number");
  await iface.disconnect();
});

test("readFramebuffer sends CMD_FB_READ with a 0x01 payload byte", async () => {
  const iface = new FakeTransport(RADIO);
  await bringOnline(iface);
  const before = iface.written.length;
  const pending = iface.readFramebuffer(50); // short timeout; we only inspect the request
  await pending;
  const req = iface.written.slice(before).find((w) => w[1] === C.CMD_FB_READ);
  assert.ok(req, "should have sent a CMD_FB_READ");
  assert.deepEqual(Array.from(req.slice(2, req.length - 1)), [0x01]);
  assert.equal(iface.rFrameBuffer, null); // timed out, no response pushed
  await iface.disconnect();
});

test("framebuffer methods are no-ops on a headless (undetected) device", async () => {
  const iface = new FakeTransport(RADIO); // not connected → display stays false
  assert.equal(iface.display, false);
  const before = iface.written.length;
  iface.enableExternalFramebuffer();
  assert.equal(iface.displayImage(new Uint8Array(16)), 0);
  assert.equal(await iface.readFramebuffer(), null);
  assert.equal(
    iface.written.length,
    before,
    "nothing should have been written",
  );
});
