import { test } from 'node:test';
import assert from 'node:assert';
import { Identity } from '../../src/core/identity.js';
import { LXMessage } from '../../src/lxmf/message.js';

test('LXMessage serialization', async (t) => {
	const identity = await Identity.generate();
	const destHash = new Uint8Array(16).fill(0xAA);
	const content = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
	const title = "Test Title";
	const fields = { "test": "field" };

	const { messageId, wireData } = await LXMessage.serialize(
		identity,
		destHash,
		content,
		title,
		fields
	);

	await t.test('messageId length and format', () => {
		assert.strictEqual(messageId.length, 16);
	});

	await t.test('wireData length and format', async () => {
		// 96 + msgpackPayload.length
		// We don't know msgpackPayload.length exactly without encoding, but we know it's at least 96
		assert.ok(wireData.length >= 96);

		// Check destination hash
		const decodedDestHash = wireData.slice(0, 16);
		assert.deepStrictEqual(decodedDestHash, destHash);

		// Check source hash (identityHash)
		const decodedSourceHash = wireData.slice(16, 32);
		assert.deepStrictEqual(decodedSourceHash, identity.identityHash);

		// Check signature length (64 bytes)
		// The signature is at bytes 32 to 96
		const signature = wireData.slice(32, 96);
		assert.strictEqual(signature.length, 64);

		// Verify signature
		const isValid = await identity.validate(signature, messageId);
		assert.strictEqual(isValid, true);
	});
});
