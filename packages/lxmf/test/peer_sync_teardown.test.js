/**
 * Regression: a failed `LXMPeer.sync()` must tear down its link.
 *
 * `sync()` establishes a link to the peer's `lxmf.propagation` destination and
 * then offers messages. Any failure past link establishment (identify error,
 * request failure, transfer failure) previously left the link ACTIVE — every
 * failed sync leaked a zombie link whose watchdog later stale-tore it down.
 * That teardown was the trigger that turned an orphaned pending-REQUEST
 * promise into an unhandled-rejection process crash (the lille-oe crasher of
 * 2026-10-17 09:14). With sync() tearing down on failure, failed syncs leave
 * no dangling links behind.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  Destination,
  Direction,
} from "@reticulum/core/src/core/destination.js";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { ContextType, DestType } from "@reticulum/core/src/core/packet.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { PeerState } from "../src/peer.js";
import { LXMRouter } from "../src/router.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

// Instance-scoped identity-cache API (work doc #37), mixed into the mock
// transport exactly as the other lxmf loopback harnesses do.
const _core = new TransportCore();
const _cacheApi = {
  rememberIdentity: _core.rememberIdentity.bind(_core),
  recallIdentity: _core.recallIdentity.bind(_core),
  rememberRatchet: _core.rememberRatchet.bind(_core),
  recallRatchet: _core.recallRatchet.bind(_core),
  trackReceipt: _core.trackReceipt.bind(_core),
  findReceipt: _core.findReceipt.bind(_core),
};

/** Shared broadcast wire: every transport sees every packet. */
class Wire {
  constructor() {
    /** @type {LoopbackTransport[]} */
    this.transports = [];
  }
  /** @param {LoopbackTransport} t */
  attach(t) {
    t.wire = this;
    this.transports.push(t);
  }
}

/** Loopback transport peered to a {@link Wire}. */
class LoopbackTransport extends EventTarget {
  constructor() {
    super();
    Object.assign(this, _cacheApi);
    /** @type {Wire|null} */
    this.wire = null;
    /** @type {Map<string, any>} */
    this.activeLinks = new Map();
    /** @type {Map<string, any>} */
    this.destinations = new Map();
  }
  /** @param {Uint8Array} hash @param {any} link */
  addLink(hash, link) {
    this.activeLinks.set(toHex(hash), link);
  }
  /** @param {Uint8Array} hash */
  removeLink(hash) {
    this.activeLinks.delete(toHex(hash));
  }
  /** @param {Uint8Array} hash @param {any} dest */
  addDestination(hash, dest) {
    this.destinations.set(toHex(hash), dest);
  }
  /** @param {any} dest */
  bindLocalDestination(dest) {
    this.destinations.set(toHex(dest.destinationHash), dest);
  }
  /** @param {any} packet @param {Uint8Array|null} [_linkId] */
  async sendPacket(packet, _linkId = null) {
    for (const peer of this.wire.transports) {
      if (peer === this) continue;
      await peer._route(packet);
    }
    return true;
  }
  /** @param {any} packet */
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.activeLinks.has(dh)) {
      await this.activeLinks.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      await this.destinations.get(dh).receive(packet, this);
    }
  }
}

