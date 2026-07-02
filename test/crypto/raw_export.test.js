import { generateEd25519KeyPair, generateX25519KeyPair, exportPublicKey, exportPrivateKey } from '../../src/crypto/keys.js';
import assert from 'node:assert';

async function test() {
    const ed25519 = await generateEd25519KeyPair();
    const x25519 = await generateX25519KeyPair();

    try {
        const edPubRaw = await crypto.subtle.exportKey("raw", ed25519.publicKey);
        console.log("Ed25519 pub raw export success, length:", new Uint8Array(edPubRaw).length);
    } catch (e) {
        console.log("Ed25519 pub raw export failed:", e.message);
    }

    try {
        const xPubRaw = await crypto.subtle.exportKey("raw", x25519.publicKey);
        console.log("X25519 pub raw export success, length:", new Uint8Array(xPubRaw).length);
    } catch (e) {
        console.log("X25519 pub raw export failed:", e.message);
    }
}

test();
