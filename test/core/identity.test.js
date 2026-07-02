import { Identity } from '../../src/core/identity.js';
import assert from 'node:assert';
import test from 'node:test';

test('Identity generation and keys', async (t) => {
    const identity = await Identity.generate();
    assert.ok(identity.identityHash);
    assert.strictEqual(identity.identityHash.length, 16);

    const privKey = await identity.getPrivateKey();
    assert.strictEqual(privKey.length, 128);

    const pubKey = await identity.getPublicKey();
    assert.strictEqual(pubKey.length, 64);
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
    const privKey = await identity.getPrivateKey();
    
    const newIdentity = await Identity.fromBytes(privKey);
    assert.ok(newIdentity);
    assert.deepStrictEqual(newIdentity.identityHash, identity.identityHash);

    const decrypted = await newIdentity.encrypt(new Uint8Array([1, 2, 3]));
    const plaintext = await identity.decrypt(decrypted);
    assert.deepStrictEqual(plaintext, new Uint8Array([1, 2, 3]));
});
