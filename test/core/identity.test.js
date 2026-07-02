import { Identity } from '../../src/core/identity.js';
import assert from 'node:assert';
import test from 'node:test';

test('Identity generation and keys', async (t) => {
    const identity = await Identity.generate();
    assert.ok(identity.identity_hash);
    assert.strictEqual(identity.identity_hash.length, 16);

    const priv_key = await identity.get_private_key();
    assert.strictEqual(priv_key.length, 64);

    const pub_key = await identity.get_public_key();
    assert.strictEqual(pub_key.length, 64);
});

test('Identity sign and validate', async (t) => {
    const identity = await Identity.generate();
    const message = new Uint8Array([1, 2, 3, 4]);
    const signature = await identity.sign(message);
    assert.ok(signature.length > 0);

    const isValid = await identity.validate(signature, message);
    assert.strictEqual(isValid, true);

    const isValidWrongMessage = await identity.validate(signature, new Uint8Array([1, 2, 3, 5]));
    assert.strictEqual(isValidWrongMessage, false);
});

test('Identity encryption and decryption', async (t) => {
    const identity = await Identity.generate();
    const plaintext = new Uint8Array([10, 20, 30, 40, 50]);

    const ciphertext = await identity.encrypt(plaintext);
    assert.notStrictEqual(ciphertext, plaintext);

    const decrypted = await identity.decrypt(ciphertext);
    assert.deepStrictEqual(decrypted, plaintext);
});

test('Identity from bytes', async (t) => {
    const identity = await Identity.generate();
    const priv_key = await identity.get_private_key();
    
    const new_identity = await Identity.from_bytes(priv_key);
    assert.ok(new_identity);
    assert.deepStrictEqual(new_identity.identity_hash, identity.identity_hash);

    const decrypted = await new_identity.encrypt(new Uint8Array([1, 2, 3]));
    const plaintext = await identity.decrypt(decrypted);
    assert.deepStrictEqual(plaintext, new Uint8Array([1, 2, 3]));
});
