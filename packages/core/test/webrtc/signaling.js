import assert from "node:assert";
import { test } from "node:test";
import { DestType, Packet, PacketType } from "../../src/core/packet.js";
import { Reticulum } from "../../src/core/reticulum.js";
import { Interface } from "../../src/interfaces/base.js";
import { WebRTCInterface } from "../../src/interfaces/webrtc.js";
import { toHex } from "../../src/utils/encoding.js";
import {
  CAPABILITY_FLAG,
  DEFAULT_DESTINATION_NAME,
  SDP_TYPE_OFFER,
  WebRTCSignaling,
} from "../../src/webrtc/signaling.js";

/**
 * @file signaling.js
 * @description Tests for the WebRTC signaling orchestrator (work doc #19).
 *
 * Node has no native WebRTC, so the orchestrator's dependency-injection seam
 * (`createPeerConnection`) is exercised with a mock `RTCPeerConnection` pair
 * whose negotiation state machine mirrors the real one closely enough to drive
 * the orchestrator end-to-end: `createDataChannel` → `createOffer` →
 * `setLocalDescription` → ICE-gathering-complete → (SDP exchanged over a real
 * Reticulum Link+Resource) → `setRemoteDescription` → data-channel `open`.
 *
 * The two Reticulum instances are bridged by a loopback `Interface` pair so the
 * full announce → link → resource machinery runs for real.
 */

/** How long a helper waits for an async signal before failing the test. */
const HELPER_TIMEOUT_MS = 4000;

// -------------------------------------------------------------------------
// Mock RTCDataChannel + RTCPeerConnection pair
// -------------------------------------------------------------------------

/**
 * Builds a mock `RTCDataChannel` whose lifecycle and message dispatch the
 * orchestrator drives. Channels are paired via {@link pairMockChannels} so
 * `a.send(bytes)` arrives as a `message` event on `b`.
 * @param {string} label
 * @returns {any}
 */
function makeMockChannel(label) {
  /** @type {Map<string, Set<(e: any) => void>>} */
  const listeners = new Map();
  /** @type {any} */
  const ch = {
    label,
    id: Math.floor(Math.random() * 65535),
    binaryType: "arraybuffer",
    readyState: "connecting",
    _peer: null,
    addEventListener(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      /** @type {Set<(e: any) => void>} */ (listeners.get(type)).add(cb);
    },
    removeEventListener(type, cb) {
      /** @type {Set<(e: any) => void> | undefined} */ (
        listeners.get(type)
      )?.delete(cb);
    },
    _dispatch(type, event) {
      for (const cb of /** @type {Set<(e: any) => void>} */ (
        listeners.get(type) ?? []
      ))
        cb(event);
    },
    send(data) {
      if (this.readyState !== "open")
        throw new Error("RTCDataChannel is not open");
      const src = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      const copy = new Uint8Array(/** @type {Uint8Array} */ (src).byteLength);
      copy.set(/** @type {Uint8Array} */ (src));
      // Deliver a fresh ArrayBuffer to the peer (binaryType = "arraybuffer").
      this._peer?._dispatch("message", { data: copy.buffer });
    },
    _open() {
      if (this.readyState === "open") return;
      this.readyState = "open";
      this._dispatch("open", {});
    },
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this._dispatch("close", {});
    },
  };
  return ch;
}

/** Wires two mock channels back-to-back (each one's `send` reaches the other). */
function pairMockChannels(a, b) {
  a._peer = b;
  b._peer = a;
}

/**
 * Builds a pair of mock `RTCPeerConnection`s sharing a coordination `wire`, so
 * that the SDP the orchestrator exchanges over Reticulum drives each side's
 * state transitions exactly like a real WebRTC negotiation.
 *
 * The first PC to call `createDataChannel`/`createOffer` is the offerer; the
 * other becomes the answerer when it calls `setRemoteDescription({type:"offer"})`.
 *
 * @returns {[any, any, {offererChannel: any, answererChannel: any}]}
 */
