/**
 * Peer-table promiscuity caps (Python lxmd parity).
 *
 * An uncapped autopeering propagation node peers with every discovered node
 * under the cost threshold and keeps them forever: N peers × per-sync
 * transfer footprints pile up on the node even with no memory leak at all
 * (each inbound peer sync carries up to the 10 MB sync limit). Python lxmd
 * bounds this with MAX_PEERS (20), peer rotation (drop the least-useful
 * peers to restore headroom), unreachable culling (14 days), and an
 * autopeer hop depth (AUTOPEER_MAXDEPTH = 4).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { AUTOPEER_MAXDEPTH, MAX_PEERS } from "../src/constants.js";
import { LXMPeer, PeerState } from "../src/peer.js";
import { LXMRouter } from "../src/router.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

async function makeRouter(options = {}) {
  const identity = await Identity.generate();
  const core = new TransportCore();
  const router = new LXMRouter(
    identity,
    /** @type {any} */ ({
      transport: Object.assign(new EventTarget(), {
        rememberIdentity: core.rememberIdentity.bind(core),
        recallIdentity: core.recallIdentity.bind(core),
        requestPath: async () => true,
        bindLocalDestination() {},
      }),
      registerDestination() {},
    }),
  );
  await router.init();
  await router.enablePropagation({ stampCost: 0, ...options });
  return router;
}

/** Adds `n` fake peers directly to the router's table. */
function addPeers(router, n, mutate = () => {}) {
  const peers = [];
  for (let i = 0; i < n; i++) {
    const peer = new LXMPeer(router, rnd(16));
    peer.alive = true;
    peer.lastHeard = Date.now() / 1000;
    mutate(peer, i);
    router.peers.set(peer.id, peer);
    peers.push(peer);
  }
  return peers;
}

/** Emits a synthetic `lxmf.propagation` announce on the router's transport. */
function emitAnnounce(router, identity, hops) {
  router.rns.transport.dispatchEvent(
    new CustomEvent("announce", {
      detail: {
        destinationHash: rnd(16),
        identity,
        appData: /** @type {any} */ (
          router.propagationNode
        ).buildAnnounceAppData(),
        packet: { hops },
      },
    }),
  );
}

test("peer() refuses to peer beyond the cap (Python MAX_PEERS = 20)", async () => {
  const router = await makeRouter();
  assert.equal(router.maxPeers, MAX_PEERS);

  const ok = router.peer(rnd(16), { stampCost: 0, peeringCost: 1 });
  assert.ok(ok, "under the cap, peering succeeds");

  router.maxPeers = 1;
  const refused = router.peer(rnd(16), { stampCost: 0, peeringCost: 1 });
  assert.equal(refused, null, "peering at cap is refused");
  assert.equal(router.peers.size, 1, "the table did not grow");
});

test("rotatePeers() drops the least-useful peers to restore headroom", async () => {
  const router = await makeRouter();
  router.maxPeers = 4;

  // Two useful peers (high acceptance rate, protected), two useless ones
  // (unresponsive, 0% acceptance), one never-offered peer (spared).
  addPeers(router, 2, (peer) => {
    peer.offered = 10;
    peer.outgoing = 8; // 80% acceptance — above ROTATION_AR_MAX
    peer.alive = true;
  });
  addPeers(router, 2, (peer) => {
    peer.offered = 10;
    peer.outgoing = 0; // 0% acceptance — rotatable
    peer.alive = false; // unresponsive
  });
  addPeers(router, 1, (peer) => {
    peer.offered = 0; // never offered — spared
    peer.alive = true;
  });
  assert.equal(router.peers.size, 5);

  const dropped = router.rotatePeers();
  // 5 peers vs cap 4 → restore 10% headroom (≥1) → need ≥2 drops; only the
  // two 0%-acceptance unresponsive peers qualify.
  assert.ok(dropped >= 1, "rotation must drop rotatable peers");
  // Python semantics: drop to cap minus headroom (4 - 1 = 3), not to the cap.
  assert.equal(router.peers.size, 3, "the table sits at cap minus headroom");
  for (const peer of router.peers.values()) {
    assert.ok(
      peer.alive || peer.offered === 0,
      "useful and never-offered peers must survive rotation",
    );
  }
});

test("static peers survive rotation and culling", async () => {
  const router = await makeRouter();
  router.maxPeers = 3;

  const staticPeer = new LXMPeer(router, rnd(16));
  staticPeer.offered = 10;
  staticPeer.outgoing = 0;
  staticPeer.alive = false;
  staticPeer.lastHeard = 0; // ancient — would be culled
  router.peers.set(staticPeer.id, staticPeer);
  router.staticPeers.add(staticPeer.id);

  const autoPeer = new LXMPeer(router, rnd(16));
  autoPeer.offered = 10;
  autoPeer.outgoing = 0;
  autoPeer.alive = false;
  router.peers.set(autoPeer.id, autoPeer);

  // A useful peer and a never-offered peer round the table out to 4.
  const useful = new LXMPeer(router, rnd(16));
  useful.offered = 10;
  useful.outgoing = 8;
  useful.alive = true;
  router.peers.set(useful.id, useful);
  const spare = new LXMPeer(router, rnd(16));
  spare.offered = 0;
  spare.alive = true;
  router.peers.set(spare.id, spare);
  // Rotation: the static peer is protected, the 0%-acceptance auto peer
  // (unresponsive) is dropped.
  router.rotatePeers();
  assert.ok(router.peers.has(staticPeer.id), "static peers survive rotation");
  assert.equal(router.peers.has(autoPeer.id), false);

  // Culling: syncPeers breaks off unreachable non-static peers only.
  const culled = new LXMPeer(router, rnd(16));
  culled.lastHeard = 0;
  router.peers.set(culled.id, culled);
  await router.syncPeers();
  assert.ok(
    router.peers.has(staticPeer.id),
    "static peers survive unreachable culling",
  );
  assert.equal(
    router.peers.has(culled.id),
    false,
    "long-unreachable peers are culled",
  );
});

test("autopeer honours the hop depth and the peer cap", async () => {
  const router = await makeRouter({ peeringCost: 1 });
  router.maxPeers = 1;
  router.enableAutopeer(1, { autopeerMaxDepth: 2 });
  const identity = await Identity.generate();

  // Beyond the depth → not peered.
  emitAnnounce(router, identity, AUTOPEER_MAXDEPTH + 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(router.peers.size, 0, "deep announces must not be peered");

  // Within depth → peered.
  emitAnnounce(router, identity, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(router.peers.size, 1, "in-depth announces are peered");

  // At cap → further announces refused.
  emitAnnounce(router, identity, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(router.peers.size, 1, "the cap bounds autopeering");
});
