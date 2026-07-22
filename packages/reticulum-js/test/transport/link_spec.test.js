/**
 * Wire-format compliance tests for the Reticulum Link protocol (LINKS.md §6).
 *
 * Each test verifies a specific on-the-wire invariant derived from the Python
 * reference implementation (`RNS/Link.py`, `RNS/Packet.py`). The consolidated
 * Link implementation lives in `src/transport/link.js`; these tests pin its
 * public behaviour and the on-the-wire byte layouts.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import {
  isLinkPacketUnencrypted,
  Link,
  LinkStatus,
  linkIdFromLrPacket,
} from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";
import { MicroMsgPack } from "../../src/utils/msgpack.js";

/**
 * Mock transport that doubles as a tiny router: when sendPacket is called it
 * records the packet and dispatches it to the registered Link or Destination
 * matching the packet's destinationHash. This mirrors how a real TransportCore
 * routes inbound packets, so handshakes complete without fragile closure timing.
 */
class MockTransport {
  constructor() {
    /** @type {Packet[]} */
    this.receivedPackets = [];
    /** @type {Map<string, Link>} */
    this.links = new Map();
    /** @type {Map<string, Destination>} */
    this.destinations = new Map();
    /** Optional peer transport to forward every sent packet to. */
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
  /**
   * Forwards the packet to the peer transport, which routes it locally.
   * @param {Packet} packet
   */
  async sendPacket(packet) {
    this.receivedPackets.push(packet);
    if (this.peer) await this.peer._route(packet);
    return true;
  }
  /**
   * Local dispatch: link table first, then destinations.
   * @param {Packet} packet
   */
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.links.has(dh)) {
      await this.links.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      const dest = this.destinations.get(dh);
      // Destinations create a link on LINKREQUEST, otherwise drop.
      if (packet.packetType === PacketType.LINKREQUEST) {
        const link = await Link.accept(dest, this, packet);
        this.addLink(link.linkId, link);
      }
    }
  }
}

/** @param {Identity} identity @returns {Promise<Uint8Array>} */
async function ed25519Pub(identity) {
  return (await identity.getPublicKey()).subarray(32, 64);
}
/** @param {Identity} identity @returns {Promise<Uint8Array>} */
async function x25519Pub(identity) {
  return (await identity.getPublicKey()).subarray(0, 32);
}

// ---------------------------------------------------------------------------
// §6.6.1  Signalling bytes encode / decode
// ---------------------------------------------------------------------------

test("§6.6.1 signallingBytes encodes mode + mtu as 3-byte big-endian", () => {
  // RNS/Link.py:148-152. mode=1, mtu=500 -> 0x2001F4 -> bytes 20 01 f4
  const sig = Link.signallingBytes(500, 0x01);
  assert.strictEqual(sig.length, 3);
  assert.deepStrictEqual(Array.from(sig), [0x20, 0x01, 0xf4]);
});

test("§6.6.1 signallingBytes round-trips mode and mtu", () => {
  for (const { mtu, mode } of [
    { mtu: 500, mode: 0x01 },
    { mtu: 508, mode: 0x01 },
    { mtu: 0x1fffff, mode: 0x01 },
    { mtu: 1, mode: 0x01 },
  ]) {
    const sig = Link.signallingBytes(mtu, mode);
    const decMode = (sig[0] & 0xe0) >> 5;
    const decMtu = (((sig[0] << 16) + (sig[1] << 8) + sig[2]) & 0x1fffff) >>> 0;
    assert.strictEqual(decMode, mode, `mode round-trip for mtu=${mtu}`);
    assert.strictEqual(decMtu, mtu, `mtu round-trip for mtu=${mtu}`);
  }
});

// ---------------------------------------------------------------------------
// §6.7.1  isLinkPacketUnencrypted matches RNS/Packet.py pack()
// ---------------------------------------------------------------------------

