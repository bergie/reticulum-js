/**
 * @file link.js
 * @description Encrypted session management (ECIES)
 */

import { Packet, PacketType } from "../core/packet.js";
import { hkdf } from "../crypto/ciphers.js";
import { Token } from "../crypto/token.js";

/**
 * Manages an encrypted link between two Reticulum nodes.
 * The Link acts as a logical tunnel for packets.
 */
export class Link extends EventTarget {
	/**
	 * @param {Uint8Array} tokenKey - The 64-byte key for the Token.
	 * @param {Uint8Array} destinationHash - The remote destination hash.
	 * @param {import("../transport/transport.js").TransportCore} rnsCore - The transport core for routing.
	 * @param {number} [mtu=1024]
	 */
	constructor(tokenKey, destinationHash, rnsCore, mtu = 1024) {
		super();
		this.tokenKey = tokenKey;
		this.destinationHash = destinationHash;
		this.rnsCore = rnsCore;
		this.mtu = mtu;
		this.token = new Token(tokenKey);

		// Virtual pipe to allow TransportCore to feed packets into the Link
		this.packetPipe = new TransformStream();
		this.readable = this.packetPipe.readable;
		this.writer = this.packetPipe.writable.getWriter();

		this._startProcessing();
	}

	/**
	 * Called by TransportCore when an incoming packet matches this Link's hash.
	 * @param {Packet} packet
	 */
	async receive(packet) {
		await this.writer.write(packet);
	}

	/**
	 * Internal loop to decrypt packets flowing through the virtual pipe.
	 * @private
	 */
	async _startProcessing() {
		const reader = this.readable.getReader();
		const token = this.token;

		try {
			while (true) {
				const { value: packet, done } = await reader.read();
				if (done) break;

				// 1. Decrypt the payload
				const decryptedPayload = await token.decrypt(packet.payload);
				if (decryptedPayload) {
					const decryptedPacket = new Packet({
						...packet,
						payload: decryptedPayload,
					});

					// 2. Emit event for the application layer (Yjs/LXMF)
					this.dispatchEvent(
						new CustomEvent("packet", { detail: decryptedPacket }),
					);
				}
			}
		} catch (e) {
			console.error("Link processing error:", e);
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Encrypts and sends a packet through the Link.
	 * @param {Packet} packet
	 */
	async send(packet) {
		try {
			// 1. Encrypt payload
			const encryptedPayload = await this.token.encrypt(packet.payload);

			// 2. Construct final packet
			const encryptedPacket = new Packet({
				...packet,
				payload: encryptedPayload,
			});

			// 3. Hand off to the Core's routing logic
			await this.rnsCore.sendPacket(encryptedPacket);
		} catch (e) {
			console.error("Link encryption failed:", e);
		}
	}
}

/**
 * Handles the cryptographic derivation of link keys.
 */
export class LinkEncryption {
	/**
	 * Derives a symmetric link key using ECIES (X25519 + HKDF).
	 * @param {CryptoKey} localPrivateX25519 - Local ephemeral X25519 private key.
	 * @param {CryptoKey} remotePublicX25519 - Remote ephemeral X25519 public key.
	 * @param {Uint8Array} salt - Salt for HKDF (typically the identity hash).
	 * @returns {Promise<Uint8Array>} A 64-byte key for Token (AES_256_CBC mode).
	 */
	static async deriveLinkKey(localPrivateX25519, remotePublicX25519, salt) {
		// 1. ECDH Shared Secret
		const sharedSecretBits = await crypto.subtle.deriveBits(
			{ name: "X25519", public: remotePublicX25519 },
			localPrivateX25519,
			256,
		);

		// 2. Import Master Key for HKDF
		const hkdfMasterKey = await crypto.subtle.importKey(
			"raw",
			sharedSecretBits,
			{ name: "HKDF" },
			false,
			["deriveKey"],
		);

		// 3. Derive 64-byte key for Token (AES_256_CBC mode)
		// We use HKDF to expand the shared secret into a 64-byte key.
		return await hkdf(hkdfMasterKey, salt, new Uint8Array(0), 64);
	}
}
