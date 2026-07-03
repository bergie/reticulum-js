import assert from "node:assert";
import { decryptAES, deriveKey, encryptAES } from "../../src/crypto/ciphers.js";

async function testCiphers() {
	console.log("Testing Ciphers...");

	// 1. Test HKDF and AES-CBC
	const masterSecret = new Uint8Array(32).fill(0x01);
	const salt = new Uint8Array(16).fill(0x02);
	const info = new Uint8Array([0x52, 0x4e, 0x53]); // "RNS"

	// Import master secret as a key for HKDF
	const masterKey = await crypto.subtle.importKey(
		"raw",
		masterSecret,
		{ name: "HKDF" },
		false,
		["deriveKey"],
	);

	const aesKey = await deriveKey(masterKey, salt, info, 128, "AES-CBC", [
		"encrypt",
		"decrypt",
	]);

	const iv = crypto.getRandomValues(new Uint8Array(16));
	const plaintext = new TextEncoder().encode("Hello, Reticulum!");

	const ciphertext = await encryptAES(aesKey, iv, plaintext);
	assert.notStrictEqual(ciphertext, plaintext);

	const decrypted = await decryptAES(aesKey, iv, ciphertext);
	const decryptedText = new TextDecoder().decode(decrypted);
	assert.strictEqual(decryptedText, "Hello, Reticulum!");

	console.log("Ciphers tests passed!");
}

testCiphers().catch((err) => {
	console.error("Tests failed!");
	console.error(err);
	process.exit(1);
});