test("a failed sync() tears down its link (no zombie links)", async () => {
  const wire = new Wire();
  const clientTransport = new LoopbackTransport();
  const remoteTransport = new LoopbackTransport();
  wire.attach(clientTransport);
  wire.attach(remoteTransport);

  // Remote: a bare lxmf.propagation destination that accepts links but has no
  // /offer handler — so any offer would fail. We fail it faster still (below).
  const remoteIdentity = await Identity.generate();
  const remoteDest = await Destination.create(
    "lxmf.propagation",
    Direction.IN,
    DestType.SINGLE,
    remoteIdentity,
    /** @type {any} */ ({ transport: remoteTransport }),
  );
  remoteTransport.addDestination(remoteDest.destinationHash, remoteDest);
  // A bare destination has no router to accept links for it; wire the same
  // acceptLink listener the router would attach.
  remoteDest.addEventListener(
    "link_request",
    async (/** @type {any} */ event) => {
      await remoteDest.acceptLink(
        event.detail.packet,
        event.detail.receivingInterface ?? null,
      );
    },
  );

  // Client: a router with propagation enabled so the peer has a store to
  // offer from.
  const clientIdentity = await Identity.generate();
  const clientRns = {
    transport: clientTransport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
  };
  const router = new LXMRouter(clientIdentity, clientRns);
  await router.init();
  await router.enablePropagation({
    stampCost: 0,
    stampCostFlexibility: 0,
    name: "test client PN",
  });

  // Make the remote's propagation destination recallable for the client.
  await clientTransport.rememberIdentity(
    rnd(16),
    remoteDest.destinationHash,
    remoteIdentity.publicKey,
    null,
  );

  const peer = router.peer(remoteDest.destinationHash, {
    stampCost: 0,
    peeringCost: 1,
  });

  // One unhandled message so sync() proceeds to link establishment.
  const tid = rnd(32);
  router.propagationNode.store.add({
    transientId: tid,
    destinationHash: rnd(16),
    lxmfData: new Uint8Array(8),
    stampData: new Uint8Array(0),
    received: Date.now() / 1000,
    stampValue: 0,
    size: 40,
  });
  router.propagationNode.store.markUnhandledForPeer(
    tid,
    remoteDest.destinationHash,
  );

  // Fail the /offer REQUEST transmit itself (fast, deterministic) while
  // letting the handshake (LINKREQUEST/PROOF) and identify through.
  const originalSendPacket = clientTransport.sendPacket.bind(clientTransport);
  clientTransport.sendPacket = async (/** @type {any} */ packet) => {
    if (packet.contextByte === ContextType.REQUEST) {
      throw new Error("Link is not available");
    }
    return originalSendPacket(packet);
  };

  await assert.rejects(peer.sync(), /Link is not available/);

  // The failed sync must NOT leak the link: the peer tore it down and the
  // responder side closed with it. The LINKCLOSE is asynchronous, so poll
  // briefly for the responder side to drain.
  assert.strictEqual(
    peer.link,
    null,
    "sync() must tear down its link on failure",
  );
  const deadline = Date.now() + 2000;
  while (remoteTransport.activeLinks.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(
    remoteTransport.activeLinks.size,
    0,
    "no zombie link may remain on the peer's transport",
  );
});

test("a stalled transfer times out and tears down (no eternal sync)", async () => {
  const wire = new Wire();
  const clientTransport = new LoopbackTransport();
  const remoteTransport = new LoopbackTransport();
  wire.attach(clientTransport);
  wire.attach(remoteTransport);

  // Remote: a bare lxmf.propagation destination that accepts links. The §10
  // machinery on the accepted link pulls advertised resources on its own, so
  // the transfer starts without any application-level handler.
  const remoteIdentity = await Identity.generate();
  const remoteDest = await Destination.create(
    "lxmf.propagation",
    Direction.IN,
    DestType.SINGLE,
    remoteIdentity,
    /** @type {any} */ ({ transport: remoteTransport }),
  );
  remoteTransport.addDestination(remoteDest.destinationHash, remoteDest);
  remoteDest.addEventListener(
    "link_request",
    async (/** @type {any} */ event) => {
      await remoteDest.acceptLink(
        event.detail.packet,
        event.detail.receivingInterface ?? null,
      );
    },
  );
  // The peer must get past the /offer exchange (the response `true` = "send
  // everything") so the test exercises the transfer window itself, not an
  // offer-stage failure.
  await remoteDest.registerRequestHandler("/offer", {
    responseGenerator: async () => true,
  });

  const clientIdentity = await Identity.generate();
  const clientRns = {
    transport: clientTransport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
  };
  const router = new LXMRouter(clientIdentity, clientRns);
  await router.init();
  await router.enablePropagation({ stampCost: 0 });

  await clientTransport.rememberIdentity(
    rnd(16),
    remoteDest.destinationHash,
    remoteIdentity.publicKey,
    null,
  );

  const peer = router.peer(remoteDest.destinationHash, {
    stampCost: 0,
    peeringCost: 1,
  });
  // Shrink the transfer timeout so the test does not wait a minute.
  peer.transferTimeoutMs = 300;

  const tid = rnd(32);
  router.propagationNode.store.add({
    transientId: tid,
    destinationHash: rnd(16),
    lxmfData: new Uint8Array(8),
    stampData: new Uint8Array(0),
    received: Date.now() / 1000,
    stampValue: 0,
    size: 40,
  });
  router.propagationNode.store.markUnhandledForPeer(
    tid,
    remoteDest.destinationHash,
  );

  // Stall the transfer mid-flight: the handshake, identify and /offer request
  // flow, but the resource part payloads (context RESOURCE) never reach the
  // receiver. The link stays ACTIVE on keepalive pongs, so without the
  // transfer timeout this sync would hang forever.
  const originalSendPacket = clientTransport.sendPacket.bind(clientTransport);
  clientTransport.sendPacket = async (/** @type {any} */ packet) => {
    if (packet.contextByte === ContextType.RESOURCE) return true;
    return originalSendPacket(packet);
  };

  await assert.rejects(
    peer.sync(),
    /peer transfer timed out/,
    "the stalled transfer must be bounded by the transfer timeout",
  );

  // The timed-out sync tears its link down; the responder side drains too.
  assert.strictEqual(peer.link, null, "timed-out sync must tear down its link");
  assert.strictEqual(peer.state, PeerState.IDLE, "state resets to IDLE");
  const deadline = Date.now() + 2000;
  while (remoteTransport.activeLinks.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(
    remoteTransport.activeLinks.size,
    0,
    "no zombie link may remain on the peer's transport",
  );
});

test("sync() is never re-entered mid-sync (IDLE gate)", async () => {
  const wire = new Wire();
  const clientTransport = new LoopbackTransport();
  wire.attach(clientTransport);

  const clientIdentity = await Identity.generate();
  const clientRns = {
    transport: clientTransport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
  };
  const router = new LXMRouter(clientIdentity, clientRns);
  await router.init();

  const peer = router.peer(rnd(16), { stampCost: 0, peeringCost: 1 });
  // Simulate a sync already in progress (e.g. an earlier pass still waiting
  // on a slow transfer): a new sync() must postpone, not start a second link
  // and a second container against the same peer.
  peer.state = PeerState.RESOURCE_TRANSFERRING;
  const result = await peer.sync();
  assert.strictEqual(result, false, "overlapping sync must be postponed");
  assert.strictEqual(
    peer.link,
    null,
    "no link may be created by the skipped pass",
  );
});

test("syncPeers() skips overlapping passes", async () => {
  const wire = new Wire();
  const clientTransport = new LoopbackTransport();
  wire.attach(clientTransport);

  const clientIdentity = await Identity.generate();
  const router = new LXMRouter(clientIdentity, {
    transport: clientTransport,
    registerDestination() {},
  });
  await router.init();

  // A peer whose sync pass hangs until we release it.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let syncCalls = 0;
  router.peers.set("ff", {
    id: "ff",
    sync: async () => {
      syncCalls++;
      await gate;
    },
  });

  const pass1 = router.syncPeers();
  const pass2 = await router.syncPeers();
  assert.equal(syncCalls, 1, "the overlapping pass must not run a second sync");
  release();
  await Promise.all([pass1, pass2]);
  assert.equal(syncCalls, 1);

  // Once the first pass finished, a new pass runs again.
  await router.syncPeers();
  assert.equal(syncCalls, 2);
});
