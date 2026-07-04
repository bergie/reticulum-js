/**
 * @file identity.js
 * @description Identity creation, signing, and verification
 */

import { hkdf } from "../crypto/ciphers.js";
import {
	exportPublicKey,
	exportRawPrivateKey,
	generateEd25519KeyPair,
	generateX25519KeyPair,
	importEd25519PublicKey,
	importRawEd25519PrivateKey,
	importRawX25519PrivateKey,
	importX25519PublicKey,
} from "../crypto/keys.js";
import { Token } from "../crypto/token.js";

/**
 * Represents a Reticulum Identity.
 */
export class Identity extends EventTarget {
	static TRUNCATED_HASHLENGTH = 128;

	/**
	 * @param {CryptoKey|null} x25519Priv
	 * @param {CryptoKey|null} ed25519Priv
	 * @param {CryptoKey} x25519Pub
	 * @param {CryptoKey} ed25519Pub
	 * @param {Uint8Array} publicKey
	 * @param {Uint8Array} identityHash
	 */
	constructor(
		x25519Priv,
		ed25519Priv,
		x25519Pub,
		ed25519Pub,
		publicKey,
		identityHash,
	) {
		super();
		this.x25519Priv = x25519Priv;
		this.ed25519Priv = ed25519Priv;
		this.x25519Pub = x25519Pub;
		this.ed25519Pub = ed25519Pub;
		this.publicKey = publicKey;
		this.identityHash = identityHash;
		this.appData = null;
	}

	/**
	 * Attempts to load an identity from a storage adapter, or generates and saves a new one.
	 * @param {Object} [storageAdapter] - Must implement async loadKey() and async saveKey(bytes)
	 * @returns {Promise<Identity>}
	 */
	static async loadOrGenerate(storageAdapter) {
		if (!storageAdapter) {
			console.warn(
				"No storage adapter provided. Generating ephemeral identity.",
			);
			return await Identity.generate();
		}

		try {
			const savedBytes = await storageAdapter.loadKey();
			// Reticulum private keys export to exactly 128 bytes
			if (savedBytes && savedBytes.length === 128) {
				const identity = await Identity.fromBytes(savedBytes);
				if (identity) {
					return identity;
				}
			}
		} catch (e) {
			console.warn(
				"Failed to load identity from storage, generating new one:",
				e,
			);
		}

		// Fallback to generation if the file is missing or corrupt
		const newIdentity = await Identity.generate();
		const privateBytes = await newIdentity.getPrivateKey();
		await storageAdapter.saveKey(privateBytes);

		return newIdentity;
	}

	/**
	 * Get a SHA-256 hash of passed data.
	 * @param {Uint8Array} data
	 * @returns {Promise<Uint8Array>}
	 */
	static async fullHash(data) {
		const hashBuffer = await crypto.subtle.digest(
			"SHA-256",
			/** @type {any} */ (data),
		);
		return new Uint8Array(hashBuffer);
	}

	/**
	 * Get a truncated SHA-256 hash of passed data.
	 * @param {Uint8Array} data
	 * @returns {Promise<Uint8Array>}
	 */
	static async truncatedHash(data) {
		const fullHash = await Identity.fullHash(data);
		return fullHash.slice(0, Identity.TRUNCATED_HASHLENGTH / 8);
	}

	/**
	 * Load an identity from a public key.
	 * @param {Uint8Array} publicKey
	 * @returns {Promise<Identity>}
	 */
	static async fromPublicKey(publicKey) {
		const x25519PubBytes = publicKey.slice(0, 32);
		const ed25519PubBytes = publicKey.slice(32, 64);

		const x25519Pub = await crypto.subtle.importKey(
			"raw",
			/** @type {any} */ (x25519PubBytes),
			{ name: "X25519" },
			true,
			[],
		);
		const ed25519Pub = await crypto.subtle.importKey(
			"raw",
			/** @type {any} */ (ed25519PubBytes),
			{ name: "Ed25519" },
			true,
			[],
		);

		const identityHash = await Identity.truncatedHash(publicKey);

		return new Identity(
			null,
			null,
			x25519Pub,
			ed25519Pub,
			publicKey,
			identityHash,
		);
	}

