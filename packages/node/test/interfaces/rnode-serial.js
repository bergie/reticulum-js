/**
 * @file rnode-serial.js
 * @description Smoketests for the Node.js serial RNode backend.
 *
 * Real hardware isn't required: these verify the serial class is registered,
 * honours its `port` option, inherits the transport-agnostic handshake when
 * given a fake transport, and rejects cleanly when the device path does not
 * exist. The on-the-wire protocol is covered by the base-class tests in
 * `packages/core/test/interfaces/rnode.js`.
 */

import assert from "node:assert";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "@reticulum/core/src/core/packet.js";
import { KISS } from "@reticulum/core/src/interfaces/rnode.js";
import { getInterface, listInterfaces } from "../../src/interfaces/registry.js";
import { RNodeSerialInterface } from "../../src/interfaces/rnode-serial.js";

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

/**
 * A serial-interface instance whose transport has been swapped for a fake,
 * controllable one (so the inherited handshake can be exercised without a
 * real /dev/ttyUSB* device).
 */
class FakeSerial extends RNodeSerialInterface {
  constructor(options) {
    super(options);
    /** @type {Uint8Array[]} */ this.written = [];
    this._controller = null;
    this._fakeReadable = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
    });
  }

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

  push(bytes) {
    this._controller?.enqueue(bytes);
  }
}

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

test("RNodeSerialInterface is registered as rnode-serial", () => {
  assert.equal(getInterface("rnode-serial"), RNodeSerialInterface);
  const entry = listInterfaces().find((e) => e.id === "rnode-serial");
  assert.ok(entry, "rnode-serial should appear in listInterfaces()");
  assert.equal(entry.name, "RNode Serial Interface (Node.js)");
  // Schema requires the radio params + the serial port.
  assert.deepEqual(entry.schema.required, [
    "frequency",
    "bandwidth",
    "txPower",
    "spreadingFactor",
    "codingRate",
    "port",
  ]);
  assert.ok(entry.schema.properties.port, "schema should declare port");
  assert.ok(entry.schema.properties.baudRate, "schema should declare baudRate");
});

test("constructor requires a port", () => {
  assert.throws(
    () => new RNodeSerialInterface({ ...RADIO }),
    /No port specified/,
  );
});

test("constructor defaults baudRate to 115200 and names from the port", () => {
  const iface = new RNodeSerialInterface({ ...RADIO, port: "/dev/ttyUSB0" });
  assert.equal(iface.baudRate, 115200);
  assert.equal(iface.port, "/dev/ttyUSB0");
  assert.equal(iface.name, "rnode-/dev/ttyUSB0");
});

test("serial backend inherits the full handshake (fake transport)", async () => {
  const iface = new FakeSerial({ ...RADIO, port: "/dev/fake" });
  const connectPromise = iface.connect();
  await waitFor(() => iface.written.length > 0);
  iface.push(
    new Uint8Array([
      ...cmdFrame(C.CMD_DETECT, [C.DETECT_RESP]),
      ...cmdFrame(C.CMD_FW_VERSION, [1, 52]),
      ...cmdFrame(C.CMD_PLATFORM, [C.PLATFORM_ESP32]),
    ]),
  );
  await waitFor(() => iface.detected);
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

  // Round-trip a packet through the inherited send/receive path.
  const payload = new TextEncoder().encode("serial roundtrip");
  const packet = new Packet({
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
  const received = new Promise((resolve) => {
    iface.addEventListener("packet", (event) => resolve(event.detail.packet));
  });
  await iface.send(packet);
  assert.ok(
    iface.written.some((w) => w[1] === C.CMD_DATA),
    "outbound frame",
  );

  iface.push(cmdFrame(C.CMD_DATA, Array.from(packet.serialize())));
  const got = await received;
  assert.deepEqual(Array.from(got.payload), Array.from(payload));
  await iface.disconnect();
});

test("opening a non-existent device rejects (no auto-reconnect)", async () => {
  const iface = new RNodeSerialInterface({
    ...RADIO,
    port: "/dev/does-not-exist-rnode-test",
    autoReconnect: false,
    detectTimeout: 0.5,
  });
  await assert.rejects(() => iface.connect(), /stty|No such|open/i);
  assert.equal(iface.online, false);
  await iface.disconnect();
});
