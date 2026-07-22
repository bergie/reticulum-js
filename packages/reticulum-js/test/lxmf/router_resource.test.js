/**
 * End-to-end LXMF large-message delivery via the §10 Resource pipeline.
 *
 * Verifies the two integration points wired into LXMRouter (PROTOCOL-SPEC.md
 * §5.2 / §10.1):
 *   - sender: a DIRECT body larger than the Link MDU is sent as a Resource;
 *   - receiver: a completed incoming Resource is fed through the same inbound
 *     message path as a single-packet message.
 *
 * Uses a real loopback transport pair so the full handshake, advertise,
 * windowed transfer, and RESOURCE_PRF proof all run.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { ContextType, DestType, PacketType } from "../../src/core/packet.js";
import { Message } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import { Link, LinkStatus } from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";

/**
 * Loopback transport. Routes LINKREQUEST packets to the destination's
 * `receive()` (which dispatches the `link_request` event the router listens
 * for) and DATA packets to the addressed link. Delivery is deferred to a
 * separate microtask so inbound packets never process re-entrantly.
 */
class LoopbackTransport extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, Link>} */
    this.activeLinks = new Map();
    /** @type {Map<string, Destination>} */
    this.destinations = new Map();
    /** @type {Packet[]} */
    this.sent = [];
    this.peer = null;
  }
  /** @param {Uint8Array} hash @param {Link} link */
  addLink(hash, link) {
    this.activeLinks.set(toHex(hash), link);
  }
  removeLink(hash) {
    this.activeLinks.delete(toHex(hash));
  }
  /** @param {Destination} dest */
  bindLocalDestination(dest) {
    this.destinations.set(toHex(dest.destinationHash), dest);
  }
  /**
   * @param {Packet} packet
   * @param {Uint8Array|null} [_linkId]
   */
  async sendPacket(packet, _linkId = null) {
    this.sent.push(packet);
    if (this.peer) {
      const peer = this.peer;
      Promise.resolve()
        .then(() => peer._route(packet))
        .catch((err) =>
          console.error(
            "LoopbackTransport route error:",
            String(err).slice(0, 120),
          ),
        );
    }
    return true;
  }
  /** @param {Packet} packet */
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.activeLinks.has(dh)) {
      await this.activeLinks.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      await this.destinations.get(dh).receive(packet, this);
    }
  }
}

/**
 * @returns {Promise<{ identity: Identity, rns: any, transport: LoopbackTransport }>}
 */
async function makeNode() {
  const identity = await Identity.generate();
  const transport = new LoopbackTransport();
  const rns = {
    transport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
  };
  return { identity, rns, transport };
}

describe("LXMRouter large-message delivery via Resource (§5.2/§10.1)", () => {
  test("a DIRECT message larger than the Link MDU transfers as a Resource", async () => {
    const responder = await makeNode();
    const sender = await makeNode();
    responder.transport.peer = sender.transport;
    sender.transport.peer = responder.transport;

    // Receiver side: stand up the delivery destination.
    const responderRouter = new LXMRouter(responder.identity, responder.rns);
    await responderRouter.init();

    // Make the sender's identity known to the responder so the signature
    // verifies without parking on a LINKIDENTIFY round-trip.
    await Destination.remember(
      sender.identity.identityHash,
      sender.identity.identityHash,
      sender.identity.publicKey,
    );

    // Sender side: a router (for .send()) plus an OUT destination and an
    // established link to the responder's lxmf.delivery destination.
    const senderRouter = new LXMRouter(sender.identity, sender.rns);
    await senderRouter.init();

    const senderOutDest = await Destination.create(
      "lxmf.delivery",
      Direction.OUT,
      DestType.SINGLE,
      responder.identity,
      /** @type {any} */ ({ transport: sender.transport }),
    );
    const link = await Link.initiate(senderOutDest, sender.transport);

    // Wait for both sides to reach ACTIVE.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const responderLink = [...responder.transport.activeLinks.values()][0];
      if (
        link.status === LinkStatus.ACTIVE &&
        responderLink &&
        responderLink.status === LinkStatus.ACTIVE
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.strictEqual(link.status, LinkStatus.ACTIVE, "link must be ACTIVE");

    // Build a message large enough that the signed body exceeds the Link MDU.
    // wireData = 16 + 16 + 64 + msgpack ≥ 432 requires content ≳ ~330 bytes.
    const longContent = "L".repeat(500);
    const message = new Message({
      sourceHash: sender.identity.identityHash,
      destinationHash: responderRouter.deliveryDest.destinationHash,
      title: "large",
      content: longContent,
      fields: { note: "resource-backed" },
    });

    let received = null;
    responderRouter.addEventListener("message", (event) => {
      received = /** @type {any} */ (event).detail.message;
    });

    await senderRouter.send(message, sender.identity, link.linkId);

    // Allow the deferred transfer + proof handshake to complete.
    const recvDeadline = Date.now() + 5000;
    while (Date.now() < recvDeadline && !received) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.ok(received, "responder must deliver the large message");
    assert.strictEqual(received.content, longContent);
    assert.strictEqual(received.title, "large");
    assert.deepStrictEqual(
      Array.from(received.sourceHash),
      Array.from(sender.identity.identityHash),
    );

    // Sanity: a RESOURCE_ADV actually crossed the wire, proving the Resource
    // path was taken (not a single DATA packet).
    const advCount = sender.transport.sent.filter(
      (p) => p.contextByte === ContextType.RESOURCE_ADV,
    ).length;
    assert.ok(advCount > 0, "sender must have advertised a Resource");
  });

  test("a small DIRECT message still uses a single DATA packet", async () => {
    const responder = await makeNode();
    const sender = await makeNode();
    responder.transport.peer = sender.transport;
    sender.transport.peer = responder.transport;

    const responderRouter = new LXMRouter(responder.identity, responder.rns);
    await responderRouter.init();
    await Destination.remember(
      sender.identity.identityHash,
      sender.identity.identityHash,
      sender.identity.publicKey,
    );

    const senderRouter = new LXMRouter(sender.identity, sender.rns);
    await senderRouter.init();
    const senderOutDest = await Destination.create(
      "lxmf.delivery",
      Direction.OUT,
      DestType.SINGLE,
      responder.identity,
      /** @type {any} */ ({ transport: sender.transport }),
    );
    const link = await Link.initiate(senderOutDest, sender.transport);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && link.status !== LinkStatus.ACTIVE) {
      await new Promise((r) => setTimeout(r, 5));
    }

    sender.transport.sent.length = 0;
    const message = new Message({
      sourceHash: sender.identity.identityHash,
      destinationHash: responderRouter.deliveryDest.destinationHash,
      content: "tiny",
    });
    await senderRouter.send(message, sender.identity, link.linkId);

    // A small message must NOT spawn a Resource advertisement.
    const advCount = sender.transport.sent.filter(
      (p) => p.contextByte === ContextType.RESOURCE_ADV,
    ).length;
    assert.strictEqual(advCount, 0, "small message must not use a Resource");
  });
});
