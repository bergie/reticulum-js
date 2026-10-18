/**
 * RFedClient single-shot link teardown (link-lifecycle leak regression).
 *
 * Every client call (subscribe, unsubscribe, pull, oversized publish, notify
 * register/unregister/clear) is a single REQUEST exchange over a fresh Link.
 * The client must tear that link down when the call settles: an abandoned
 * idle link never expires on its own — the initiator watchdog pings, the
 * responder pongs, and the pong refreshes `lastInboundTime`, so the zombie
 * link (ephemeral key material, per-link maps, a 1 Hz watchdog timer) lives
 * forever on BOTH ends. At one leaked link pair per call this compounds into
 * heap exhaustion on busy clients and nodes — the OOM class the 0.9.10–0.9.12
 * releases have been chasing in LXMF propagation and RFed.
 *
 * Uses the production RFedNode + RFedClient over a loopback mesh and asserts
 * that both transports' link tables drain back to zero after each call.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { PacketType as PT } from "@reticulum/core/src/core/packet.js";
import { Destination, DestType } from "@reticulum/core/src/index.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { RFedClient } from "../src/client.js";
import { RFedNode } from "../src/node.js";

/** Polls `fn` every 10 ms until truthy or `timeoutMs` elapses. */
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline)
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

// ─── Loopback mesh ────────────────────────────────────────────────────────

class Wire {
  constructor() {
    /** @type {LoopbackTransport[]} */
    this.transports = [];
  }
  attach(t) {
    t.wire = this;
    this.transports.push(t);
  }
}

// A real TransportCore mixed in for the instance-scoped cache API (work doc
// #37): its methods alias the same statics these tests populate.
const _core = new TransportCore();
const _cacheApi = {
  rememberIdentity: _core.rememberIdentity.bind(_core),
  recallIdentity: _core.recallIdentity.bind(_core),
  rememberRatchet: _core.rememberRatchet.bind(_core),
  recallRatchet: _core.recallRatchet.bind(_core),
  trackReceipt: _core.trackReceipt.bind(_core),
  findReceipt: _core.findReceipt.bind(_core),
};
class LoopbackTransport extends EventTarget {
  constructor() {
    super();
    Object.assign(this, _cacheApi);
    this.wire = null;
    this.activeLinks = new Map();
    this.destinations = new Map();
  }
  addLink(hash, link) {
    this.activeLinks.set(toHex(hash), link);
  }
  removeLink(hash) {
    this.activeLinks.delete(toHex(hash));
  }
  bindLocalDestination(dest) {
    this.destinations.set(toHex(dest.destinationHash), dest);
  }
  async sendPacket(packet) {
    for (const peer of this.wire.transports) {
      if (peer === this) continue;
      const p = peer;
      Promise.resolve()
        .then(() => p._route(packet))
        .catch((err) =>
          console.error("loopback route error:", String(err).slice(0, 160)),
        );
    }
    return true;
  }
  async _route(packet) {
    if (packet.packetType === PT.ANNOUNCE) {
      this.dispatchEvent(
        new CustomEvent("announce", {
          detail: { destinationHash: packet.destinationHash },
        }),
      );
    }
    const dh = toHex(packet.destinationHash);
    if (this.activeLinks.has(dh)) {
      await this.activeLinks.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      await this.destinations.get(dh).receive(packet, this);
    }
  }
}

/** @returns {Promise<{identity: Identity, rns: any, transport: LoopbackTransport}>} */
async function makeRns() {
  const identity = await Identity.generate();
  const transport = new LoopbackTransport();
  const rns = {
    transport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
    broadcast: (/** @type {any} */ packet) => transport.sendPacket(packet),
  };
  return { identity, rns, transport };
}

const NODE_DEST_NAMES = [
  "rfed.node",
  "rfed.channel.subscribe",
  "rfed.channel.unsubscribe",
  "rfed.channel.publish",
  "rfed.channel.pull",
];

/**
 * Stands up a real RFedNode + RFedClient on a shared loopback wire, with the
 * node's identity recallable from each of its service-destination hashes.
 */
async function fixture() {
  const wire = new Wire();
  const nodeRns = await makeRns();
  const clientRns = await makeRns();
  wire.attach(nodeRns.transport);
  wire.attach(clientRns.transport);

  const node = new RFedNode({
    identity: nodeRns.identity,
    rns: nodeRns.rns,
    config: { stampCost: 1 },
  });
  await node.start();

  for (const name of NODE_DEST_NAMES) {
    const d = await Destination.OUT(name, DestType.SINGLE, nodeRns.identity);
    for (const m of [nodeRns, clientRns]) {
      await m.transport.rememberIdentity(
        rnd(16),
        /** @type {Uint8Array} */ (d.destinationHash),
        nodeRns.identity.publicKey,
        null,
      );
    }
  }
  const nodeHash = (
    await Destination.OUT(
      "rfed.channel.subscribe",
      DestType.SINGLE,
      nodeRns.identity,
    )
  ).destinationHash;

  const client = new RFedClient({
    identity: clientRns.identity,
    rns: clientRns.rns,
  });
  return {
    node,
    client,
    nodeHash,
    nodeTransport: nodeRns.transport,
    clientTransport: clientRns.transport,
  };
}

describe("RFedClient single-shot link teardown", () => {
  test("subscribe tears its link down on both ends", async () => {
    const { client, nodeHash, nodeTransport, clientTransport } =
      await fixture();

    const result = await client.subscribe(nodeHash, "teardown-test");
    assert.equal(result.ok, true, "subscribe should succeed");

    // The client link is closed by the teardown; the node side closes when
    // the LINKCLOSE arrives. Both link tables must drain to zero — a leaked
    // idle link would never expire on its own (ping/pong keeps it fresh).
    await waitFor(() => clientTransport.activeLinks.size === 0);
    await waitFor(() => nodeTransport.activeLinks.size === 0);

    // A second call must not accumulate links either.
    await client.subscribe(nodeHash, "teardown-test");
    await client.pull(nodeHash, "teardown-test");
    await waitFor(
      () =>
        clientTransport.activeLinks.size === 0 &&
        nodeTransport.activeLinks.size === 0,
      5000,
    );
  });

  test("a failing call still tears its link down", async () => {
    const { node, client, nodeHash, nodeTransport, clientTransport } =
      await fixture();

    // Make the node's /rfed/pull handler answer with the invalid-data error
    // code (0xF4), so the client's pull() throws after a completed exchange —
    // exercising the teardown on the failure path.
    await /** @type {any} */ (node)._pullDest.registerRequestHandler(
      "/rfed/pull",
      { responseGenerator: async () => 0xf4 },
    );

    await assert.rejects(
      () => client.pull(nodeHash, "teardown-test"),
      /pull error code/,
    );
    await waitFor(
      () =>
        clientTransport.activeLinks.size === 0 &&
        nodeTransport.activeLinks.size === 0,
      5000,
    );
  });
});
