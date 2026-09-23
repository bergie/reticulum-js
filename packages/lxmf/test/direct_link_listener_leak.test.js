/**
 * Regression: repeated `send()` over a reused cached DIRECT link must not
 * re-attach the inbound `data`/`resource` listeners each time.
 *
 * `LXMRouter.send()` (no link) establishes a DIRECT link and caches it by
 * destination hash so subsequent sends reuse one link. The backchannel
 * listeners (`_attachLinkMessageListeners`) must be attached **once** per
 * link — re-attaching on every send leaks listeners (Node's EventTarget
 * warns at 11 `data` listeners) and re-dispatches each inbound message
 * once per attached copy.
 *
 * Mirrors the `echo_direct_repro` loopback transport setup.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, test } from "node:test";
import {
  Destination,
  Direction,
} from "@reticulum/core/src/core/destination.js";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { DestType } from "@reticulum/core/src/core/packet.js";
import { Link } from "@reticulum/core/src/transport/link.js";
import { TransportCore } from "@reticulum/core/src/transport/transport.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { Message } from "../src/message.js";
import { LXMRouter } from "../src/router.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

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
  constructor(label) {
    super();
    Object.assign(this, _cacheApi);
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

describe("DIRECT link backchannel listeners don't leak on repeated send()", () => {
  test("sending N messages over a cached link attaches `data`/`resource` listeners once", async () => {
    const bot = await makeNode("BOT");
    const client = await makeNode("CLIENT");
    bot.transport.peer = client.transport;
    client.transport.peer = bot.transport;

    const botRouter = new LXMRouter(bot.identity, bot.rns);
    await botRouter.init();
    const botDeliveryHash = botRouter.deliveryDest.destinationHash;

    const clientRouter = new LXMRouter(client.identity, client.rns);
    await clientRouter.init();

    // Make both delivery destinations recallable on EACH side's transport.
    for (const t of [bot.rns.transport, client.rns.transport]) {
      await t.rememberIdentity(
        rnd(16),
        botDeliveryHash,
        bot.identity.publicKey,
        null,
      );
      await t.rememberIdentity(
        rnd(16),
        clientRouter.deliveryDest.destinationHash,
        client.identity.publicKey,
        null,
      );
    }

    // BOT: silent sink (no reply) — we only exercise the client's outbound
    // path, which is where the leak was.
    botRouter.addEventListener("message", () => {});

    // CLIENT: first send establishes + caches the DIRECT link.
    const first = new Message({
      sourceHash: clientRouter.deliveryDest.destinationHash,
      destinationHash: botDeliveryHash,
      title: "1",
      content: "1",
    });
    await clientRouter.send(first, client.identity);
    await waitForActive(client.transport);
    assert.ok(
      clientRouter.directLinks.has(toHex(botDeliveryHash)),
      "client must cache the DIRECT delivery link",
    );

    const cachedLink = clientRouter.directLinks.get(toHex(botDeliveryHash));
    const dataListenersBefore = getEventListeners(cachedLink, "data").length;
    const resourceListenersBefore = getEventListeners(
      cachedLink,
      "resource",
    ).length;
    assert.ok(
      dataListenersBefore >= 1,
      "the backchannel `data` listener must be attached",
    );
    assert.ok(
      resourceListenersBefore >= 1,
      "the backchannel `resource` listener must be attached",
    );

    // Several more sends reuse the SAME cached link — none may add listeners.
    for (let i = 0; i < 12; i++) {
      const msg = new Message({
        sourceHash: clientRouter.deliveryDest.destinationHash,
        destinationHash: botDeliveryHash,
        title: `r${i}`,
        content: `r${i}`,
      });
      await clientRouter.send(msg, client.identity);
      // Reused cached link, not a fresh one.
      assert.strictEqual(
        clientRouter.directLinks.get(toHex(botDeliveryHash)),
        cachedLink,
        "subsequent sends must reuse the cached link",
      );
    }

    const dataListenersAfter = getEventListeners(cachedLink, "data").length;
    const resourceListenersAfter = getEventListeners(
      cachedLink,
      "resource",
    ).length;

    assert.strictEqual(
      dataListenersAfter,
      dataListenersBefore,
      "`data` listener count must not grow per send (leak)",
    );
    assert.strictEqual(
      resourceListenersAfter,
      resourceListenersBefore,
      "`resource` listener count must not grow per send (leak)",
    );

    // Tear down the open links so their keepalive timers don't keep the
    // process alive after the assertions.
    for (const link of clientRouter.directLinks.values()) await link.teardown();
    for (const link of bot.transport.activeLinks.values())
      await link.teardown();
  });
});
