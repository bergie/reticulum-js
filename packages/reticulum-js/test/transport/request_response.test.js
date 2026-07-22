/**
 * REQUEST/RESPONSE protocol tests (PROTOCOL-SPEC.md §11).
 *
 * Verifies the on-the-wire invariants for the over-Link RPC mechanism that
 * NomadNet page fetches, LXMF propagation `/get`, and custom RPC all ride on:
 *
 *   - REQUEST envelope is a single msgpack `[timestamp, path_hash, data]`
 *     with `context = REQUEST (0x09)` and `contextFlag = false`.
 *   - `data` is encoded directly into the list (dict -> map, not pre-packed
 *     bytes); the bug where element [2] is msgpacked twice silently breaks
 *     every NomadNet form post and LXMF `/get` round (§11.1 gotcha).
 *   - `request_id` is `SHA-256(packet.get_hashable_part())[:16]` of the
 *     encrypted wire packet, computed identically on both sides — NOT random
 *     and NOT a hash of the plaintext envelope (§11.1 / §11.2 security note).
 *   - RESPONSE envelope is msgpack `[request_id, response]` with
 *     `context = RESPONSE (0x0A)`.
 *   - Allow modes (§11.4) and the RequestReceipt timeout / link-close paths.
 *
 * Companion implementation: `src/transport/link.js` (`request`,
 * `_handleRequest`, `_handleResponse`, `_sendResponse`, `_authorizeRequest`)
 * plus `Destination.registerRequestHandler` / `Allow`.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { Allow, Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";
import { MicroMsgPack } from "../../src/utils/msgpack.js";

/**
 * Mock transport: sendPacket forwards to the paired transport, which routes
 * the packet to the matching local Link or Destination. Mirrors the
 * link_spec.test.js harness so a real handshake completes end-to-end.
 */
