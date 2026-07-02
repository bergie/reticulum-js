import { 
    generateEd25519KeyPair, 
    exportPublicKey, 
    importEd25519PublicKey,
    generateX25519KeyPair,
    exportPublicKey as exportX25519PublicKey,
    importX25519PublicKey,
    exportPrivateKey,
    importEd25519PrivateKey,
    importX25519PrivateKey
} from '../../src/crypto/keys.js';
import assert from 'node:assert';

async function testEd25519() {
    console.log("Testing Ed25519...");
    const { privateKey, publicKey } = await generateEd25519KeyPair();
    
    // Test Public Key Export/Import
    const rawPub = await exportPublicKey(publicKey);
    assert.strictEqual(rawPub.length, 32);
    const importedPub = await importEd25519PublicKey(rawPub);
    assert.notStrictEqual(importedPub, publicKey);
    
    // Test Private Key Export/Import (PKCS#8)
    const pkcs8Priv = await exportPrivateKey(privateKey);
    // PKCS8 for Ed25519 is longer than 32 bytes
    assert.ok(pkcs8Priv.length > 32);
    const importedPriv = await importEd25519PrivateKey(pkcs8Priv);
    assert.notStrictEqual(importedPriv, privateKey);
    
    console.log("Ed25519 tests passed!");
}

async function testX25519() {
    console.log("Testing X25519...");
    const { privateKey, publicKey } = await generateX25519KeyPair();
    
    // Test Public Key Export/Import
    const rawPub = await exportX25519PublicKey(publicKey);
    assert.strictEqual(rawPub.length, 32);
    const importedPub = await importX25519PublicKey(rawPub);
    assert.notStrictEqual(importedPub, publicKey);
    
    // Test Private Key Export/Import (PKCS#8)
    const pkcs8Priv = await exportPrivateKey(privateKey);
    assert.ok(pkcs8Priv.length > 32);
    const importedPriv = await importX25519PrivateKey(pkcs8Priv);
    assert.notStrictEqual(importedPriv, privateKey);
    
    console.log("X25519 tests passed!");
}

async function runTests() {
    try {
        await testEd25519();
        await testX25519();
        console.log("All tests passed!");
    } catch (err) {
        console.error("Tests failed!");
        console.error(err);
        process.exit(1);
    }
}

runTests();
