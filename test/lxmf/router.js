import assert from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { PacketType } from "../../src/core/packet.js";
import { Message } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";

test("LXMRouter", async (t) => {
  const identity = await Identity.generate();
  const interfaceLayer = {
    registerDestination: (dest) => {
      interfaceLayer.lastRegisteredDest = dest;
    },
    transport: {
      bindLocalDestination: () => {},
      addLink: () => {},
      sendPacket: async () => {},
    },
  };

  await t.test("initialization", async () => {
    const router = new LXMRouter(identity, interfaceLayer);
    await router.init();
    console.log("[TEST] router.deliveryDest:", router.deliveryDest);
    assert.ok(router.deliveryDest, "router.deliveryDest should be truthy");
    assert.strictEqual(router.deliveryDest.name, "lxmf.delivery");
    assert.strictEqual(interfaceLayer.lastRegisteredDest, router.deliveryDest);
  });

  await t.test("processing incoming messages", async () => {
    const router = new LXMRouter(identity, interfaceLayer);
    await router.init();

    const senderIdentity = await Identity.generate();
    const senderHash = senderIdentity.identityHash;
    const destHash = router.deliveryDest.destinationHash;

    // Register sender as known to the router
    await Destination.remember(
      senderHash,
      senderHash,
      senderIdentity.publicKey,
    );

    const content = "Hello World";
    const title = "Hello";
    const fields = { foo: "bar" };
    const timestamp = Date.now() / 1000.0;

    const msg = new Message(
      senderHash,
      destHash,
      timestamp,
      title,
      content,
      fields,
    );
    const { messageId, wireData } = await msg.serialize(senderIdentity);

    console.log("Generated messageId:", messageId);
    console.log("Generated wireData length:", wireData.length);

    const transport = {
      sendPacket: async () => {},
    };
    const requestPacket = {
      packetType: PacketType.LINKREQUEST,
      payload: new Uint8Array(64),
    };

    const link = new EventTarget();

    const originalRespond = router.deliveryDest.respondToLinkRequest;
    router.deliveryDest.respondToLinkRequest = async () => {
      return link;
    };

    let messageReceived = null;
    router.addEventListener("message", (event) => {
      messageReceived = event.detail;
    });

    router.deliveryDest.dispatchEvent(
      new CustomEvent("link_request", {
        detail: {
          packet: requestPacket,
          transport,
          senderHash,
          appData: new Uint8Array(0),
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    link.dispatchEvent(
      new CustomEvent("data", {
        detail: {
          packet: {
            payload: wireData,
          },
          link: link,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    console.log("Message received:", messageReceived);
    if (messageReceived) {
      console.log("Message received source:", messageReceived.sourceHash);
      console.log("Message received title:", messageReceived.title);
    }

    assert.ok(messageReceived, "Message event should have been dispatched");
    assert.ok(messageReceived instanceof Message);
    assert.deepStrictEqual(messageReceived.sourceHash, senderHash);
    assert.deepStrictEqual(messageReceived.destinationHash, destHash);
    assert.strictEqual(messageReceived.title, title);
    assert.strictEqual(messageReceived.content, content);
    assert.strictEqual(messageReceived.timestamp, timestamp);
    assert.deepStrictEqual(messageReceived.fields, fields);

    router.deliveryDest.respondToLinkRequest = originalRespond;
  });
});