	/**
	 * Create a new random identity.
	 * @returns {Promise<Identity>}
	 */
	static async generate() {
		const x25519 = await generateX25519KeyPair();
		const ed25519 = await generateEd25519KeyPair();

		const x25519PubBytes = await exportPublicKey(x25519.publicKey);
		const ed25519PubBytes = await exportPublicKey(ed25519.publicKey);

		const publicKey = new Uint8Array(64);
		publicKey.set(x25519PubBytes, 0);
		publicKey.set(ed25519PubBytes, 32);

		const identityHash = await Identity.truncatedHash(publicKey);

		return new Identity(
			x25519.privateKey,
			ed25519.privateKey,
			x25519.publicKey,
			ed25519.publicKey,
			publicKey,
			identityHash,
		);
	}

	/**
	 * Get the raw private key bytes (64 bytes).
	 * @returns {Promise<Uint8Array>}
	 */
	async getPrivateKey() {
		if (!this.x25519Priv || !this.ed25519Priv)
			throw new Error(
				"Cannot get private key because identity does not hold a private key",
			);
		const x25519PrivBytes = await exportRawPrivateKey(this.x25519Priv);
		const ed25519PrivBytes = await exportRawPrivateKey(this.ed25519Priv);
		const x25519PubBytes = await exportPublicKey(this.x25519Pub);
		const ed25519PubBytes = await exportPublicKey(this.ed25519Pub);

		const privKey = new Uint8Array(128);
		privKey.set(x25519PrivBytes, 0);
		privKey.set(x25519PubBytes, 32);
		privKey.set(ed25519PrivBytes, 64);
		privKey.set(ed25519PubBytes, 96);
		return privKey;
	}

	/**
	 * Get the public key as bytes.
	 * @returns {Promise<Uint8Array>}
	 */
	async getPublicKey() {
		const x25519PubBytes = await exportPublicKey(this.x25519Pub);
		const ed25519PubBytes = await exportPublicKey(this.ed25519Pub);

		const publicKey = new Uint8Array(64);
		publicKey.set(x25519PubBytes, 0);
		publicKey.set(ed25519PubBytes, 32);
		return publicKey;
	}

	/**
	 * Load an identity from raw bytes.
	 * @param {Uint8Array} bytes
	 * @returns {Promise<Identity|null>}
	 */
	static async fromBytes(bytes) {
		try {
			const x25519Priv = await importRawX25519PrivateKey(bytes.slice(0, 32));
			const x25519Pub = await importX25519PublicKey(bytes.slice(32, 64));
			const ed25519Priv = await importRawEd25519PrivateKey(bytes.slice(64, 96));
			const ed25519Pub = await importEd25519PublicKey(bytes.slice(96, 128));

			const publicKey = new Uint8Array(64);
			publicKey.set(bytes.slice(32, 64), 0);
			publicKey.set(bytes.slice(96, 128), 32);

			const identityHash = await Identity.truncatedHash(publicKey);

			return new Identity(
				x25519Priv,
				ed25519Priv,
				x25519Pub,
				ed25519Pub,
				publicKey,
				identityHash,
			);
		} catch (e) {
			console.error("Failed to load identity from bytes:", e);
			return null;
		}
	}

	/**
	 * Get the salt for HKDF.
	 * @returns {Uint8Array}
	 */
	getSalt() {
		return this.identityHash;
	}

	/**
	 * Get the context for HKDF.
	 * @returns {Uint8Array|null}
	 */
	getContext() {
		return null;
	}

