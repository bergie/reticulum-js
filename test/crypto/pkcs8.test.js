import { generateEd25519KeyPair, generateX25519KeyPair, exportPublicKey, exportPrivateKey } from '../../src/crypto/keys.js';
import assert from 'node:assert';

async function test() {
    const ed25519 = await generateEd25519KeyPair();
    const x25519 = await generateX25519KeyPair();
    console.log("--- Ed25519 ---");
    try {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", ed25519.privateKey);
        console.log("Ed25519 PKCS8 hex:", Buffer.from(pkcs8).toString('hex'));
    } catch (e) {
        console.log("Ed25519 PKCS8 export failed:", e.message);
    }
    console.log("--- X25519 ---");
    try {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", x25519.privateKey);
        console.log("X25519 PKCS8 hex:", Buffer.from(pkcs8).toString('hex'));
    } catch (e) {
        console.log("X25519 PKCS8 export failed:", e.message);
    }
}

test();
