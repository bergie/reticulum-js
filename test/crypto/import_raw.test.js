import { generateEd25519KeyPair, generateX25519KeyPair, exportPublicKey, exportPrivateKey } from '../../src/crypto/keys.js';
import assert from 'node:assert';

async function test() {
    const ed25519 = await generateEd25519KeyPair();
    const edPkcs8 = await crypto.subtle.exportKey("pkcs8", ed25519.privateKey);
    const edRaw = new Uint8Array(edPkcs8).slice(-32);
    console.log("Ed25519 raw:", Buffer.from(edRaw).toString('hex'));

    try {
        const key = await crypto.subtle.importKey(
            "raw",
            edRaw,
            { name: "Ed25519" },
            true,
            ["verify"]
        );
        console.log("Ed25519 import raw success with verify usage!");
    } catch (e) {
        console.log("Ed25519 import raw failed with verify usage:", e.message);
    }

    const x25519 = await generateX25519KeyPair();
    const xPkcs8 = await crypto.subtle.exportKey("pkcs8", x25519.privateKey);
    const xRaw = new Uint8Array(xPkcs8).slice(-32);
    console.log("X25519 raw:", Buffer.from(xRaw).toString('hex'));

    try {
        const key = await crypto.subtle.importKey(
            "raw",
            xRaw,
            { name: "X25519" },
            true,
            ["deriveKey", "deriveBits"]
        );
        console.log("X25519 import raw success!");
    } catch (e) {
        console.log("X25519 import raw failed:", e.message);
    }
}

test();
