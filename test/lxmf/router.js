import assert from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Destination, DestinationType } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { PacketType } from "../../src/core/packet.js";
import { LXMessage } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";

test("LXMRouter", async (t) => {
	const identity = await Identity.generate();
	const interfaceLayer = {
		registerDestination: (dest) => {
			interfaceLayer.lastRegisteredDest = dest;
		},
	};

	const router = new LXMRouter(identity, interfaceLayer);

	await router.init();

	await new Promise((resolve) => setTimeout(resolve, 50));

	await t.test("initialization", () => {
		assert.ok(router.deliveryDest instanceof Destination);
		assert.strictEqual(interfaceLayer.lastRegisteredDest, router.deliveryDest);
		assert.strictEqual(router.deliveryDest.name, "lxmf.delivery");
	});

	await t.test("processing incoming messages", async () => {
		const senderIdentity = await Identity.generate();
		const senderHash = senderIdentity.identityHash;
		const destHash = router.deliveryDest.destinationHash;

		const content = new Uint8Array([1, 2, 3, 4]);
		const title = "Hello";
		const fields = { foo: "bar" };

		const { messageId, wireData } = await LXMessage.serialize(
			senderIdentity,
			destHash,
			content,
			title,
			fields,
		);

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
			new CustomEvent("linkrequest", {
				detail: {
					transport,
					requestPacket,
					senderHash,
					appData: new Uint8Array(0),
				},
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 50));

		link.dispatchEvent(
			new CustomEvent("packet", {
				detail: {
					payload: wireData,
				},
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 50));

		console.log("Message received:", messageReceived);
		if (messageReceived) {
			console.log("Message received source:", messageReceived.source);
			console.log("Message received title:", messageReceived.title);
		}

		assert.ok(messageReceived, "Message event should have been dispatched");
		assert.deepStrictEqual(messageReceived.source, senderHash);
		assert.strictEqual(messageReceived.title, title);
		assert.deepStrictEqual(messageReceived.content, content);
		assert.ok(typeof messageReceived.timestamp === "number");
		assert.deepStrictEqual(messageReceived.fields, fields);

		router.deliveryDest.respondToLinkRequest = originalRespond;
	});
});
