import assert from "node:assert";
import {
	exportPrivateKey,
	exportPublicKey,
	generateEd25519KeyPair,
	generateX25519KeyPair,
} from "../../src/crypto/keys.js";

async function test() {
	const ed25519 = await generateEd25519KeyPair();
	const edPkcs8 = await crypto.subtle.exportKey("pkcs8", ed25519.privateKey);
	const edRaw = new Uint8Array(edPkcs8).slice(-32);
	console.log("Ed25519 raw:", Buffer.from(edRaw).toString("hex"));

	const edWrapped = new Uint8Array([
		0x30,
		0x2e,
		0x02,
		0x01,
		0x00,
		0x30,
		0x05,
		0x06,
		0x03,
		0x2b,
		0x65,
		0x70,
		0x04,
		0x22,
		0x04,
		0x20,
		...edRaw,
	]);

	try {
		const key = await crypto.subtle.importKey(
			"pkcs8",
			edWrapped,
			{ name: "Ed25519" },
			true,
			["sign"],
		);
		console.log("Ed25519 import wrapped success with sign usage!");
	} catch (e) {
		console.log("Ed25519 import wrapped failed with sign usage:", e.message);
	}

	const x25519 = await generateX25519KeyPair();
	const xPkcs8 = await crypto.subtle.exportKey("pkcs8", x25519.privateKey);
	const xRaw = new Uint8Array(xPkcs8).slice(-32);
	console.log("X25519 raw:", Buffer.from(xRaw).toString("hex"));

	const xWrapped = new Uint8Array([
		0x30,
		0x2e,
		0x02,
		0x01,
		0x00,
		0x30,
		0x05,
		0x06,
		0x03,
		0x2b,
		0x65,
		0x6e,
		0x04,
		0x22,
		0x04,
		0x20,
		...xRaw,
	]);

	try {
		const key = await crypto.subtle.importKey(
			"pkcs8",
			xWrapped,
			{ name: "X25519" },
			true,
			["deriveKey", "deriveBits"],
		);
		console.log("X25519 import wrapped success!");
	} catch (e) {
		console.log("X25519 import wrapped failed:", e.message);
	}
}

test();
