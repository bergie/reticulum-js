import assert from "node:assert";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { WebRTCInterface } from "../../src/interfaces/webrtc.js";

/**
 * @file webrtc.js
 * @description Tests for the WebRTC data-channel interface.
 *
 * Node has no native WebRTC, so these tests use a minimal mock
 * `RTCDataChannel` pair: two duck-typed channels where each one's `send()`
 * delivers a `message` event (with an `ArrayBuffer` copy) to its peer —
 * mirroring how a real loopback data channel behaves. This exercises the
 * interface's Packet↔message bridging without any dependency; the real
 * WebRTC negotiation (SDP exchange over a Reticulum Link+Resource) is the
 * signaling orchestrator's job and lives in `src/webrtc/signaling.js`.
 */

/** Builds a minimal valid RNS DATA packet. */
function buildTestPacket(payload = "Hello over WebRTC!") {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: 0,
    payload: new TextEncoder().encode(payload),
  });
}

/**
 * Creates a pair of mock `RTCDataChannel`-shaped objects wired back-to-back:
 * `a.send(bytes)` arrives as a `message` event on `b` (and vice versa). Both
 * start in the `"connecting"` state; call `_open()` to transition to `"open"`.
 * @returns {[any, any]}
 */
function createChannelPair() {
  /** @param {string} label */
  const make = (label) => {
    /** @type {Map<string, Set<(event: any) => void>>} */
    const listeners = new Map();
    /** @type {any} */
    const ch = {
      label,
      id: Math.floor(Math.random() * 1000),
      binaryType: "arraybuffer",
      readyState: "connecting",
      _peer: null,
      addEventListener(type, cb) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        /** @type {Set<(event: any) => void>} */ (listeners.get(type)).add(cb);
      },
      removeEventListener(type, cb) {
        /** @type {Set<(event: any) => void> | undefined} */ (
          listeners.get(type)
        )?.delete(cb);
      },
      _dispatch(type, event) {
        for (const cb of /** @type {Set<(event: any) => void>} */ (
          listeners.get(type) ?? []
        ))
          cb(event);
      },
      send(data) {
        if (this.readyState !== "open")
          throw new Error("RTCDataChannel is not open");
        // Normalize to a Uint8Array view, copy exactly the viewed bytes, and
        // deliver a fresh ArrayBuffer to the peer (binaryType = "arraybuffer").
        const src = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const copy = new Uint8Array(/** @type {Uint8Array} */ (src).byteLength);
        copy.set(/** @type {Uint8Array} */ (src));
        this._peer._dispatch("message", { data: copy.buffer });
      },
      close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        this._dispatch("close", {});
        if (this._peer && this._peer.readyState !== "closed") {
          this._peer.readyState = "closed";
          this._peer._dispatch("close", {});
        }
      },
      // Test helper: transition to open and fire the open event.
      _open() {
        this.readyState = "open";
        this._dispatch("open", {});
      },
    };
    return ch;
  };
  const a = make("a");
  const b = make("b");
  a._peer = b;
  b._peer = a;
  return [a, b];
}

test("WebRTCInterface requires an RTCDataChannel", () => {
  assert.throws(
    () => new WebRTCInterface(/** @type {any} */ ({})),
    /requires an RTCDataChannel/,
  );
});

test("WebRTCInterface declares the default ~50 Mbit/s bitrate", () => {
  const iface = new WebRTCInterface({
    channel: createChannelPair()[0],
  });
  assert.equal(iface.bitrate, 50000000);
  assert.equal(
    new WebRTCInterface({
      channel: createChannelPair()[0],
      bitrate: 123456,
    }).bitrate,
    123456,
  );
});

test("connect() waits for the data channel to open", async () => {
  const [chanA] = createChannelPair();
  const iface = new WebRTCInterface({ channel: chanA });
  const connectPromise = iface.connect();
  // Still connecting: not online yet.
  assert.ok(!iface.isOpen);

  chanA._open();
  await connectPromise;

  assert.ok(iface.isOpen);
  await iface.disconnect();
});

test("a Packet round-trips through a paired WebRTC interface", async () => {
  const [chanA, chanB] = createChannelPair();
  const ifaceA = new WebRTCInterface({ channel: chanA });
  const ifaceB = new WebRTCInterface({ channel: chanB });
  chanA._open();
  chanB._open();
  await ifaceA.connect();
  await ifaceB.connect();

  const received = new Promise((resolve) => {
    ifaceB.addEventListener("packet", (/** @type {any} */ event) =>
      resolve(event.detail.packet),
    );
  });

  const packet = buildTestPacket("Hello over WebRTC!");
  await ifaceA.send(packet);

  const got = /** @type {Packet} */ (await received);
  assert.deepEqual(
    Uint8Array.from(got.serialize()),
    Uint8Array.from(packet.serialize()),
    "received packet should match the sent packet byte-for-byte",
  );

  await ifaceA.disconnect();
  await ifaceB.disconnect();
});

test("a channel close dispatches a terminal closed event", async () => {
  const [chanA] = createChannelPair();
  const iface = new WebRTCInterface({ channel: chanA });

  let connected = false;
  iface.addEventListener("connected", () => {
    connected = true;
  });
  chanA._open();
  await iface.connect();
  assert.ok(connected);

  let closed = false;
  iface.addEventListener("closed", () => {
    closed = true;
  });

  // Simulate the remote peer / channel dropping.
  chanA.close();
  await iface._loopPromise; // inbound loop observes the end and dispatches closed

  assert.ok(closed, "interface should fire a terminal closed event");
  assert.ok(!iface.isOpen);
});

test("non-binary and undersized messages are ignored", async () => {
  const [chanA, chanB] = createChannelPair();
  const ifaceA = new WebRTCInterface({ channel: chanA });
  const ifaceB = new WebRTCInterface({ channel: chanB });
  chanA._open();
  chanB._open();
  await ifaceA.connect();
  await ifaceB.connect();

  const packets = [];
  ifaceB.addEventListener("packet", (/** @type {any} */ event) =>
    packets.push(event.detail.packet),
  );

  // A text message (string) must be ignored.
  chanA.send(new TextEncoder().encode("not a packet").buffer);
  // A too-short binary message must be ignored (<= HEADER_MINSIZE = 19).
  chanA.send(new Uint8Array(19).fill(0).buffer);

  // Allow the mock delivery + inbound loop a tick to (not) process them.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(packets.length, 0, "no packets should have been dispatched");

  await ifaceA.disconnect();
  await ifaceB.disconnect();
});
