/**
 * @file rnode-webserial.js
 * @description Tests for the Web Serial RNode backend.
 *
 * No browser is needed: a fake `SerialPort` (with native Web Streams for
 * `readable`/`writable`) is injected, so the Web-Serial→transport wiring and
 * the inherited handshake are exercised identically to the base-class tests.
 */

import assert from "node:assert";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { KISS } from "../../src/interfaces/rnode.js";
import { RNodeWebSerialInterface } from "../../src/interfaces/rnode-webserial.js";

const C = KISS;

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

function be32(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function cmdFrame(command, payload = []) {
  const out = [C.FEND, command];
  for (const b of payload) {
    if (b === C.FEND) out.push(C.FESC, C.TFEND);
    else if (b === C.FESC) out.push(C.FESC, C.TFESC);
    else out.push(b);
  }
  out.push(C.FEND);
  return new Uint8Array(out);
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

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

/**
 * A minimal fake `SerialPort` using native Web Streams: `readable` is a
 * controllable ReadableStream; writes into `writable` accumulate in `written`.
 * `open()` records the options and flips `opened`.
 */
class FakeSerialPort {
  constructor() {
    this.opened = false;
    /** @type {any} */ this.openOptions = null;
    /** @type {Uint8Array[]} */ this.written = [];
    this._readController = null;
    // Like a real SerialPort, readable/writable are null until open().
    /** @type {ReadableStream<Uint8Array> | null} */ this.readable = null;
    /** @type {WritableStream<Uint8Array> | null} */ this.writable = null;
  }

  async open(options) {
    this.openOptions = options;
    this.opened = true;
    this.readable = new ReadableStream({
      start: (controller) => {
        this._readController = controller;
      },
    });
    this.writable = new WritableStream({
      write: (/** @type {Uint8Array} */ chunk) => {
        this.written.push(chunk);
      },
    });
  }

  /** @param {Uint8Array} bytes */
  push(bytes) {
    this._readController.enqueue(bytes);
  }

  async close() {
    this.opened = false;
    this.readable = null;
    this.writable = null;
  }
}

/** Drives a freshly-constructed interface through a successful handshake. */
async function bringOnline(iface, port) {
  const connectPromise = iface.connect();
  await waitFor(() => port.written.length > 0);
  port.push(
    new Uint8Array([
      ...cmdFrame(C.CMD_DETECT, [C.DETECT_RESP]),
      ...cmdFrame(C.CMD_FW_VERSION, [1, 52]),
      ...cmdFrame(C.CMD_PLATFORM, [C.PLATFORM_ESP32]),
      ...cmdFrame(C.CMD_MCU, [0x01]),
    ]),
  );
  await waitFor(() => iface.detected);
  port.push(
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

test("schema declares Web Serial frame options (no serialPort)", () => {
  const schema = RNodeWebSerialInterface.getConfigurationSchema();
  assert.equal(schema.title, "RNode Web Serial Interface (browser)");
  assert.ok(schema.properties.baudRate);
  assert.ok(schema.properties.serialFlowControl);
  // The base LoRa flowControl (boolean) is inherited, not shadowed.
  assert.equal(schema.properties.flowControl.type, "boolean");
  // serialPort is a live object, not a config value.
  assert.equal(schema.properties.serialPort, undefined);
});

test("constructor defaults baudRate and name", () => {
  const iface = new RNodeWebSerialInterface({ ...RADIO });
  assert.equal(iface.baudRate, 115200);
  assert.equal(iface.name, "rnode-webserial");
});

test("_openTransport opens the port with the configured baud rate", async () => {
  const port = new FakeSerialPort();
  const iface = new RNodeWebSerialInterface({
    ...RADIO,
    serialPort: port,
    baudRate: 9600,
  });
  await bringOnline(iface, port);
  assert.equal(port.opened, true);
  assert.equal(port.openOptions.baudRate, 9600);
  assert.equal(port.openOptions.dataBits, 8);
  assert.equal(port.openOptions.flowControl, "none");
  await iface.disconnect();
});

test("handshake brings the radio online over Web Serial", async () => {
  const port = new FakeSerialPort();
  const iface = new RNodeWebSerialInterface({ ...RADIO, serialPort: port });
  await bringOnline(iface, port);
  assert.equal(iface.detected, true);
  assert.equal(iface.majVersion, 1);
  assert.equal(iface.minVersion, 52);
  assert.equal(iface.platform, C.PLATFORM_ESP32);
  assert.equal(iface.online, true);
  assert.ok(iface.bitrate > 0);
  await iface.disconnect();
});

test("outbound frames go to port.writable; inbound packets dispatch", async () => {
  const port = new FakeSerialPort();
  const iface = new RNodeWebSerialInterface({ ...RADIO, serialPort: port });
  await bringOnline(iface, port);

  // Outbound: send() must reach the fake port's writable.
  const payload = new TextEncoder().encode("webserial!");
  const packet = mkPacket(payload);
  await iface.send(packet);
  assert.ok(
    port.written.some((w) => w[1] === C.CMD_DATA),
    "send() should write a CMD_DATA frame to the port",
  );

  // Inbound: a KISS data frame pushed into the port dispatches a packet event.
  const received = new Promise((resolve) => {
    iface.addEventListener("packet", (event) => resolve(event.detail.packet));
  });
  port.push(cmdFrame(C.CMD_DATA, Array.from(packet.serialize())));
  const got = await received;
  assert.deepEqual(Array.from(got.payload), Array.from(payload));
  await iface.disconnect();
});

test("detect() query is written to the port", async () => {
  const port = new FakeSerialPort();
  const iface = new RNodeWebSerialInterface({ ...RADIO, serialPort: port });
  await bringOnline(iface, port);
  assert.deepEqual(Array.from(port.written[0]), [
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

test("_openTransport throws when no port and no navigator.serial", async () => {
  const iface = new RNodeWebSerialInterface(RADIO); // no serialPort
  await assert.rejects(() => iface.connect(), /Web Serial API.*not available/);
  assert.equal(iface.online, false);
});
