/**
 * @file router.js
 * @description LXMF Router for managing incoming and outgoing messages
 */

import { Destination, DestinationType } from "../core/destination.js";
import { MicroMsgPack } from "../utils/msgpack.js";

/**
 * Handles LXMF routing and message processing.
 */
export class LXMRouter extends EventTarget {
	/**
	 * @param {import("../core/identity.js").Identity} identity
	 * @param {any} interfaceLayer - An object that manages destinations and dispatches link requests.
	 */
	constructor(identity, interfaceLayer) {
		super();
		this.identity = identity;
		this.interfaceLayer = interfaceLayer;
		this.deliveryDest = null;

		this._init();
	}

	/**
	 * Initializes the router and registers the LXMF delivery destination.
	 * @private
	 */
	async _init() {
		// Register the standard LXMF delivery destination.
		// The aspect "lxmf.delivery" is part of the name.
		this.deliveryDest = await Destination.IN(
			"lxmf.delivery",
			DestinationType.SINGLE,
			this.identity,
		);

		this.interfaceLayer.registerDestination(this.deliveryDest);
		this._setupListeners();
	}

	/**
	 * Sets up event listeners for incoming link requests.
	 * @private
	 */
	_setupListeners() {
		// LXMF messages arrive via standard RNS Links
		this.deliveryDest.addEventListener("linkrequest", async (event) => {
			const { transport, requestPacket, senderHash, appData } = event.detail;

			try {
				// Respond to the link request to establish a secure link.
				const link = await this.deliveryDest.respondToLinkRequest(
					transport,
					requestPacket,
					senderHash,
					appData,
				);

				link.addEventListener("packet", async (pktEvent) => {
					const rawWireData = pktEvent.detail.payload;
					await this._processIncomingMessage(rawWireData, senderHash);
				});
			} catch (e) {
				console.error("Failed to respond to LXMF link request:", e);
			}
		});
	}

	/**
	 * Processes a raw LXMF message.
	 * @param {Uint8Array} wireData
	 * @param {Uint8Array} senderHash
	 * @private
	 */
	async _processIncomingMessage(wireData, senderHash) {
		// 1. Slice the wireData into Hash, Hash, Sig, and Payload views
		// Bytes 0-15: Destination Hash (16 bytes)
		// Bytes 16-31: Source Hash (16 bytes)
		// Bytes 32-95: Ed25519 Signature (64 bytes)
		// Bytes 96+: MessagePack Payload

		if (wireData.length < 96) {
			throw new Error("LXMF message too short");
		}

		const destinationHash = wireData.slice(0, 16);
		const sourceHash = wireData.slice(16, 32);
		const signature = wireData.slice(32, 96);
		const payload = wireData.slice(96);

		// 2. Verify the Ed25519 signature against the reconstructed Message ID
		// The Message ID is SHA-256 of (Dest + Source + Payload) and then truncated to 16 bytes.
		const idBuffer = new Uint8Array(32 + payload.length);
		idBuffer.set(destinationHash, 0);
		idBuffer.set(sourceHash, 16);
		idBuffer.set(payload, 32);

		const messageIdBuffer = await globalThis.crypto.subtle.digest(
			"SHA-256",
			/** @type {any} */ (idBuffer),
		);
		const messageId = new Uint8Array(messageIdBuffer.slice(0, 16));

		console.log("Router processing - messageId:", messageId);
		console.log("Router processing - signature:", signature);

		const isValid = await this.identity.validate(signature, messageId);
		if (!isValid) {
			console.log("Router processing - validation failed");
			throw new Error("Invalid LXMF message signature");
		}

		// 3. Decode the MessagePack payload
		const decodedPayload = MicroMsgPack.decode(payload);

		// LXMF enforces this exact array order: [Timestamp, Content, Title, Fields]
		if (!Array.isArray(decodedPayload) || decodedPayload.length < 4) {
			throw new Error("Invalid LXMF payload format");
		}

		const [timestamp, content, title, fields] = decodedPayload;

		// 4. Dispatch to the UI layer
		this.dispatchEvent(
			new CustomEvent("message", {
				detail: {
					source: sourceHash,
					title,
					content,
					timestamp,
					fields,
				},
			}),
		);
	}
}