test("§6.7.1 isLinkPacketUnencrypted matches Python pack() not-encrypted set", () => {
  // Unencrypted on a LINK destination (RNS/Packet.py:186-212)
  assert.ok(
    isLinkPacketUnencrypted(PacketType.PROOF, ContextType.NONE),
    "link PROOF (NONE) is unencrypted",
  );
  assert.ok(
    isLinkPacketUnencrypted(PacketType.PROOF, ContextType.RESOURCE_PRF),
    "RESOURCE_PRF is unencrypted",
  );
  assert.ok(
    isLinkPacketUnencrypted(PacketType.DATA, ContextType.RESOURCE),
    "RESOURCE is unencrypted",
  );
  assert.ok(
    isLinkPacketUnencrypted(PacketType.DATA, ContextType.KEEPALIVE),
    "KEEPALIVE is unencrypted",
  );
  assert.ok(
    isLinkPacketUnencrypted(PacketType.DATA, ContextType.CACHE_REQUEST),
    "CACHE_REQUEST is unencrypted",
  );

  // Must be encrypted (the bug previously left these unencrypted)
  for (const [name, ctx] of [
    ["RESOURCE_ADV", ContextType.RESOURCE_ADV],
    ["RESOURCE_REQ", ContextType.RESOURCE_REQ],
    ["RESOURCE_HMU", ContextType.RESOURCE_HMU],
    ["RESOURCE_ICL", ContextType.RESOURCE_ICL],
    ["RESOURCE_RCL", ContextType.RESOURCE_RCL],
    ["LINKIDENTIFY", ContextType.LINKIDENTIFY],
    ["LINKCLOSE", ContextType.LINKCLOSE],
    ["LRRTT", ContextType.LRRTT],
    ["CHANNEL", ContextType.CHANNEL],
    ["REQUEST", ContextType.REQUEST],
    ["RESPONSE", ContextType.RESPONSE],
    ["NONE DATA", ContextType.NONE],
  ]) {
    assert.ok(
      !isLinkPacketUnencrypted(PacketType.DATA, ctx),
      `${name} must be Token-encrypted`,
    );
  }
});

// ---------------------------------------------------------------------------
// §6.4.2  LRRTT body is a single msgpack float64 (9 bytes)
// ---------------------------------------------------------------------------

test("§6.4.2 msgpack float64 is 9 bytes starting with 0xcb", () => {
  const encoded = MicroMsgPack.encode(0.15);
  assert.strictEqual(encoded.length, 9);
  assert.strictEqual(encoded[0], 0xcb);
  assert.strictEqual(MicroMsgPack.decode(encoded), 0.15);
});

// ---------------------------------------------------------------------------
// Full handshake: initiator ↔ responder over a pair of mock transports.
// This is the central interop test — it exercises every fixed bug at once:
//   LINKREQUEST → link_id derivation → LRPROOF (correct signed_data) →
//   LRRTT (msgpack float64, encrypted) → both sides ACTIVE.
// ---------------------------------------------------------------------------

/**
 * Wires two MockTransports back-to-back so sendPacket on one is delivered to
 * the other's "incoming" side. Each side's onPacketReceived routes the packet
 * to the correct local target (a Destination or a Link).
 *
 * @param {object} side
 * @param {MockTransport} side.transport
 * @param {Destination} [side.destination]
 * @param {() => Link|undefined} [side.linkFor] resolve a link by destinationHash
 * @param {(packet: Packet) => void} [side.onSend]
 */
function wirePeer(side) {
  side.transport.onPacketReceived = (packet) => {
    side.onSend?.(packet);
  };
}

test("full handshake: initiate → accept → LRPROOF → LRRTT → both ACTIVE", async () => {
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

  // Initiator OUT destination whose identity IS the responder's (known from announce).
  const initiatorDest = await Destination.create(
    "responder",
    Direction.OUT,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: transportI }),
  );

  const initiatorLink = await Link.initiate(initiatorDest, transportI);
  // With the synchronous mock transport the handshake may already have
  // completed by the time initiate returns; just sanity-check we're past PENDING.
  assert.ok(initiatorLink.status >= LinkStatus.HANDSHAKE);

  // Wait deterministically for both legs to reach ACTIVE.
  await awaitActive(initiatorLink, () => [...transportR.links.values()][0]);

  const responderLink = [...transportR.links.values()][0];
  assert.ok(responderLink, "responder link should be registered on accept");

  assert.strictEqual(
    initiatorLink.status,
    LinkStatus.ACTIVE,
    "initiator must be ACTIVE after LRPROOF validation",
  );
  assert.strictEqual(
    responderLink.status,
    LinkStatus.ACTIVE,
    "responder must be ACTIVE after LRRTT",
  );

  // Session keys agree: a Token-encrypted round trip works.
  const secret = new TextEncoder().encode("link secret");
  const ct = await initiatorLink.token.encrypt(secret);
  assert.deepStrictEqual(
    Array.from(await responderLink.token.decrypt(ct)),
    Array.from(secret),
    "both sides must derive identical session keys",
  );
});

// ---------------------------------------------------------------------------
// §6.2  LRPROOF signed_data on the wire (responder emit)
// ---------------------------------------------------------------------------