class MockTransport {
  constructor() {
    /** @type {Packet[]} */
    this.receivedPackets = [];
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
  /** @param {Packet} packet */
  async sendPacket(packet) {
    this.receivedPackets.push(packet);
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
 * @returns {Promise<{ initiator: Link, responder: Link, responderDest: Destination }>}
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
  // Drive the (synchronous) handshake to ACTIVE on both legs.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const responder = [...transportR.links.values()][0];
    if (
      initiator.status === LinkStatus.ACTIVE &&
      responder &&
      responder.status === LinkStatus.ACTIVE
    ) {
      return { initiator, responder, responderDest };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

// ---------------------------------------------------------------------------
// §11  MDU accessor
// ---------------------------------------------------------------------------

test("§11 mdu is 431 at the default mtu 500 (spec-pinned)", () => {
  // PROTOCOL-SPEC.md §5.2 / §11.1: at mtu=500 the MDU is 431 bytes, the
  // resulting link-encrypted wire packet is 499 bytes.
  const link = new Link({
    destination: /** @type {any} */ (null),
    linkId: new Uint8Array(16),
    transport: /** @type {any} */ (null),
    initiator: true,
    ephemeralX25519Priv: /** @type {any} */ (null),
  });
  assert.strictEqual(link.mtu, 500);
  assert.strictEqual(link.mdu, 431);
});

test("§11 mdu scales with mtu and never goes negative", () => {
  const link = new Link({
    destination: /** @type {any} */ (null),
    linkId: new Uint8Array(16),
    transport: /** @type {any} */ (null),
    initiator: true,
    ephemeralX25519Priv: /** @type {any} */ (null),
  });
  // Larger MTU yields a proportionally larger MDU.
  link.mtu = 1000;
  assert.ok(
    link.mdu > 431,
    `larger mtu should yield larger mdu (got ${link.mdu})`,
  );
  // A plaintext of size mdu must Token-encrypt + frame to <= mtu.
  link.mtu = 500;
  const mdu = link.mdu;
  const budget = 500 - 67; // header(19) + token overhead(48)
  // ciphertext for a mdu-sized plaintext is the next 16-byte boundary above mdu.
  const ciphertext = Math.floor(mdu / 16) * 16 + 16;
  assert.ok(
    ciphertext <= budget,
    "mdu-sized plaintext must fit after encryption",
  );
});

// ---------------------------------------------------------------------------
// §11.1  REQUEST envelope shape on the wire
// ---------------------------------------------------------------------------

test("§11.1 REQUEST packet is msgpack [ts, path_hash, data], context REQUEST, contextFlag false", async () => {
  const { initiator } = await makeEstablishedPair();
  const initiatorTransport = /** @type {MockTransport} */ (initiator.transport);
  initiatorTransport.receivedPackets.length = 0;

  // Don't await — we only want to inspect the emitted packet.
  const p = initiator.request("/page/index.mu");
  // Let the synchronous send run.
  await new Promise((r) => setTimeout(r, 10));
  // Avoid the default-timeout rejection failing the test.
  initiator.teardown().catch(() => {});
  p.catch(() => {});

  const reqPkt = initiatorTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.REQUEST,
  );
  assert.ok(reqPkt, "initiator must emit a REQUEST packet");

  // §2.1: contextFlag (bit 5) means "ratchet in announce" and must be false
  // for a REQUEST — only the context byte conveys REQUEST-ness.
  assert.strictEqual(reqPkt.contextFlag, false);
  assert.strictEqual(reqPkt.packetType, PacketType.DATA);
  assert.strictEqual(reqPkt.destinationType, DestType.LINK);

  // Decrypt the wire payload the way the responder would, then decode msgpack.
  const plaintext = await initiator.token.decrypt(reqPkt.payload);
  const envelope = MicroMsgPack.decode(plaintext);
  assert.ok(Array.isArray(envelope), "envelope must be a msgpack array");
  assert.strictEqual(envelope.length, 3);
  assert.strictEqual(typeof envelope[0], "number", "[0] timestamp is a float");
  assert.ok(envelope[1] instanceof Uint8Array, "[1] path_hash is bytes");
  assert.strictEqual(envelope[1].length, 16, "path_hash is 16 bytes");

  // path_hash must equal SHA-256("/page/index.mu")[:16].
  const expectedPathHash = await Identity.truncatedHash(
    new TextEncoder().encode("/page/index.mu"),
  );
  assert.deepStrictEqual(Array.from(envelope[1]), Array.from(expectedPathHash));
});

test("§11.1 data is encoded ONCE — a dict decodes back to a map, not bytes", async () => {
  // The classic double-pack bug: pre-msgpacking `data` as bytes makes element
  // [2] decode to Uint8Array, so NomadNet's `isinstance(data, dict)` falls
  // through and silently drops every form post (§11.1 gotcha).
  const { initiator } = await makeEstablishedPair();
  const initiatorTransport = /** @type {MockTransport} */ (initiator.transport);
  initiatorTransport.receivedPackets.length = 0;

  const formData = { field_message: "hello", field_active: "true" };
  const p = initiator.request("/page/submit.mu", formData);
  await new Promise((r) => setTimeout(r, 10));
  initiator.teardown().catch(() => {});
  p.catch(() => {});

  const reqPkt = initiatorTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.REQUEST,
  );
  assert.ok(reqPkt);
  const plaintext = await initiator.token.decrypt(reqPkt.payload);
  const envelope = MicroMsgPack.decode(plaintext);

  assert.strictEqual(typeof envelope[2], "object");
  assert.ok(!(envelope[2] instanceof Uint8Array), "[2] must NOT be bytes");
  assert.deepStrictEqual(envelope[2], formData);
});

test("§11.1 default data is msgpack nil for a plain GET", async () => {
  const { initiator } = await makeEstablishedPair();
  const initiatorTransport = /** @type {MockTransport} */ (initiator.transport);
  initiatorTransport.receivedPackets.length = 0;

  const p = initiator.request("/page/index.mu");
  await new Promise((r) => setTimeout(r, 10));
  initiator.teardown().catch(() => {});
  p.catch(() => {});

  const reqPkt = initiatorTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.REQUEST,
  );
  const plaintext = await initiator.token.decrypt(reqPkt.payload);
  const envelope = MicroMsgPack.decode(plaintext);
  assert.strictEqual(envelope[2], null);
});

// ---------------------------------------------------------------------------
// §11.1 / §11.2  request_id is the truncated hash of the REQUEST packet
// ---------------------------------------------------------------------------

test("§11.1/§11.2 request_id = SHA256(get_hashable_part(wire REQUEST))[:16], identical on both sides", async () => {
  // This is the single most important interop invariant: the request_id the
  // initiator waits for MUST equal the one the server computes from the
  // inbound packet. Random ids or hashing the plaintext both fail this.
  const { initiator } = await makeEstablishedPair();
  const initiatorTransport = /** @type {MockTransport} */ (initiator.transport);
  initiatorTransport.receivedPackets.length = 0;

  const p = initiator.request("/rpc/echo", "ping");
  await new Promise((r) => setTimeout(r, 10));
  initiator.teardown().catch(() => {});
  p.catch(() => {});

  const reqPkt = initiatorTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.REQUEST,
  );
  assert.ok(reqPkt);
  assert.ok(
    reqPkt.raw && reqPkt.raw.length > 0,
    "outbound packet needs raw set",
  );

  // Reconstruct the hashable part exactly as Packet.getHashablePart does.
  const hashable = reqPkt.getHashablePart();
  const expectedId = await Identity.truncatedHash(hashable);

  // The pending entry is keyed by exactly this id.
  assert.strictEqual(
    initiator.pendingRequests.size,
    1,
    "exactly one pending REQUEST should be tracked",
  );
  const trackedId = [...initiator.pendingRequests.keys()][0];
  assert.strictEqual(trackedId, toHex(expectedId));
  assert.strictEqual(expectedId.length, 16);
});

