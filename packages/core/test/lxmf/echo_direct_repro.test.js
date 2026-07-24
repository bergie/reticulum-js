/**
 * DIRECT delivery round-trip + backchannel receiving.
 *
 * Reproduces the echo-bot fix: when `send()` is given no link, it establishes a
 * DIRECT link to the recipient (Python's default method) and wires that
 * outbound link to *receive* replies (Python calls delivery_link_established
 * on outbound direct links). Before the fix, a JS app that sent over a link it
 * initiated never saw the reply arrive back on it.
 *
 *   client ──send(no link)──► establishes DIRECT link ──► bot
 *          message over the link ─────────────────────────►
 *          ◄────────────────── echo over the same link
 *   client receives the echo on the outbound (backchannel) link
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType } from "../../src/core/packet.js";
import { Message } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import { Link } from "../../src/transport/link.js";
import { toHex } from "../../src/utils/encoding.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * Loopback transport peered to one other. Critically, a link-scoped packet
 * (sendPacket called with a linkId) is handed to `link.send()` so it is
 * token-encrypted and re-addressed to the link_id — mirroring Transport.sendPacket.
 */
class LoopbackTransport extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.peer = null;
    /** @type {Map<string, Link>} */
    this.activeLinks = new Map();
    /** @type {Map<string, any>} */
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
  /** @param {any} packet @param {Uint8Array|null} [linkId] */
  async sendPacket(packet, linkId = null) {
    if (linkId) {
      const link = this.activeLinks.get(toHex(linkId));
      if (!link) throw new Error(`Link ${toHex(linkId)} is not available`);
      await link.send(packet);
      return true;
    }
    if (this.peer) {
      const peer = this.peer;
      Promise.resolve()
        .then(() => peer._route(packet))
        .catch((err) =>
          console.error(
            `[${this.label}] route error:`,
            String(err).slice(0, 160),
          ),
        );
    }
    return true;
  }
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.activeLinks.has(dh)) {
      await this.activeLinks.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      await this.destinations.get(dh).receive(packet, this);
    }
  }
}

/** @returns {Promise<{identity: Identity, rns: any, transport: LoopbackTransport}>} */
async function makeNode(label) {
  const identity = await Identity.generate();
  const transport = new LoopbackTransport(label);
  const rns = {
    transport,
    compressionProvider: undefined,
    useImplicitProof: true,
    registerDestination() {},
  };
  return { identity, rns, transport };
}

async function waitForActive(transport, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const link = [...transport.activeLinks.values()][0];
    if (link && link.status === 2 /* LinkStatus.ACTIVE */) return link;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("link never became ACTIVE");
}

describe("echo bot — DIRECT delivery with backchannel receiving", () => {
  test("send() with no link establishes a DIRECT link and receives the reply", async () => {
    const bot = await makeNode("BOT");
    const client = await makeNode("CLIENT");
    bot.transport.peer = client.transport;
    client.transport.peer = bot.transport;

    const botRouter = new LXMRouter(bot.identity, bot.rns);
    await botRouter.init();
    const botDeliveryHash = botRouter.deliveryDest.destinationHash;

    const clientRouter = new LXMRouter(client.identity, client.rns);
    await clientRouter.init();

    // Make both delivery destinations recallable (simulates hearing each
    // other's announce) so each side can recall the other's identity.
    await Destination.remember(
      rnd(16),
      botDeliveryHash,
      bot.identity.publicKey,
      null,
    );
    await Destination.remember(
      rnd(16),
      clientRouter.deliveryDest.destinationHash,
      client.identity.publicKey,
      null,
    );

    // BOT: echo handler (same shape as examples/lxmf_echobot.js).
    botRouter.addEventListener("message", async (event) => {
      const message = event.detail.message;
      const link = event.detail.link;
      const reply = new Message({
        sourceHash: botRouter.deliveryDest.destinationHash,
        destinationHash: message.sourceHash,
        content: `Echo: ${message.content}`,
        title: `Re: ${message.title}`,
      });
      await botRouter.send(reply, bot.identity, link);
    });

    // CLIENT: listen for the reply on its OWN delivery destination.
    /** @type {Message|null} */
    let reply = null;
    clientRouter.addEventListener("message", (event) => {
      reply = event.detail.message;
    });

    // CLIENT: send with NO link — send() must establish a DIRECT link, and
    // the reply must come back over it (backchannel).
    const outbound = new Message({
      sourceHash: clientRouter.deliveryDest.destinationHash,
      destinationHash: botDeliveryHash,
      title: "Test from Columba",
      content: "Test from Columba",
    });
    await clientRouter.send(outbound, client.identity);

    // The client should now hold a cached DIRECT link to the bot.
    await waitForActive(client.transport);
    assert.ok(
      clientRouter.directLinks.has(toHex(botDeliveryHash)),
      "client must cache the DIRECT delivery link",
    );

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !reply) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(reply, "client must receive the echoed reply on the backchannel");
    assert.strictEqual(reply.content, "Echo: Test from Columba");

    // Tear down the open links so their keepalive timers don't keep the
    // process alive after the assertions.
    for (const link of clientRouter.directLinks.values()) await link.teardown();
    for (const link of bot.transport.activeLinks.values())
      await link.teardown();
  });
});
