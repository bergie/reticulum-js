import assert from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType, PacketType } from "../../src/core/packet.js";
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

    const msg = new Message({
      sourceHash: senderHash,
      destinationHash: destHash,
      timestamp,
      title,
      content,
      fields,
    });
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

    const link = Object.assign(new EventTarget(), {
      linkId: new Uint8Array(16).fill(0xbb),
    });

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
          link: link.linkId,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    console.log("Message received:", messageReceived);
    if (messageReceived) {
      console.log(
        "Message received source:",
        messageReceived.message.sourceHash,
      );
      console.log("Message received title:", messageReceived.message.title);
    }

    assert.ok(messageReceived, "Message event should have been dispatched");
    const msgReceived = messageReceived.message;
    assert.ok(
      msgReceived instanceof Message,
      "messageReceived.message should be an instance of Message",
    );
    assert.deepStrictEqual(msgReceived.sourceHash, senderHash);
    assert.deepStrictEqual(msgReceived.destinationHash, destHash);
    assert.strictEqual(msgReceived.title, title);
    assert.strictEqual(msgReceived.content, content);
    assert.strictEqual(msgReceived.timestamp, timestamp);
    assert.deepStrictEqual(msgReceived.fields, fields);

    router.deliveryDest.respondToLinkRequest = originalRespond;
  });

  await t.test(
    "processing incoming messages with unknown identity (parking/unparking)",
    async () => {
      const router = new LXMRouter(identity, interfaceLayer);
      await router.init();

      const senderIdentity = await Identity.generate();
      const senderHash = senderIdentity.identityHash;
      const destHash = router.deliveryDest.destinationHash;

      // DO NOT register sender as known.

      const content = "Hello Parked World";
      const title = "Parked";
      const fields = { foo: "bar" };
      const timestamp = Date.now() / 1000.0;

      const msg = new Message({
        sourceHash: senderHash,
        destinationHash: destHash,
        timestamp,
        title,
        content,
        fields,
      });
      const { messageId, wireData } = await msg.serialize(senderIdentity);

      const transport = {
        sendPacket: async () => {},
      };
      const requestPacket = {
        packetType: PacketType.LINKREQUEST,
        payload: new Uint8Array(64),
      };

      const link = Object.assign(new EventTarget(), {
        linkId: new Uint8Array(16).fill(0xcc),
      });

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

      // 1. Send the data packet over the link
      link.dispatchEvent(
        new CustomEvent("data", {
          detail: {
            packet: {
              payload: wireData,
            },
            link: link.linkId,
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // The message should be PARKED because identity is unknown
      assert.strictEqual(
        messageReceived,
        null,
        "Message should be parked (not received yet)",
      );
      assert.ok(
        router.pendingMessages.size > 0,
        "Message should be in pendingMessages",
      );

      // 2. Now send the IDENTIFY event on the link
      // We need to simulate how Destination.remember is called in the identity listener
      // In a real scenario, the peer sends a LINKIDENTIFY packet.
      // Here we'll just trigger the identity event on the link.

      // We need to perform the same Destination.remember calls that the identity listener does.
      await Destination.remember(
        senderHash,
        senderHash,
        senderIdentity.publicKey,
      );
      // In the real implementation, it also derives the LXMF address.
      const peerDeliveryDest = await Destination.OUT(
        "lxmf.delivery",
        DestType.SINGLE,
        senderIdentity,
        interfaceLayer,
      );
      await Destination.remember(
        senderHash,
        peerDeliveryDest.destinationHash,
        senderIdentity.publicKey,
      );

      // Trigger identify on the link
      link.dispatchEvent(
        new CustomEvent("identify", {
          detail: {
            identity: senderIdentity,
            link: link,
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // 3. Now the message should have been unparked and received
      assert.ok(
        messageReceived,
        "Message should have been unparked and received",
      );
      assert.strictEqual(messageReceived.message.title, title);

      router.deliveryDest.respondToLinkRequest = originalRespond;
    },
  );
});