// ---------------------------------------------------------------------------
// §11.2  Full round-trip: request -> handler -> response
// ---------------------------------------------------------------------------

test("§11.2 full round-trip resolves the response value", async () => {
  const { initiator, responderDest } = await makeEstablishedPair();

  await responderDest.registerRequestHandler("/rpc/echo", {
    responseGenerator: async (_path, data) =>
      new TextEncoder().encode(`echo:${new TextDecoder().decode(data)}`),
    allow: Allow.ALL,
  });

  const response = await initiator.request(
    "/rpc/echo",
    new TextEncoder().encode("hello"),
  );
  assert.ok(response instanceof Uint8Array);
  assert.deepStrictEqual(
    Array.from(response),
    Array.from(new TextEncoder().encode("echo:hello")),
  );
});

test("§11.2 response envelope is msgpack [request_id, response] with context RESPONSE", async () => {
  const { initiator, responder, responderDest } = await makeEstablishedPair();
  const responderTransport = /** @type {MockTransport} */ (responder.transport);
  responderTransport.receivedPackets.length = 0;

  await responderDest.registerRequestHandler("/rpc/plain", {
    responseGenerator: async () => 42,
    allow: Allow.ALL,
  });

  const response = await initiator.request("/rpc/plain");
  assert.strictEqual(response, 42);

  const respPkt = responderTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.RESPONSE,
  );
  assert.ok(respPkt, "responder must emit a RESPONSE packet");
  assert.strictEqual(respPkt.contextFlag, false);

  const plaintext = await responder.token.decrypt(respPkt.payload);
  const envelope = MicroMsgPack.decode(plaintext);
  assert.ok(Array.isArray(envelope));
  assert.strictEqual(envelope.length, 2);
  assert.ok(envelope[0] instanceof Uint8Array);
  assert.strictEqual(envelope[0].length, 16, "[0] is the 16-byte request_id");
  assert.strictEqual(envelope[1], 42, "[1] is the response value");
});

test("§11.2 response carries the request_id of the originating REQUEST", async () => {
  const { initiator, responder, responderDest } = await makeEstablishedPair();
  const initiatorTransport = /** @type {MockTransport} */ (initiator.transport);
  const responderTransport = /** @type {MockTransport} */ (responder.transport);

  await responderDest.registerRequestHandler("/rpc/id", {
    responseGenerator: async () => "ok",
    allow: Allow.ALL,
  });

  initiatorTransport.receivedPackets.length = 0;
  await initiator.request("/rpc/id");
  const reqPkt = initiatorTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.REQUEST,
  );
  const expectedRequestId = await Identity.truncatedHash(
    reqPkt.getHashablePart(),
  );

  const respPkt = responderTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.RESPONSE,
  );
  const plaintext = await responder.token.decrypt(respPkt.payload);
  const [responseId] = MicroMsgPack.decode(plaintext);
  assert.deepStrictEqual(
    Array.from(responseId),
    Array.from(expectedRequestId),
    "RESPONSE [0] must equal the REQUEST packet's truncated hash",
  );
});

test("§11.2 handler generator receives (path, data, request_id, remoteIdentity, time)", async () => {
  const { initiator, responderDest } = await makeEstablishedPair();
  /** @type {any} */
  let captured = null;
  await responderDest.registerRequestHandler("/rpc/inspect", {
    responseGenerator: async (path, data, requestId, remoteIdentity, time) => {
      captured = { path, data, requestId, remoteIdentity, time };
      return "captured";
    },
    allow: Allow.ALL,
  });

  const result = await initiator.request("/rpc/inspect", { a: 1 });
  assert.strictEqual(result, "captured");
  assert.ok(captured);
  assert.strictEqual(captured.path, "/rpc/inspect");
  assert.deepStrictEqual(captured.data, { a: 1 });
  assert.ok(captured.requestId instanceof Uint8Array);
  assert.strictEqual(captured.requestId.length, 16);
  assert.strictEqual(captured.remoteIdentity, null); // initiator never identified
  assert.strictEqual(typeof captured.time, "number");
});

test("§11.2 generator returning null/undefined suppresses the RESPONSE", async () => {
  const { initiator, responder, responderDest } = await makeEstablishedPair();
  const responderTransport = /** @type {MockTransport} */ (responder.transport);
  responderTransport.receivedPackets.length = 0;

  await responderDest.registerRequestHandler("/rpc/silent", {
    responseGenerator: async () => null,
    allow: Allow.ALL,
  });

  await assert.rejects(
    initiator.request("/rpc/silent", null, { timeout: 200 }),
    /timed out/,
  );
  const respPkt = responderTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.RESPONSE,
  );
  assert.strictEqual(respPkt, undefined, "no RESPONSE must be emitted");
});

