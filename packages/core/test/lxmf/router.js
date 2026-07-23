import assert from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType, PacketType } from "../../src/core/packet.js";
import { Message } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import { Persistor } from "../../src/storage/persistor.js";
import {
  MemoryStorageAdapter,
  StorageNamespace,
} from "../../src/storage/storage.js";
import { toHex } from "../../src/utils/encoding.js";

test("LXMRouter", async (t) => {
  const identity = await Identity.generate();
  const interfaceLayer = {
    registerDestination: (dest) => {
      interfaceLayer.lastRegisteredDest = dest;
    },
    transport: Object.assign(new EventTarget(), {
      bindLocalDestination: () => {},
      addLink: () => {},
      sendPacket: async () => {},
    }),
  };

  await t.test("initialization", async () => {
    const router = new LXMRouter(identity, interfaceLayer);
    await router.init();
    console.log("[TEST] router.deliveryDest:", router.deliveryDest);
    assert.ok(router.deliveryDest, "router.deliveryDest should be truthy");
    assert.strictEqual(router.deliveryDest.name, "lxmf.delivery");
    assert.strictEqual(interfaceLayer.lastRegisteredDest, router.deliveryDest);
  });

  await t.test(
    "opportunistic send encrypts with recipient key and strips destination hash",
    async () => {
      // The recipient: a full identity (pub+priv) so we can decrypt the result.
      const recipientIdentity = await Identity.generate();
      const recipientHash = recipientIdentity.identityHash;
      const recipientDest = await Destination.OUT(
        "lxmf.delivery",
        DestType.SINGLE,
        recipientIdentity,
        interfaceLayer,
      );
      const recipientDestHash = recipientDest.destinationHash;

      // Register the recipient so Destination.recall(destHash) finds it.
      await Destination.remember(
        recipientHash,
        recipientDestHash,
        recipientIdentity.publicKey,
      );

      // The sender's router.
      const senderIdentity = await Identity.generate();
      const router = new LXMRouter(senderIdentity, interfaceLayer);
      await router.init();

      const sourceHash = router.deliveryDest.destinationHash;

      // Capture the packet handed to the transport.
      const originalSendPacket = interfaceLayer.transport.sendPacket;
      /** @type {import("../../src/core/packet.js").Packet|null} */
      let sentPacket = null;
      interfaceLayer.transport.sendPacket = async (packet) => {
        sentPacket = packet;
      };
      try {
        const message = new Message({
          sourceHash,
          destinationHash: recipientDestHash,
          title: "opportunistic",
          content: "secret payload",
        });
        await router.send(message, senderIdentity);
      } finally {
        interfaceLayer.transport.sendPacket = originalSendPacket;
      }

      assert.ok(
        sentPacket,
        "a packet should have been handed to the transport",
      );

      // The on-wire payload must be the ECIES ciphertext, not the plaintext body.
      const decrypted = await recipientIdentity.decrypt(sentPacket.payload);
      assert.ok(decrypted, "recipient must be able to decrypt the payload");

      // Opportunistic delivery strips the leading destination hash; the body the
      // receiver reconstructs therefore starts with the SOURCE hash, and the
      // stripped destination hash must NOT be the first 16 bytes.
      assert.deepStrictEqual(
        decrypted.subarray(0, 16),
        sourceHash,
        "decrypted body should start with the source hash (dest hash stripped)",
      );
      assert.notDeepStrictEqual(
        decrypted.subarray(0, 16),
        recipientDestHash,
        "decrypted body must not begin with the destination hash",
      );
    },
  );

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

  await t.test(
    "send() identifies on the initiator link before sending the message",
    async () => {
      const transport = Object.assign(new EventTarget(), {
        bindLocalDestination: () => {},
        addLink: () => {},
        sendPacket: async () => {},
        activeLinks: new Map(),
      });
      const sendInterfaceLayer = {
        registerDestination: () => {},
        transport,
      };

      const router = new LXMRouter(identity, sendInterfaceLayer);
      await router.init();

      // Record the order of operations across the link and transport.
      const order = [];
      const link = {
        initiator: true,
        whenActive: async () => {
          order.push("active");
        },
        identify: async () => {
          order.push("identify");
        },
      };
      const linkId = new Uint8Array(16).fill(0x33);
      transport.activeLinks.set(toHex(linkId), link);
      transport.sendPacket = async () => {
        order.push("send");
      };

      const destHash = new Uint8Array(16).fill(0x11);
      const msg = new Message({
        sourceHash: new Uint8Array(16).fill(0x22),
        destinationHash: destHash,
        content: "out",
        fields: {},
      });

      await router.send(msg, identity, linkId);

      // Python LXMF drops DATA that arrives before LINKIDENTIFY, so identify
      // must run (exactly once) before the message is sent.
      assert.deepStrictEqual(order, ["active", "identify", "send"]);

      // A second send over the same link must not identify again.
      await router.send(msg, identity, linkId);
      assert.deepStrictEqual(order, [
        "active",
        "identify",
        "send",
        "active",
        "send",
      ]);
    },
  );

  await t.test(
    "LINKIDENTIFY persists the learned identity so it survives a restart (#16)",
    async () => {
      // Isolate the static map the router's Destination.remember writes to.
      // The Persistor defaults to that same map, so it sees the entry; and the
      // test doesn't leak state into other tests.
      const realKnownDestinations = Destination.knownDestinations;
      Destination.knownDestinations = new Map();
      try {
        const adapter = new MemoryStorageAdapter();
        const persistor = new Persistor({ adapter, debounceMs: 0 });
        const rnsWithPersistor = { ...interfaceLayer, persistor };

        const router = new LXMRouter(identity, rnsWithPersistor);
        await router.init();

        const senderIdentity = await Identity.generate();

        // Accept an incoming link, then fire LINKIDENTIFY on it.
        const link = Object.assign(new EventTarget(), {
          linkId: new Uint8Array(16).fill(0xee),
        });
        const originalRespond = router.deliveryDest.respondToLinkRequest;
        router.deliveryDest.respondToLinkRequest = async () => link;
        try {
          router.deliveryDest.dispatchEvent(
            new CustomEvent("link_request", {
              detail: {
                packet: {
                  packetType: PacketType.LINKREQUEST,
                  payload: new Uint8Array(64),
                },
                transport: { sendPacket: async () => {} },
                senderHash: senderIdentity.identityHash,
                appData: new Uint8Array(0),
              },
            }),
          );
          await new Promise((r) => setTimeout(r, 50));

          link.dispatchEvent(
            new CustomEvent("identify", {
              detail: { identity: senderIdentity, link: link.linkId },
            }),
          );
          await new Promise((r) => setTimeout(r, 50));

          // The peer's lxmf.delivery destination hash is the persistence key.
          const peerDeliveryDest = await Destination.OUT(
            "lxmf.delivery",
            DestType.SINGLE,
            senderIdentity,
            rnsWithPersistor,
          );
          const peerDestHex = toHex(peerDeliveryDest.destinationHash);

          assert.ok(
            persistor.persistedDestinations.has(peerDestHex),
            "identify marks the peer's delivery destination for persistence",
          );

          await persistor.flush();
          assert.ok(
            (
              await adapter.keys(StorageNamespace.IDENTITIES)
            ).includes(peerDestHex),
            "identity written to storage after flush",
          );

          // Simulate a restart: a fresh instance hydrates from the adapter
          // into a clean map, then recalls the identity by destination hash.
          Destination.knownDestinations = new Map();
          const reloaded = new Persistor({ adapter, debounceMs: 0 });
          await reloaded.load();
          const recalled = await Destination.recall(
            peerDeliveryDest.destinationHash,
          );
          assert.ok(recalled, "identity recallable after a simulated restart");
          assert.deepStrictEqual(recalled.publicKey, senderIdentity.publicKey);
        } finally {
          router.deliveryDest.respondToLinkRequest = originalRespond;
        }
      } finally {
        Destination.knownDestinations = realKnownDestinations;
      }
    },
  );
});