function createMockPeerConnectionPair() {
  /** Shared coordination state. */
  const wire = { offererChannel: null, answererChannel: null };

  /** @param {string} label */
  const make = (label) => {
    /** @type {Map<string, Set<(e: any) => void>>} */
    const listeners = new Map();
    /** @type {any} */
    const pc = {
      _label: label,
      iceGatheringState: "new",
      localDescription: null,
      remoteDescription: null,
      addEventListener(type, cb) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        /** @type {Set<(e: any) => void>} */ (listeners.get(type)).add(cb);
      },
      removeEventListener(type, cb) {
        /** @type {Set<(e: any) => void> | undefined} */ (
          listeners.get(type)
        )?.delete(cb);
      },
      _dispatch(type, event) {
        for (const cb of /** @type {Set<(e: any) => void>} */ (
          listeners.get(type) ?? []
        ))
          cb(event);
      },
      createDataChannel(chLabel) {
        const ch = makeMockChannel(chLabel);
        wire.offererChannel = ch;
        return ch;
      },
      async createOffer() {
        return {
          type: "offer",
          sdp: `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\n# mock offer from ${label}\r\n`,
        };
      },
      async createAnswer() {
        return {
          type: "answer",
          sdp: `v=0\r\no=- 2 1 IN IP4 0.0.0.0\r\ns=-\r\n# mock answer from ${label}\r\n`,
        };
      },
      async setLocalDescription(desc) {
        pc.localDescription = desc;
        // Simulate ICE gathering completing asynchronously.
        queueMicrotask(() => {
          pc.iceGatheringState = "complete";
          pc._dispatch("icegatheringstatechange", { target: pc });
        });
      },
      async setRemoteDescription(desc) {
        pc.remoteDescription = desc;
        if (desc.type === "offer") {
          // Answerer side: the offer advertises a data channel -> surface it.
          if (!wire.answererChannel) {
            const ch = makeMockChannel("reticulum");
            wire.answererChannel = ch;
            if (wire.offererChannel) pairMockChannels(wire.offererChannel, ch);
          }
          queueMicrotask(() =>
            pc._dispatch("datachannel", { channel: wire.answererChannel }),
          );
        } else if (desc.type === "answer") {
          // Offerer side received the answer -> SCTP association up -> open.
          queueMicrotask(() => {
            wire.offererChannel?._open();
            wire.answererChannel?._open();
          });
        }
      },
      close() {},
    };
    return pc;
  };

  const a = make("mock-a");
  const b = make("mock-b");
  return [a, b, wire];
}

// -------------------------------------------------------------------------
// Loopback Interface pair bridging two Reticulum instances
// -------------------------------------------------------------------------

/**
 * Minimal `Interface` that serializes outbound packets and delivers them to a
 * paired peer's inbound dispatch. Mirrors a real wire (serialize on send,
 * deserialize on receive) so framing bugs surface.
 */
class LoopbackInterface extends Interface {
  /**
   * @param {string} name
   */
  constructor(name) {
    super();
    this.name = name;
    this.bitrate = 1_000_000_000; // never the bottleneck
    this.ifacSize = 0;
    this.online = false;
    this._peer = null;
    // The transport gets a writer for `writable`; outbound packets land here.
    this._writable = new WritableStream({
      write: (/** @type {Packet} */ packet) => {
        const bytes = packet.serialize();
        const inbound = Packet.deserialize(bytes);
        this._peer?._deliverInbound(inbound);
      },
    });
    // Unused by the transport (it reads via "packet" events), but provided for
    // shape completeness.
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
  /** @param {Packet} packet */
  _deliverInbound(packet) {
    this.dispatchEvent(new CustomEvent("packet", { detail: { packet } }));
  }
  async connect() {
    this.online = true;
    this.dispatchEvent(new CustomEvent("connected"));
  }
  async disconnect() {
    this.online = false;
  }
}

/** @returns {[LoopbackInterface, LoopbackInterface]} */
function makeLoopbackPair() {
  const a = new LoopbackInterface("loop-a");
  const b = new LoopbackInterface("loop-b");
  a._peer = b;
  b._peer = a;
  return [a, b];
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * @param {WebRTCSignaling} sig
 * @param {Uint8Array} expectedHash
 * @returns {Promise<any>}
 */
function waitForPeer(sig, expectedHash) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sig.removeEventListener("peer", onPeer);
      reject(new Error("timed out waiting for a matching peer announce"));
    }, HELPER_TIMEOUT_MS);
    const onPeer = (/** @type {any} */ e) => {
      if (toHex(e.detail.destinationHash) === toHex(expectedHash)) {
        clearTimeout(timer);
        sig.removeEventListener("peer", onPeer);
        resolve(e.detail);
      }
    };
    sig.addEventListener("peer", onPeer);
  });
}

