/**
 * @file link.js
 * @description Encrypted session management (ECIES)
 */

import { hkdf } from "../crypto/ciphers.js";
import { Token } from "../crypto/token.js";

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

/**
 * Manages an encrypted link between two Reticulum nodes.
 * The Link acts as a TransformStream for Packet objects.
 */
export class Link extends EventTarget {
	/**
	 * @param {Uint8Array} tokenKey - The 64-byte key for the Token.
	 * @param {ReadableStream} remoteStream - The raw stream from the interface (yielding Packets).
	 * @param {WritableStream} localStream - The raw stream to the interface (accepting bytes).
	 */
	constructor(tokenKey, remoteStream, localStream) {
		super();
		this.tokenKey = tokenKey;
		this.remoteStream = remoteStream;
		this.localStream = localStream;
		this.token = new Token(tokenKey);

		this.readable = this._createDecryptionStream();
		this.writable = this._createEncryptionStream();
	}

	/**
	 * Creates the decryption stream.
	 * Consumes Packets from the remoteStream, decrypts their payload, and yields decrypted Packets.
	 * @private
	 * @returns {ReadableStream}
	 */
	_createDecryptionStream() {
		const reader = this.remoteStream.getReader();

		return new ReadableStream({
			async pull(controller) {
				const { value: packet, done } = await reader.read();
				if (done) {
					controller.close();
					return;
				}

				try {
					const decryptedPayload = await this.token.decrypt(packet.payload);
					if (decryptedPayload) {
						const decryptedPacket = new packet.constructor({
							...packet,
							payload: decryptedPayload,
						});
						controller.enqueue(decryptedPacket);
					}
				} catch (e) {
					console.error("Link decryption failed:", e);
				}
			},
			cancel() {
				reader.cancel();
			},
		});
	}

	/**
	 * Creates the encryption stream.
	 * Consumes Packets, encrypts their payload, serializes them, and writes bytes to localStream.
	 * @private
	 * @returns {WritableStream}
	 */
	_createEncryptionStream() {
		const writer = this.localStream.getWriter();

		return new WritableStream({
			async write(packet, controller) {
				try {
					const encryptedPayload = await this.token.encrypt(packet.payload);
					const encryptedPacket = new packet.constructor({
						...packet,
						payload: encryptedPayload,
					});
					const serialized = encryptedPacket.serialize();
					await writer.write(serialized);
				} catch (e) {
					console.error("Link encryption failed:", e);
				}
			},
			close() {
				writer.close();
			},
			abort(reason) {
				writer.abort(reason);
			},
		});
	}
}
