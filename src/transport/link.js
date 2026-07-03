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
	 * @param {Uint8Array} destinationHash - The remote destination hash.
	 * @param {ReadableStream} remoteStream - The raw stream from the interface (yielding Packets).
	 * @param {WritableStream} localStream - The raw stream to the interface (accepting bytes).
	 * @param {number} [mtu=1024] - The Maximum Transmission Unit.
	 */
	constructor(tokenKey, destinationHash, remoteStream, localStream, mtu = 1024) {
		super();
		this.tokenKey = tokenKey;
		this.destinationHash = destinationHash;
		this.remoteStream = remoteStream;
		this.localStream = localStream;
		this.mtu = mtu;
		this.token = new Token(tokenKey);

		/** @type {Set<ReadableStreamDefaultController>} */
		this._controllers = new Set();
		this._isReading = false;

		/** @type {Set<import("../core/resource.js").Resource>} */
		this.incoming_resources = new Set();
		/** @type {Set<import("../core/resource.js").Resource>} */
		this.outgoing_resources = new Set();

		this.readable = this._createDecryptionStream();
		this.writable = this._createEncryptionStream();

		this._startReading();
	}

	/**
	 * Starts the reading loop.
	 * @private
	 */
	async _startReading() {
		if (this._isReading) return;
		this._isReading = true;

		const reader = this.remoteStream.getReader();
		const token = this.token;

		try {
			while (true) {
				const { value: packet, done } = await reader.read();
				if (done) {
					break;
				}

				try {
					const decryptedPayload = await token.decrypt(packet.payload);
					if (decryptedPayload) {
						const decryptedPacket = new packet.constructor({
							...packet,
							payload: decryptedPayload,
						});

						// Emit event
						this.dispatchEvent(
							new CustomEvent("packet", { detail: decryptedPacket }),
						);

						// Handle specialized context packets
						if (decryptedPacket.contextFlag) {
							if (decryptedPacket.contextByte === 0x04) { // RESOURCE_ADV
								this.dispatchEvent(
									new CustomEvent("resource_advertisement", {
										detail: decryptedPacket,
									}),
								);
							} else if (
								decryptedPacket.contextByte === 0x05 || // RESOURCE_REQ
								decryptedPacket.contextByte === 0x06 || // RESOURCE_HMU
								decryptedPacket.contextByte === 0x07 || // RESOURCE_ICL
								decryptedPacket.contextByte === 0x08    // RESOURCE_RCL
							) {
								this.dispatchEvent(
									new CustomEvent("resource_part", {
										detail: decryptedPacket,
									}),
								);
							}
						}

						// Enqueue to all active consumers
						for (const controller of this._controllers) {
							try {
								controller.enqueue(decryptedPacket);
							} catch (_e) {
								// Controller might be closed
								this._controllers.delete(controller);
							}
						}
					}
				} catch (e) {
					console.error("Link decryption failed:", e);
				}
			}
		} catch (e) {
			console.error("Link reading loop error:", e);
		} finally {
			this._isReading = false;
			// Close all controllers
			for (const controller of this._controllers) {
				controller.close();
			}
			this._controllers.clear();
			reader.releaseLock();
		}
	}

	/**
	 * Registers an incoming resource.
	 * @param {import("../core/resource.js").Resource} resource
	 */
	register_incoming_resource(resource) {
		this.incoming_resources.add(resource);
	}

	/**
	 * Registers an outgoing resource.
	 * @param {import("../core/resource.js").Resource} resource
	 */
	register_outgoing_resource(resource) {
		this.outgoing_resources.add(resource);
	}

	/**
	 * Creates the decryption stream.
	 * @private
	 * @returns {ReadableStream}
	 */
	_createDecryptionStream() {
		return new ReadableStream({
			start: (controller) => {
				this._controllers.add(controller);
			},
			pull() {
				// We don't need to pull anything here as _startReading handles it
			},
			cancel: () => {
				// We don't want to stop the whole loop if one consumer cancels.
				// But we don't have a way to know which controller to remove from this function.
				// For now, we'll just rely on the error handling in the loop.
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
		const token = this.token;

		return new WritableStream({
			async write(packet, _controller) {
				try {
					const encryptedPayload = await token.encrypt(packet.payload);
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
