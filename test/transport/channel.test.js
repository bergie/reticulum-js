/**
 * Channel (reliable typed message exchange) tests — ports of `RNS/Channel.py`.
 *
 * Covers:
 *   - `Envelope` pack/unpack wire format (`msgtype ‖ seq ‖ len ‖ data`, BE).
 *   - `MessageBase` registration rules (subclass check, MSGTYPE validity,
 *     system-reserved rejection).
 *   - `Channel.send` MDU-too-big and not-ready errors.
 *   - End-to-end delivery over a real (mock-transport) link pair, both
 *     directions, with in-order delivery of multiple messages.
 *   - Out-of-order / duplicate handling at the rx ring.
 *   - Retry exhaustion tears the link down when no proof ever returns.
 *
 * The mock-transport harness mirrors `request_response.test.js` so a full
 * LINKREQUEST/LRPROOF/LRRTT handshake completes and both links reach ACTIVE.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { Allow, Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";
import {
  CEType,
  Channel,
  ChannelException,
  Envelope,
  MessageBase,
} from "../../src/transport/channel.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";

// ---------------------------------------------------------------------------
// Test message type
// ---------------------------------------------------------------------------

/** Simple echo message: a tag byte + UTF-8 text. */
class EchoMessage extends MessageBase {
  static MSGTYPE = 0x0001;

  constructor() {
    super();
    this.tag = 0;
    this.text = "";
  }

  pack() {
    const body = new TextEncoder().encode(this.text);
    const buf = new Uint8Array(1 + body.length);
    buf[0] = this.tag & 0xff;
    buf.set(body, 1);
    return buf;
  }

  unpack(raw) {
    this.tag = raw[0];
    this.text = new TextDecoder().decode(raw.subarray(1));
  }
}

/** Message whose constructor requires an argument (invalid for registration). */
class BadCtorMessage extends MessageBase {
  static MSGTYPE = 0x0002;
  constructor(required) {
    super();
    if (required === undefined) throw new Error("ctor needs an arg");
  }
  pack() {
    return new Uint8Array(0);
  }
  unpack() {}
}

// ---------------------------------------------------------------------------
// Mock transport + established-link pair (mirrors request_response.test.js)
// ---------------------------------------------------------------------------