/**
 * @param {WebRTCSignaling} sig
 * @returns {Promise<WebRTCInterface>}
 */
function waitForChannel(sig) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sig.removeEventListener("channel", onChannel);
      reject(new Error("timed out waiting for a signaling channel event"));
    }, HELPER_TIMEOUT_MS);
    const onChannel = (/** @type {any} */ e) => {
      clearTimeout(timer);
      sig.removeEventListener("channel", onChannel);
      resolve(e.detail.interface);
    };
    sig.addEventListener("channel", onChannel);
  });
}

/** Builds a minimal valid PLAIN DATA packet. */
function makePlainPacket(payload = "hello over webrtc") {
  return new Packet({
    headerType: 2, // HEADER_1
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

// -------------------------------------------------------------------------
// Unit tests
// -------------------------------------------------------------------------

test("WebRTCSignaling requires a Reticulum instance", () => {
  assert.throws(
    () => new WebRTCSignaling(/** @type {any} */ ({})),
    /requires a Reticulum instance/,
  );
});

test("WebRTCSignaling defaults to the shared destination name", () => {
  const rns = new Reticulum({});
  const sig = new WebRTCSignaling({ rns });
  assert.strictEqual(sig.destinationName, DEFAULT_DESTINATION_NAME);
  assert.strictEqual(sig.announceOnInit, true);
});

test("app_data capability flag is exactly 0x01 by default", () => {
  const rns = new Reticulum({});
  const sig = new WebRTCSignaling({ rns });
  assert.deepStrictEqual(
    sig._buildAppData(),
    new Uint8Array([CAPABILITY_FLAG]),
  );
});

test("extraAppData is appended after the capability flag", () => {
  const rns = new Reticulum({});
  const sig = new WebRTCSignaling({
    rns,
    extraAppData: new Uint8Array([0xaa, 0xbb]),
  });
  assert.deepStrictEqual(
    sig._buildAppData(),
    new Uint8Array([CAPABILITY_FLAG, 0xaa, 0xbb]),
  );
});

test("SDP framing round-trips offer and answer payloads", () => {
  const rns = new Reticulum({});
  const sig = new WebRTCSignaling({ rns });
  const offer = "v=0\r\no=- 1\r\ns=-\r\n";
  const framed = new Uint8Array([
    SDP_TYPE_OFFER,
    ...new TextEncoder().encode(offer),
  ]);
  const parsed = sig._parseSDP(framed);
  assert.ok(parsed);
  assert.strictEqual(parsed.type, SDP_TYPE_OFFER);
  assert.strictEqual(parsed.sdp, offer);
  // Invalid inputs are rejected.
  assert.strictEqual(sig._parseSDP(/** @type {any} */ (null)), null);
  assert.strictEqual(sig._parseSDP(new Uint8Array(0)), null);
});

test("connect() rejects before start()", async () => {
  const rns = new Reticulum({});
  const [pcA] = createMockPeerConnectionPair();
  const sig = new WebRTCSignaling({ rns, createPeerConnection: () => pcA });
  await assert.rejects(
    sig.connect(new Uint8Array(16)),
    /start\(\) must be called/,
  );
});

test("connect() rejects when no RTCPeerConnection factory is available", async () => {
  const rns = new Reticulum({});
  // No createPeerConnection, and Node has no global RTCPeerConnection.
  const sig = new WebRTCSignaling({ rns });
  await sig.start();
  await assert.rejects(
    sig.connect(new Uint8Array(16)),
    /No RTCPeerConnection available/,
  );
  sig.stop();
});

test("start() generates an identity and binds the destination to the transport", async () => {
  const rns = new Reticulum({});
  const sig = new WebRTCSignaling({ rns });
  await sig.start();
  assert.ok(sig.identity, "an identity should be generated");
  assert.ok(sig.destination, "the signaling destination should be created");
  assert.deepStrictEqual(
    sig.destination.appData,
    new Uint8Array([CAPABILITY_FLAG]),
  );
  // The destination is bound to the transport so inbound LINKREQUESTs reach it.
  const hashHex = toHex(
    /** @type {Uint8Array} */ (sig.destination.destinationHash),
  );
  assert.ok(
    rns.transport.localDestinations.has(hashHex),
    "destination must be bound to the transport",
  );
  sig.stop();
  assert.ok(
    !rns.transport.localDestinations.has(hashHex),
    "stop() unbinds the destination",
  );
});

// -------------------------------------------------------------------------
// End-to-end: two instances, full announce -> link -> SDP -> WebRTC flow
// -------------------------------------------------------------------------

test("end-to-end: announce, link, SDP exchange, packet over WebRTC", async () => {
  const rnsA = new Reticulum({});
  const rnsB = new Reticulum({});
  const [loopA, loopB] = makeLoopbackPair();
  await loopA.connect();
  await loopB.connect();
  rnsA.addInterface(loopA, true);
  rnsB.addInterface(loopB, true);

  const [pcA, pcB] = createMockPeerConnectionPair();
  const sigA = new WebRTCSignaling({
    rns: rnsA,
    createPeerConnection: () => pcA,
    iceGatheringTimeoutMs: 200,
  });
  const sigB = new WebRTCSignaling({
    rns: rnsB,
    createPeerConnection: () => pcB,
    iceGatheringTimeoutMs: 200,
  });
  await sigA.start();
  await sigB.start();

  // Each side should hear the other's capability announce.
  const peerB = await waitForPeer(
    sigA,
    /** @type {Uint8Array} */ (sigB.destination.destinationHash),
  );
  assert.ok(peerB.identity, "peer event carries the reconstructed identity");

  // A initiates; the resulting WebRTC interface is returned, and B fires a
  // symmetric "channel" event with its own interface.
  const channelOnB = waitForChannel(sigB);
  const ifaceA = await sigA.connect(peerB.destinationHash);
  assert.ok(
    ifaceA instanceof WebRTCInterface,
    "connect returns a WebRTCInterface",
  );
  const ifaceB = await channelOnB;
  assert.ok(ifaceB instanceof WebRTCInterface);

  // A packet written onto A's data channel must arrive as a "packet" event on
  // B's WebRTC interface — the real end-to-end data path through the channel
  // signaling established. Going via the interface's own channel (not the
  // transport) isolates the WebRTC data path from transport routing.
  const probe = makePlainPacket("hello over webrtc");
  /** @type {Promise<Packet>} */
  const received = new Promise((resolve) => {
    ifaceB.addEventListener("packet", (/** @type {any} */ e) => {
      resolve(e.detail.packet);
    });
  });
  // The interface stores the underlying channel; sending on it puts bytes on
  // the wire exactly as the interface's outbound stream would.
  /** @type {{send: (d: any) => void}} */ (ifaceA.channel).send(
    probe.serialize(),
  );
  const got = await received;
  assert.deepStrictEqual(got.payload, probe.payload);

  sigA.stop();
  sigB.stop();
});

test("announces only when told to (announceOnInit: false)", async () => {
  const rnsA = new Reticulum({});
  const rnsB = new Reticulum({});
  const [loopA, loopB] = makeLoopbackPair();
  await loopA.connect();
  await loopB.connect();
  rnsA.addInterface(loopA, true);
  rnsB.addInterface(loopB, true);

  const [pcA] = createMockPeerConnectionPair();
  const sigA = new WebRTCSignaling({
    rns: rnsA,
    createPeerConnection: () => pcA,
    announceOnInit: false,
  });
  const sigB = new WebRTCSignaling({ rns: rnsB });
  await sigA.start();
  await sigB.start();

  // B should NOT hear A until A announces explicitly. waitForPeer rejects on
  // timeout; we expect that rejection here.
  await assert.rejects(
    waitForPeer(
      sigB,
      /** @type {Uint8Array} */ (sigA.destination.destinationHash),
    ),
    /timed out/,
  );

  await sigA.announce();
  const peer = await waitForPeer(
    sigB,
    /** @type {Uint8Array} */ (sigA.destination.destinationHash),
  );
  assert.ok(peer.identity);

  sigA.stop();
  sigB.stop();
});
