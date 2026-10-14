/**
 * Link return-path capture on the responder side (work doc #43).
 *
 * A node serving its own clients over a listening interface must route
 * responder→initiator link traffic (LRPROOF, link DATA, keepalives, teardown)
 * over the interface the link's handshake arrived on — the reference pins
 * `Link.attached_interface = packet.receiving_interface` on accept (responder)
 * and at LRPROOF validation (initiator), and `Transport._outbound` sends
 * LINK-destination packets via that interface when no path-table entry exists
 * for the link id.
 *
 * Regression (work doc #43): before this, a responder whose default interface
 * was a *different* client's connection sent every link reply to the default
 * interface, so only the most recently connected client was reachable, and its
 * disconnect broke all other clients' links (`No route to host`).
 *
 * The harness wires a server transport and a client transport back-to-back
 * over a loopback interface pair, then adds a decoy interface that becomes the
 * server's default. A pre-fix responder sends the LRPROOF to the decoy and the
 * handshake never completes — so the test fails before the fix by timing out,
 * and passes after it by completing over the arrival interface.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  createAnnounceRandomHash,
  Destination,
  Direction,
} from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType, Packet, PacketType } from "../../src/core/packet.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { TransportCore } from "../../src/transport/transport.js";
import { toHex } from "../../src/utils/encoding.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until `probe()` returns a truthy value or the deadline passes.
 * @template T
 * @param {() => T} probe
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function waitFor(probe, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(10);
  }
}

test("the responder's link return path is the LINKREQUEST's arrival interface, not the default", async (t) => {
  const transportS = new TransportCore();
  const transportC = new TransportCore();

  /** Packets the (pre-fix) default interface would have captured. */
  const decoySent = [];
  const decoyIface = Object.assign(new EventTarget(), {
    name: "decoy-client",
    _packetWriter: {
      write: async (/** @type {Packet} */ pkt) => {
        decoySent.push(pkt);
      },
    },
  });

  /** Server-side end of the client A loopback pair. */
  const cliSent = [];
  const cliIface = Object.assign(new EventTarget(), {
    name: "client-a",
    _packetWriter: {
      write: async (/** @type {Packet} */ pkt) => {
        cliSent.push(pkt);
        setImmediate(() => transportC._routeIncomingPacket(pkt, ifaceOnC));
      },
    },
  });

  /** Client-side end of the loopback pair. */
  const ifaceOnC = Object.assign(new EventTarget(), {
    name: "to-server",
    _packetWriter: {
      write: async (/** @type {Packet} */ pkt) => {
        setImmediate(() => transportS._routeIncomingPacket(pkt, cliIface));
      },
    },
  });

  // Client A connects first (default), then client B (the decoy) connects
  // last and steals the default slot — the exact ordering from work doc #43.
  transportS.addInterface(cliIface);
  transportS.addInterface(decoyIface, true);
  assert.strictEqual(transportS.defaultInterface, decoyIface);

  const serverIdentity = await Identity.generate();
  const serverDest = await Destination.IN(
    "returnpath",
    DestType.SINGLE,
    serverIdentity,
    /** @type {any} */ ({ transport: transportS }),
  );
  transportS.bindLocalDestination(serverDest);

  /** @type {Error|null} */
  let acceptError = null;
  serverDest.addEventListener("link_request", (/** @type {any} */ event) => {
    serverDest
      .acceptLink(event.detail.packet, event.detail.receivingInterface)
      .catch((/** @type {Error} */ err) => {
        acceptError = err;
      });
  });

  const clientDest = await Destination.create(
    "returnpath",
    Direction.OUT,
    DestType.SINGLE,
    serverIdentity,
    /** @type {any} */ ({ transport: transportC }),
  );
  // The client learned the server's path from its announce; seed it directly.
  const seeded = transportC.routingTable.addOrUpdateRoute(
    serverDest.destinationHash,
    {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 1,
      viaInterface: ifaceOnC,
      randomBlob: createAnnounceRandomHash(
        crypto.getRandomValues(new Uint8Array(16)),
        1000,
      ),
    },
  );
  assert.ok(seeded, "route seeding must succeed");

  const initiator = await Link.initiate(clientDest, transportC);

  const responder = await waitFor(() =>
    [...transportS.activeLinks.values()].at(-1),
  );
  await waitFor(() => initiator.status === LinkStatus.ACTIVE);
  await waitFor(() => responder.status === LinkStatus.ACTIVE);
  assert.strictEqual(acceptError, null, "accept must not throw");

  // The return path is pinned to the arrival interface on both sides.
  assert.strictEqual(
    responder.attachedInterface,
    cliIface,
    "responder must attach to the LINKREQUEST's arrival interface",
  );
  assert.strictEqual(
    initiator.attachedInterface,
    ifaceOnC,
    "initiator must attach to the LRPROOF's arrival interface",
  );

  // Responder → initiator traffic flows over the pinned interface; the decoy
  // (default) interface must never see link traffic.
  assert.strictEqual(
    decoySent.length,
    0,
    "the default interface must not receive responder link traffic",
  );
  assert.ok(
    cliSent.some((p) => toHex(p.destinationHash) === toHex(responder.linkId)),
    "the LRPROOF must have gone out over the arrival interface",
  );

  /** @type {Packet[]} */
  const clientReceived = [];
  initiator.addEventListener("data", (/** @type {any} */ event) => {
    clientReceived.push(event.detail?.packet);
  });

  await responder.send(
    new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: responder.linkId,
      payload: new TextEncoder().encode("reply over link"),
    }),
  );
  await waitFor(() => clientReceived.length > 0);

  assert.strictEqual(
    decoySent.length,
    0,
    "link DATA must bypass the default interface",
  );
  assert.strictEqual(clientReceived.length, 1, "the reply reached the client");

  // Tear the links down so their keepalive timers don't hold the event loop.
  t.after(async () => {
    for (const link of [initiator, responder]) {
      try {
        if (link.status !== LinkStatus.CLOSED) await link.teardown();
      } catch {
        // already closed
      }
    }
  });
});
