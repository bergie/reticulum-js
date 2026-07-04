/**
 * @file message.js
 * @description LXMF Message serialization and construction
 */

import { MicroMsgPack } from "../utils/msgpack.js";

/**
 * Represents an LXMF message.
 */
export class LXMessage {
	/**
	 * Serializes an LXMF message into the wire format.
	 * @param {import("../core/identity.js").Identity} sourceIdentity
	 * @param {Uint8Array} destinationHash
	 * @param {Uint8Array} content
	 * @param {string} [title=""]
	 * @param {Record<string, any>} [fields={}]
	 * @returns {Promise<{messageId: Uint8Array, wireData: Uint8Array}>}
	 */
	static async serialize(
		sourceIdentity,
		destinationHash,
		content,
		title = "",
		fields = {},
	) {
		const sourceHash = sourceIdentity.identityHash;

		// 1. Construct the MessagePack payload
		// LXMF enforces this exact array order: [Timestamp, Content, Title, Fields]
		const timestamp = Date.now() / 1000.0; // Double-precision float
		const payloadData = [timestamp, content, title, fields];
		const msgpackPayload = MicroMsgPack.encode(payloadData);

		// 2. Generate the Message ID (SHA-256 of Dest + Source + Payload)
		const idBuffer = new Uint8Array(32 + msgpackPayload.length);
		idBuffer.set(destinationHash, 0);
		idBuffer.set(sourceHash, 16);
		idBuffer.set(msgpackPayload, 32);

		const messageIdBuffer = await globalThis.crypto.subtle.digest('SHA-256', idBuffer);
		const messageId = new Uint8Array(messageIdBuffer.slice(0, 16));

		// 3. Cryptographically sign the Message ID
		const signature = await sourceIdentity.sign(messageId);

		// 4. Assemble the final LXMF wire-format byte array
		const wireData = new Uint8Array(96 + msgpackPayload.length);
		wireData.set(destinationHash, 0);
		wireData.set(sourceHash, 16);
		wireData.set(signature, 32);
		wireData.set(msgpackPayload, 96);

		return { messageId, wireData };
	}
}