test("§6.2 responder LRPROOF body = signature(64) || r_X25519(32) || signalling(3) = 99 bytes", async () => {
  const responderIdentity = await Identity.generate();
  const transport = new MockTransport();
  const dest = await Destination.create(
    "r",
    Direction.IN,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport }),
  );

  // Build a LINKREQUEST with signalling so the responder emits a 99-byte proof.
  const initiatorX25519 = await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  );
  const initiatorEd = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const body = new Uint8Array(67);
  body.set(
    new Uint8Array(
      await crypto.subtle.exportKey("raw", initiatorX25519.publicKey),
    ),
    0,
  );
  body.set(
    new Uint8Array(await crypto.subtle.exportKey("raw", initiatorEd.publicKey)),
    32,
  );
  body.set(Link.signallingBytes(500, 0x01), 64);

  const req = new Packet({
    headerType: HeaderType.HEADER_1,
    destinationType: DestType.SINGLE,
    packetType: PacketType.LINKREQUEST,
    destinationHash: dest.destinationHash,
    payload: body,
  });
  req.raw = req.serialize();

  const link = await Link.accept(dest, transport, req);

  // First packet emitted by the responder is the LRPROOF.
  const lrproof = transport.receivedPackets.find(
    (p) => p.contextByte === ContextType.LRPROOF,
  );
  assert.ok(lrproof, "responder must emit an LRPROOF");
  assert.strictEqual(lrproof.payload.length, 99);

  const signature = lrproof.payload.subarray(0, 64);
  const responderX25519 = lrproof.payload.subarray(64, 96);
  const signalling = lrproof.payload.subarray(96, 99);

  assert.deepStrictEqual(
    Array.from(responderX25519),
    Array.from(link.ephemeralX25519Pub),
  );

  // Reconstruct signed_data and validate with the responder identity.
  const rEd = await ed25519Pub(responderIdentity);
  const signedData = new Uint8Array(16 + 32 + 32 + 3);
  signedData.set(link.linkId, 0);
  signedData.set(responderX25519, 16);
  signedData.set(rEd, 48);
  signedData.set(signalling, 80);

  assert.ok(
    await responderIdentity.validate(signature, signedData),
    "LRPROOF signature must validate over link_id || r_X25519 || r_Ed25519 || signalling",
  );
});

// ---------------------------------------------------------------------------
// §6.5  Regular link DATA proof (96-byte explicit form, addressed to link_id)
// ---------------------------------------------------------------------------

test("§6.5 link DATA proof is 96 bytes addressed to link_id and signs the packet hash", async () => {
  const { initiator, responder } = await makeEstablishedPair();

  // Build the encrypted wire-form DATA packet the way Link.send would, then
  // deliver it to the responder. The proof signs this exact wire packet's
  // hashable part (§6.5).
  const dataPayload = new TextEncoder().encode("hello over link");
  const wireData = await initiator.token.encrypt(dataPayload);
  const incomingData = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.LINK,
    destinationHash: initiator.linkId,
    contextByte: ContextType.NONE,
    payload: wireData,
  });
  incomingData.raw = incomingData.serialize();
  const expectedHash = await incomingData.getHash();

  const responderTransport = /** @type {MockTransport} */ (responder.transport);
  responderTransport.receivedPackets.length = 0;
  await responder.receive(incomingData);

  const proof = responderTransport.receivedPackets.find(
    (p) =>
      p.packetType === PacketType.PROOF && p.contextByte === ContextType.NONE,
  );
  assert.ok(proof, "responder must emit a link DATA proof");
  assert.strictEqual(proof.payload.length, 96);
  assert.deepStrictEqual(
    Array.from(proof.destinationHash),
    Array.from(initiator.linkId),
  );
  assert.deepStrictEqual(
    Array.from(proof.payload.subarray(0, 32)),
    Array.from(expectedHash),
    "proof body[0:32] must be SHA256(get_hashable_part(wire DATA packet))",
  );
});

// ---------------------------------------------------------------------------
// §6.5  Link DATA proof RESOLUTION (initiator / responder sides)
// ---------------------------------------------------------------------------