	/**
	 * Encrypt information for the identity.
	 * @param {Uint8Array} plaintext
	 * @param {Uint8Array|null} ratchet
	 * @returns {Promise<Uint8Array>}
	 */
	async encrypt(plaintext, ratchet = null) {
		if (!this.ed25519Pub)
			throw new Error(
				"Encryption failed because identity does not hold a public key",
			);

		const ephemeral_key = await generateX25519KeyPair();
		const ephemeral_pub_bytes = await exportPublicKey(ephemeral_key.publicKey);

		let target_public_key;
		if (ratchet) {
			target_public_key = await crypto.subtle.importKey(
				"raw",
				/** @type {any} */ (ratchet),
				{ name: "X25519" },
				true,
				[],
			);
		} else {
			target_public_key = this.x25519Pub;
		}

		const shared_key_buffer = await crypto.subtle.deriveBits(
			{
				name: "X25519",
				public: target_public_key,
			},
			/** @type {any} */ (ephemeral_key.privateKey),
			256,
		);
		const shared_key = new Uint8Array(shared_key_buffer);
		const derived_key = await hkdf(
			shared_key,
			this.getSalt(),
			this.getContext() || new Uint8Array(0),
			64,
		);

		const token = new Token(derived_key);
		const ciphertext = await token.encrypt(/** @type {any} */ (plaintext));

		const result = new Uint8Array(
			ephemeral_pub_bytes.length + ciphertext.length,
		);
		result.set(ephemeral_pub_bytes, 0);
		result.set(ciphertext, ephemeral_pub_bytes.length);

		return result;
	}

	/**
	 * Decrypt information for the identity.
	 * @param {Uint8Array} ciphertext_token
	 * @param {Array<Uint8Array>|null} ratchets
	 * @returns {Promise<Uint8Array|null>}
	 */
	async decrypt(ciphertext_token, ratchets = null) {
		if (!this.ed25519Priv)
			throw new Error(
				"Decryption failed because identity does not hold a private key",
			);

		if (ciphertext_token.length > 32) {
			const peer_pub_bytes = ciphertext_token.slice(0, 32);
			const ciphertext = ciphertext_token.slice(32);
			const peer_pub = await crypto.subtle.importKey(
				"raw",
				/** @type {any} */ (peer_pub_bytes),
				{ name: "X25519" },
				true,
				[],
			);

			let plaintext = null;

			if (ratchets) {
				for (const ratchet of ratchets) {
					try {
						const ratchet_prv = await importRawX25519PrivateKey(ratchet);
						const shared_key_buffer = await crypto.subtle.deriveBits(
							{
								name: "X25519",
								public: peer_pub,
							},
							/** @type {any} */ (ratchet_prv),
							256,
						);
						const shared_key = new Uint8Array(shared_key_buffer);
						const derived_key = await hkdf(
							shared_key,
							this.getSalt(),
							this.getContext() || new Uint8Array(0),
							64,
						);
						const token = new Token(derived_key);
						plaintext = await token.decrypt(ciphertext);
						if (plaintext) break;
					} catch (e) {
						// continue to next ratchet
					}
				}
			}

			if (!plaintext) {
				try {
					const shared_key_buffer = await crypto.subtle.deriveBits(
						{
							name: "X25519",
							public: peer_pub,
						},
						/** @type {any} */ (this.x25519Priv),
						256,
					);
					const shared_key = new Uint8Array(shared_key_buffer);
					const derived_key = await hkdf(
						shared_key,
						this.getSalt(),
						this.getContext() || new Uint8Array(0),
						64,
					);
					const token = new Token(derived_key);
					plaintext = await token.decrypt(ciphertext);
				} catch (e) {
					plaintext = null;
				}
			}

			return plaintext;
		} else {
			return null;
		}
	}

	/**
	 * Signs information by the identity.
	 * @param {Uint8Array} message
	 * @returns {Promise<Uint8Array>}
	 */
	async sign(message) {
		if (!this.ed25519Priv)
			throw new Error(
				"Signing failed because identity does not hold a private key",
			);
		const signature = await crypto.subtle.sign(
			"Ed25519",
			this.ed25519Priv,
			/** @type {any} */ (message),
		);
		return new Uint8Array(signature);
	}

	/**
	 * Validates the signature of a signed message.
	 * @param {Uint8Array} signature
	 * @param {Uint8Array} message
	 * @returns {Promise<boolean>}
	 */
	async validate(signature, message) {
		if (!this.ed25519Pub)
			throw new Error(
				"Signature validation failed because identity does not hold a public key",
			);
		return await crypto.subtle.verify(
			"Ed25519",
			this.ed25519Pub,
			/** @type {any} */ (signature),
			/** @type {any} */ (message),
		);
	}
}