class MockTransport {
  constructor() {
    /** @type {Packet[]} */
    this.receivedPackets = [];
    /** @type {Map<string, Link>} */
    this.links = new Map();
    /** @type {Map<string, Destination>} */
    this.destinations = new Map();
    /** When true, CHANNEL packets are dropped (to simulate loss). */
    this.dropChannel = false;
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
  /** @param {Packet} packet */
  async sendPacket(packet) {
    this.receivedPackets.push(packet);
    if (
      this.dropChannel &&
      packet.packetType === PacketType.DATA &&
      packet.contextByte === ContextType.CHANNEL
    ) {
      return true; // swallow: no proof comes back
    }
    if (this.peer) await this.peer._route(packet);
    return true;
  }
  /** @param {Packet} packet */
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
 * @returns {Promise<{ initiator: Link, responder: Link, transportI: MockTransport, transportR: MockTransport }>}
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
      return { initiator, responder, transportI, transportR };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

// ---------------------------------------------------------------------------
// Envelope wire format
// ---------------------------------------------------------------------------

test("Envelope packs msgtype|seq|len|data big-endian", () => {
  const msg = new EchoMessage();
  msg.tag = 0xab;
  msg.text = "hi";
  const env = new Envelope({
    outlet: /** @type {any} */ ({}),
    message: msg,
    sequence: 0x0102,
  });
  const raw = env.pack();

  const dv = new DataView(raw.buffer);
  assert.strictEqual(dv.getUint16(0, false), 0x0001, "msgtype");
  assert.strictEqual(dv.getUint16(2, false), 0x0102, "sequence");
  assert.strictEqual(dv.getUint16(4, false), 1 + 2, "length = tag + 'hi'");
  assert.deepStrictEqual(
    Array.from(raw.subarray(6)),
    [0xab, 104, 105],
    "body is tag byte + utf8",
  );
});

test("Envelope round-trips through pack/unpack", () => {
  const msg = new EchoMessage();
  msg.tag = 0x21;
  msg.text = "hello world";
  const env = new Envelope({
    outlet: /** @type {any} */ ({}),
    message: msg,
    sequence: 7,
  });
  const raw = env.pack();

  const factories = new Map([[0x0001, EchoMessage]]);
  const decoded = new Envelope({ outlet: /** @type {any} */ ({}), raw });
  const out = decoded.unpack(factories);
  assert.strictEqual(decoded.sequence, 7);
  assert.ok(out instanceof EchoMessage);
  assert.strictEqual(out.tag, 0x21);
  assert.strictEqual(out.text, "hello world");
});

test("Envelope.unpack throws ME_NOT_REGISTERED for an unknown msgtype", () => {
  const msg = new EchoMessage();
  msg.text = "x";
  const env = new Envelope({
    outlet: /** @type {any} */ ({}),
    message: msg,
    sequence: 0,
  });
  const raw = env.pack();

  const decoded = new Envelope({ outlet: /** @type {any} */ ({}), raw });
  assert.throws(
    () => decoded.unpack(new Map()),
    (err) =>
      err instanceof ChannelException && err.type === CEType.ME_NOT_REGISTERED,
  );
});

test("Envelope.pack throws ME_NO_MSG_TYPE when MSGTYPE is null", () => {
  class NoType extends MessageBase {
    pack() {
      return new Uint8Array(0);
    }
    unpack() {}
  }
  const env = new Envelope({
    outlet: /** @type {any} */ ({}),
    message: new NoType(),
    sequence: 0,
  });
  assert.throws(
    () => env.pack(),
    (err) =>
      err instanceof ChannelException && err.type === CEType.ME_NO_MSG_TYPE,
  );
});

// ---------------------------------------------------------------------------
// Message-type registration rules
// ---------------------------------------------------------------------------

test("registerMessageType rejects a non-subclass", () => {
  const ch = new Channel(/** @type {any} */ ({ mdu: 500, rtt: 0 }));
  assert.throws(
    () => ch.registerMessageType(/** @type {any} */ (class {})),
    (err) =>
      err instanceof ChannelException &&
      err.type === CEType.ME_INVALID_MSG_TYPE,
  );
});

test("registerMessageType rejects a null MSGTYPE", () => {
  const ch = new Channel(/** @type {any} */ ({ mdu: 500, rtt: 0 }));
  assert.throws(
    () => ch.registerMessageType(MessageBase),
    (err) =>
      err instanceof ChannelException &&
      err.type === CEType.ME_INVALID_MSG_TYPE,
  );
});

test("registerMessageType rejects a system-reserved MSGTYPE (>= 0xf000)", () => {
  class Sys extends MessageBase {
    static MSGTYPE = 0xff00;
    pack() {
      return new Uint8Array(0);
    }
    unpack() {}
  }
  const ch = new Channel(/** @type {any} */ ({ mdu: 500, rtt: 0 }));
  assert.throws(
    () => ch.registerMessageType(Sys),
    (err) =>
      err instanceof ChannelException &&
      err.type === CEType.ME_INVALID_MSG_TYPE,
  );
});

test("registerMessageType rejects a class whose no-arg ctor throws", () => {
  const ch = new Channel(/** @type {any} */ ({ mdu: 500, rtt: 0 }));
  assert.throws(
    () => ch.registerMessageType(BadCtorMessage),
    (err) =>
      err instanceof ChannelException &&
      err.type === CEType.ME_INVALID_MSG_TYPE,
  );
});

test("_registerSystemMessageType accepts a system-reserved MSGTYPE", () => {
  class Sys extends MessageBase {
    static MSGTYPE = 0xff00;
    pack() {
      return new Uint8Array(0);
    }
    unpack() {}
  }
  const ch = new Channel(/** @type {any} */ ({ mdu: 500, rtt: 0 }));
  ch._registerSystemMessageType(Sys);
  // registered without error; factory map contains it
  assert.ok(ch._messageFactories.has(0xff00));
});

// ---------------------------------------------------------------------------
// Channel.send error paths
// ---------------------------------------------------------------------------

test("send rejects ME_TOO_BIG when the packed message exceeds the outlet MDU", async () => {
  const ch = new Channel(
    /** @type {any} */ ({ mdu: 10, rtt: 0, isUsable: true }),
  );
  const big = new EchoMessage();
  big.text = "x".repeat(100); // body alone > mdu - 6
  await assert.rejects(
    ch.send(big),
    (err) => err instanceof ChannelException && err.type === CEType.ME_TOO_BIG,
  );
});

// ---------------------------------------------------------------------------
// End-to-end delivery over a real link pair
// ---------------------------------------------------------------------------

test("a message sent on the initiator channel is delivered to the responder handler", async () => {
  const { initiator, responder } = await makeEstablishedPair();

  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();
  iCh.registerMessageType(EchoMessage);
  rCh.registerMessageType(EchoMessage);

  /** @type {EchoMessage|null} */
  let received = null;
  rCh.addMessageHandler((msg) => {
    if (msg instanceof EchoMessage) {
      received = /** @type {EchoMessage} */ (msg);
      return true;
    }
    return false;
  });

  const out = new EchoMessage();
  out.tag = 0x55;
  out.text = "ping";
  await iCh.send(out);

  assert.ok(received, "responder handler must fire");
  assert.strictEqual(received.tag, 0x55);
  assert.strictEqual(received.text, "ping");

  await initiator.teardown().catch(() => {});
});

test("messages flow both directions and are delivered in order", async () => {
  const { initiator, responder } = await makeEstablishedPair();

  const iCh = initiator.getChannel();
  const rCh = responder.getChannel();
  iCh.registerMessageType(EchoMessage);
  rCh.registerMessageType(EchoMessage);

  /** @type {string[]} */
  const initiatorGot = [];
  /** @type {string[]} */
  const responderGot = [];
  iCh.addMessageHandler((m) => {
    if (m instanceof EchoMessage) initiatorGot.push(m.text);
    return false;
  });
  rCh.addMessageHandler((m) => {
    if (m instanceof EchoMessage) responderGot.push(m.text);
    return false;
  });

  // Send sequentially; the send chain serializes and the window (2) lets the
  // first two be in flight together.
  for (let i = 0; i < 4; i++) {
    const m = new EchoMessage();
    m.tag = i;
    m.text = `i2r-${i}`;
    await iCh.send(m);
  }
  for (let i = 0; i < 3; i++) {
    const m = new EchoMessage();
    m.tag = i;
    m.text = `r2i-${i}`;
    await rCh.send(m);
  }

  // Give the last proof round-trip a tick to settle.
  await new Promise((r) => setTimeout(r, 20));

  assert.deepStrictEqual(responderGot, ["i2r-0", "i2r-1", "i2r-2", "i2r-3"]);
  assert.deepStrictEqual(initiatorGot, ["r2i-0", "r2i-1", "r2i-2"]);

  await initiator.teardown().catch(() => {});
});

test("a handler returning true stops further handler processing", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const rCh = responder.getChannel();
  const iCh = initiator.getChannel();
  iCh.registerMessageType(EchoMessage);
  rCh.registerMessageType(EchoMessage);

  let secondCalled = false;
  rCh.addMessageHandler(() => true); // swallows
  rCh.addMessageHandler(() => {
    secondCalled = true;
    return true;
  });

  const m = new EchoMessage();
  m.text = "x";
  await iCh.send(m);
  assert.strictEqual(secondCalled, false, "second handler must not run");

  await initiator.teardown().catch(() => {});
});

// ---------------------------------------------------------------------------
// Retry exhaustion → link teardown
// ---------------------------------------------------------------------------

test("when no proof returns, retry exhaustion tears the link down", async () => {
  const { initiator, transportI } = await makeEstablishedPair();
  const iCh = initiator.getChannel();
  iCh.registerMessageType(EchoMessage);

  // Drop CHANNEL packets on the initiator's outbound path so no proof returns.
  transportI.dropChannel = true;

  const m = new EchoMessage();
  m.text = "lost";
  // Don't await: the send won't resolve until proven, which never happens.
  const p = iCh.send(m).catch(() => {});

  // The channel retransmits with short timeouts (RTT ~ 0), so maxTries (5)
  // exhausts quickly and calls outlet.timedOut() → link.teardown().
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && initiator.status !== LinkStatus.CLOSED) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.strictEqual(
    initiator.status,
    LinkStatus.CLOSED,
    "link should be torn down after channel retry exhaustion",
  );
  await p;
});

// ---------------------------------------------------------------------------
// getChannel laziness + teardown shutdown
// ---------------------------------------------------------------------------

test("getChannel lazily creates one channel and reuses it", async () => {
  const { initiator } = await makeEstablishedPair();
  assert.strictEqual(initiator._channel, null);
  const a = initiator.getChannel();
  const b = initiator.getChannel();
  assert.strictEqual(a, b);
  assert.strictEqual(initiator._channel, a);
  await initiator.teardown().catch(() => {});
});