test("§6.5 initiator resolves a proof for DATA it sent over the link", async () => {
  const { initiator } = await makeEstablishedPair();

  /** @type {any} */
  let proof = null;
  initiator.addEventListener("proof", (event) => {
    proof = /** @type {CustomEvent} */ (event).detail;
  });

  await initiator.send(
    new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: initiator.linkId,
      contextByte: ContextType.NONE,
      payload: new TextEncoder().encode("hello over link"),
    }),
  );

  assert.ok(proof, "initiator should receive a proof event");
  assert.strictEqual(proof.verified, true);
  assert.ok(proof.packetHash instanceof Uint8Array);
  assert.strictEqual(proof.packetHash.length, 32);
  assert.strictEqual(
    initiator._pendingLinkProofs.size,
    0,
    "the tracked outbound packet must be resolved",
  );
});

test("§6.5 responder resolves a proof for DATA it sent (reverse direction)", async () => {
  const { responder } = await makeEstablishedPair();

  /** @type {any} */
  let proof = null;
  responder.addEventListener("proof", (event) => {
    proof = /** @type {CustomEvent} */ (event).detail;
  });

  await responder.send(
    new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: responder.linkId,
      contextByte: ContextType.NONE,
      payload: new TextEncoder().encode("reply over link"),
    }),
  );

  assert.ok(proof, "responder should receive a proof event");
  assert.strictEqual(proof.verified, true);
  assert.strictEqual(responder._pendingLinkProofs.size, 0);
});

test("§6.5 link drops a proof with a bad signature", async () => {
  const { initiator } = await makeEstablishedPair();
  let fired = false;
  initiator.addEventListener("proof", () => {
    fired = true;
  });

  const forgedHash = crypto.getRandomValues(new Uint8Array(32));
  const badSig = crypto.getRandomValues(new Uint8Array(64));
  const payload = new Uint8Array(96);
  payload.set(forgedHash, 0);
  payload.set(badSig, 32);
  const forged = new Packet({
    packetType: PacketType.PROOF,
    destinationType: DestType.LINK,
    destinationHash: initiator.linkId,
    contextByte: ContextType.NONE,
    payload,
  });
  forged.raw = forged.serialize();
  await initiator.receive(forged);

  assert.strictEqual(
    fired,
    false,
    "a forged proof must not fire a proof event",
  );
});

test("§6.5 link drops an implicit-form (64-byte) proof", async () => {
  const { initiator } = await makeEstablishedPair();
  let fired = false;
  initiator.addEventListener("proof", () => {
    fired = true;
  });

  // Links only accept the explicit 96-byte form (§6.5.2); a 64-byte body is
  // the wrong length and must be dropped.
  const implicit = new Packet({
    packetType: PacketType.PROOF,
    destinationType: DestType.LINK,
    destinationHash: initiator.linkId,
    contextByte: ContextType.NONE,
    payload: crypto.getRandomValues(new Uint8Array(64)),
  });
  implicit.raw = implicit.serialize();
  await initiator.receive(implicit);

  assert.strictEqual(fired, false);
});

// ---------------------------------------------------------------------------
// §6.7.1  KEEPALIVE ping/pong
// ---------------------------------------------------------------------------

test("§6.7.1 responder answers 0xFF ping with 0xFE pong", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const responderTransport = /** @type {MockTransport} */ (responder.transport);
  responderTransport.receivedPackets.length = 0;

  // KEEPALIVE is unencrypted: a raw 0xFF byte on the wire.
  await responder.receive(
    new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: initiator.linkId,
      contextByte: ContextType.KEEPALIVE,
      payload: new Uint8Array([0xff]),
    }),
  );

  const pong = responderTransport.receivedPackets.find(
    (p) =>
      p.contextByte === ContextType.KEEPALIVE &&
      p.payload.length === 1 &&
      p.payload[0] === 0xfe,
  );
  assert.ok(
    pong,
    "responder MUST answer 0xFF with 0xFE (RNS/Link.py:1149-1153)",
  );
});

// ---------------------------------------------------------------------------
// §6.7.3  LINKCLOSE authenticates by body == link_id and closes the link
// ---------------------------------------------------------------------------

test("§6.7.3 teardown sends an encrypted LINKCLOSE and peer closes", async () => {
  const { initiator, responder } = await makeEstablishedPair();

  let responderClosed = false;
  responder.addEventListener("close", () => {
    responderClosed = true;
  });

  // initiator tears down -> encrypted LINKCLOSE delivered to responder
  await initiator.teardown();
  assert.strictEqual(initiator.status, LinkStatus.CLOSED);

  await new Promise((r) => setTimeout(r, 10));
  assert.ok(responderClosed, "responder must observe the close");
  assert.strictEqual(responder.status, LinkStatus.CLOSED);
});