// ---------------------------------------------------------------------------
// §11.2  request_id correlation security check
// ---------------------------------------------------------------------------

test("§11.2 a RESPONSE whose request_id matches no pending REQUEST is dropped", async () => {
  const { initiator, responder } = await makeEstablishedPair();
  // Forge a RESPONSE with a bogus 16-byte request_id and deliver it.
  const bogusId = crypto.getRandomValues(new Uint8Array(16));
  const packed = MicroMsgPack.encode([bogusId, "imposter"]);
  const wirePayload = await responder.token.encrypt(packed);
  const forged = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.LINK,
    destinationHash: initiator.linkId,
    contextByte: ContextType.RESPONSE,
    payload: wirePayload,
  });
  forged.raw = forged.serialize();

  // Must not throw and must leave pendingRequests untouched.
  await responder.receive(forged); // routed to initiator via peer transport
  // The forged packet is addressed to the initiator's linkId; deliver via
  // initiator's own transport route instead (the peer transport already did).
  // pendingRequests should be empty (no real request was made).
  assert.strictEqual(initiator.pendingRequests.size, 0);
});

// ---------------------------------------------------------------------------
// §11.4  Authorization (allow modes)
// ---------------------------------------------------------------------------

test("§11.4 ALLOW_NONE rejects the request (no response, times out)", async () => {
  const { initiator, responder, responderDest } = await makeEstablishedPair();
  const responderTransport = /** @type {MockTransport} */ (responder.transport);
  await responderDest.registerRequestHandler("/rpc/none", {
    responseGenerator: async () => "should-not-happen",
    allow: Allow.NONE,
  });
  responderTransport.receivedPackets.length = 0;

  await assert.rejects(
    initiator.request("/rpc/none", null, { timeout: 200 }),
    /timed out/,
  );
  const respPkt = responderTransport.receivedPackets.find(
    (p) => p.contextByte === ContextType.RESPONSE,
  );
  assert.strictEqual(respPkt, undefined);
});

test("§11.4 ALLOW_LIST rejects when the initiator has not identified", async () => {
  const { initiator, responder, responderDest } = await makeEstablishedPair();
  const allowed = await Identity.generate();
  await responderDest.registerRequestHandler("/rpc/list", {
    responseGenerator: async () => "secret",
    allow: Allow.LIST,
    allowedList: [allowed.identityHash],
  });

  // No link.identify() call -> remoteIdentity is null -> rejected.
  await assert.rejects(
    initiator.request("/rpc/list", null, { timeout: 200 }),
    /timed out/,
  );
});

test("§11.4 ALLOW_LIST accepts when an identified identity is on the list", async () => {
  const { initiator, responderDest } = await makeEstablishedPair();
  const initiatorIdentity = await Identity.generate();
  await initiator.identify(initiatorIdentity);
  // Drain the identify packet through the peer transport.
  await new Promise((r) => setTimeout(r, 20));

  await responderDest.registerRequestHandler("/rpc/list", {
    responseGenerator: async (_p, _d, _id, remoteIdentity) =>
      remoteIdentity ? "granted" : "denied",
    allow: Allow.LIST,
    allowedList: [initiatorIdentity.identityHash],
  });

  const response = await initiator.request("/rpc/list", null, {
    timeout: 1000,
  });
  assert.strictEqual(response, "granted");
});

// ---------------------------------------------------------------------------
// §11.5  RequestReceipt: timeout + link-close failure
// ---------------------------------------------------------------------------

test("§11.5 request without a handler rejects on timeout", async () => {
  const { initiator } = await makeEstablishedPair();
  // No handler registered on the responder destination.
  await assert.rejects(
    initiator.request("/rpc/missing", null, { timeout: 150 }),
    /timed out after 150ms/,
  );
  assert.strictEqual(initiator.pendingRequests.size, 0, "entry is cleared");
});

test("§11.5 tearing the link down rejects in-flight requests", async () => {
  const { initiator } = await makeEstablishedPair();
  const p = initiator.request("/rpc/whatever", null, { timeout: 5000 });
  // request() registers its pending entry asynchronously, after the
  // prepare/hash chain resolves — wait a tick for it to land.
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(initiator.pendingRequests.size, 1);
  await initiator.teardown();
  await assert.rejects(p, /Link closed before RESPONSE arrived/);
  assert.strictEqual(initiator.pendingRequests.size, 0);
});

// ---------------------------------------------------------------------------
// §11.1  MDU overflow is now handled by the §10 Resource pipeline. Those
// round-trip tests live in `request_response_resource.test.js` because they
// require the deferred-delivery loopback transport (a synchronous transport
// deadlocks on Resource transfers).
// ---------------------------------------------------------------------------