test("§6.7.3 a LINKCLOSE whose body != link_id is ignored", async () => {
  const { responder, initiator } = await makeEstablishedPair();
  // Craft an encrypted LINKCLOSE whose plaintext is NOT the link_id.
  const bogus = await responder.token.encrypt(new Uint8Array(16).fill(0x01));
  await responder.receive(
    new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: initiator.linkId,
      contextByte: ContextType.LINKCLOSE,
      payload: bogus,
    }),
  );
  assert.notStrictEqual(
    responder.status,
    LinkStatus.CLOSED,
    "forged LINKCLOSE must not close the link",
  );
});

// ---------------------------------------------------------------------------
// §6.7.6  LINKIDENTIFY round-trips a remote identity
// ---------------------------------------------------------------------------

test("§6.7.6 identify() delivers a verified remote identity to the responder", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  const initiatorIdentity = await Identity.generate();

  // Capture the wire packet the initiator emits and deliver it manually.
  const initiatorTransport = /** @type {MockTransport} */ (initiator.transport);
  initiatorTransport.receivedPackets.length = 0;
  await initiator.identify(initiatorIdentity);

  const identifyPkt = initiatorTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.LINKIDENTIFY,
  );
  assert.ok(identifyPkt, "initiator must emit a LINKIDENTIFY");
  // LINKIDENTIFY is encrypted, so the wire payload is a Token.
  assert.ok(
    identifyPkt.payload.length > 64,
    "LINKIDENTIFY body must be encrypted",
  );

  let identified = null;
  responder.addEventListener("identify", (e) => {
    identified = /** @type {any} */ (e).detail.identity;
  });
  await responder.receive(
    new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: initiator.linkId,
      contextByte: ContextType.LINKIDENTIFY,
      payload: identifyPkt.payload,
    }),
  );

  assert.ok(
    identified,
    "responder must fire `identify` with the peer identity",
  );
  assert.deepStrictEqual(
    Array.from(await identified.getPublicKey()),
    Array.from(await initiatorIdentity.getPublicKey()),
  );
  assert.strictEqual(responder.remoteIdentity, identified);
});

// ---------------------------------------------------------------------------
// §6.1 / §6.3  LINKREQUEST body and link_id invariance
// ---------------------------------------------------------------------------

test("§6.3 link_id is invariant under signalling-byte changes", async () => {
  const destHash = new Uint8Array(16).fill(0x5a);
  const base = new Uint8Array(67);
  crypto.getRandomValues(base.subarray(0, 64));
  base[64] = 0x20;
  base[65] = 0x01;
  base[66] = 0xf4;

  const p1 = new Packet({
    headerType: HeaderType.HEADER_1,
    destinationType: DestType.SINGLE,
    packetType: PacketType.LINKREQUEST,
    destinationHash: destHash,
    payload: base,
  });
  p1.raw = p1.serialize();
  const id1 = await linkIdFromLrPacket(p1);

  // Flip a signalling bit; link_id must not change.
  const flipped = new Uint8Array(base);
  flipped[66] ^= 0x01;
  const p2 = new Packet({
    headerType: HeaderType.HEADER_1,
    destinationType: DestType.SINGLE,
    packetType: PacketType.LINKREQUEST,
    destinationHash: destHash,
    payload: flipped,
  });
  p2.raw = p2.serialize();
  const id2 = await linkIdFromLrPacket(p2);

  assert.deepStrictEqual(Array.from(id1), Array.from(id2));
  assert.strictEqual(id1.length, 16);
});

// ---------------------------------------------------------------------------
// Helper: build a fully-established initiator/responder link pair.
// ---------------------------------------------------------------------------

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
  await awaitActive(initiator, () => [...transportR.links.values()][0]);
  const responder = [...transportR.links.values()][0];
  if (!responder) throw new Error("established pair failed: no responder link");
  return { initiator, responder };
}

/**
 * Polls until both the initiator and the (lazily-resolved) responder link are
 * ACTIVE, or throws after `timeoutMs`. Robust under concurrent-test crypto
 * load where a fixed sleep is not.
 * @param {Link} initiator
 * @param {() => Link|undefined} getResponder
 * @param {number} [timeoutMs]
 */
async function awaitActive(initiator, getResponder, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const responder = getResponder();
    if (
      initiator.status === LinkStatus.ACTIVE &&
      responder &&
      responder.status === LinkStatus.ACTIVE
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `handshake did not complete within ${timeoutMs}ms ` +
      `(initiator=${initiator.status}, responder=${getResponder()?.status})`,
  );
}
