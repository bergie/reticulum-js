import assert from "node:assert";
import test from "node:test";
import {
  createAnnounceRandomHash,
  Destination,
  Direction,
} from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { bytesEqual } from "../../src/utils/encoding.js";

test("Identity generation and keys", async (t) => {
  const identity = await Identity.generate();
  assert.ok(identity.identityHash);
  assert.strictEqual(identity.identityHash.length, 16);

  const privKey = await identity.getPrivateKey();
  assert.strictEqual(privKey.length, 128);

  const pubKey = await identity.getPublicKey();
  assert.strictEqual(pubKey.length, 64);
});

test("Identity sign and validate", async (t) => {
  const identity = await Identity.generate();
  const message = new Uint8Array([1, 2, 3, 4]);
  const signature = await identity.sign(message);
  assert.ok(signature.length > 0);

  const isValid = await identity.validate(signature, message);
  assert.strictEqual(isValid, true);

  const isValidWrongMessage = await identity.validate(
    signature,
    new Uint8Array([1, 2, 3, 5]),
  );
  assert.strictEqual(isValidWrongMessage, false);
});

test("Identity encryption and decryption", async (t) => {
  const identity = await Identity.generate();
  const plaintext = new Uint8Array([10, 20, 30, 40, 50]);

  const ciphertext = await identity.encrypt(plaintext);
  assert.notStrictEqual(ciphertext, plaintext);

  const decrypted = await identity.decrypt(ciphertext);
  assert.deepStrictEqual(decrypted, plaintext);
});

test("Identity from bytes", async (t) => {
  const identity = await Identity.generate();
  const privKey = await identity.getPrivateKey();

  const newIdentity = await Identity.fromBytes(privKey);
  assert.ok(newIdentity);
  assert.deepStrictEqual(newIdentity.identityHash, identity.identityHash);

  const decrypted = await newIdentity.encrypt(new Uint8Array([1, 2, 3]));
  const plaintext = await identity.decrypt(decrypted);
  assert.deepStrictEqual(plaintext, new Uint8Array([1, 2, 3]));
});

test("Identity.getRandomHash returns 16 random bytes", async () => {
  const a = Identity.getRandomHash();
  const b = Identity.getRandomHash();
  assert.strictEqual(a.length, 16);
  assert.strictEqual(b.length, 16);
  // Two draws should not be identical (collision probability is ~1/2^128).
  assert.notDeepStrictEqual(Array.from(a), Array.from(b));
});

// --- validateAnnounce (SPEC.md §4.5) ---------------------------------------

/**
 * Builds an announce body the same way `Destination.announce` does, but
 * parameterised over the ratchet so both the context_flag=0 and context_flag=1
 * body layouts can be exercised. Mirrors §4.1 (body) and §4.2 (signed_data).
 *
 * @param {Identity} identity
 * @param {Uint8Array} destinationHash - signed over (§4.2).
 * @param {Uint8Array} nameHash
 * @param {Uint8Array|null} ratchet - 32-byte ratchet pub, or null for context_flag=0.
 * @param {Uint8Array|null} appData
 * @returns {Promise<{ body: Uint8Array, randomHash: Uint8Array, signature: Uint8Array }>}
 */
async function buildAnnounceBody(
  identity,
  destinationHash,
  nameHash,
  ratchet,
  appData,
) {
  const pubKey = await identity.getPublicKey();
  const randomHash = createAnnounceRandomHash(
    Identity.getRandomHash(),
    Math.floor(Date.now() / 1000),
  );
  const ratchetForSig = ratchet ?? new Uint8Array(0);
  const appDataForSig = appData ?? new Uint8Array(0);
  const signedData = new Uint8Array(
    destinationHash.length +
      pubKey.length +
      nameHash.length +
      randomHash.length +
      ratchetForSig.length +
      appDataForSig.length,
  );
  let o = 0;
  signedData.set(destinationHash, o);
  o += destinationHash.length;
  signedData.set(pubKey, o);
  o += pubKey.length;
  signedData.set(nameHash, o);
  o += nameHash.length;
  signedData.set(randomHash, o);
  o += randomHash.length;
  signedData.set(ratchetForSig, o);
  o += ratchetForSig.length;
  signedData.set(appDataForSig, o);
  const signature = await identity.sign(signedData);

  const sigOffset = ratchet ? 116 : 84;
  const body = new Uint8Array(sigOffset + 64 + (appData ? appData.length : 0));
  body.set(pubKey, 0);
  body.set(nameHash, 64);
  body.set(randomHash, 74);
  if (ratchet) body.set(ratchet, 84);
  body.set(signature, sigOffset);
  if (appData) body.set(appData, sigOffset + 64);
  return { body, randomHash, signature };
}

test("validateAnnounce accepts a well-formed ratchet-less announce", async () => {
  const identity = await Identity.generate();
  const dest = await Destination.SINGLE("myapp", Direction.IN, identity);
  const { body, randomHash } = await buildAnnounceBody(
    identity,
    dest.destinationHash,
    dest.nameHash,
    null,
    null,
  );
  const result = await Identity.validateAnnounce(
    dest.destinationHash,
    false,
    body,
  );
  assert.ok(result);
  assert.ok(bytesEqual(result.identity.identityHash, identity.identityHash));
  assert.strictEqual(result.ratchet, null);
  assert.ok(bytesEqual(result.randomHash, randomHash));
});

test("validateAnnounce accepts a ratchet-bearing announce (context_flag=1)", async () => {
  const identity = await Identity.generate();
  const dest = await Destination.SINGLE("myapp", Direction.IN, identity);
  // A ratchet is a 32-byte X25519 public key.
  const ratchet = crypto.getRandomValues(new Uint8Array(32));
  const { body } = await buildAnnounceBody(
    identity,
    dest.destinationHash,
    dest.nameHash,
    ratchet,
    null,
  );
  const result = await Identity.validateAnnounce(
    dest.destinationHash,
    true,
    body,
  );
  assert.ok(result);
  assert.ok(bytesEqual(result.ratchet, ratchet));
});

test("validateAnnounce preserves app_data", async () => {
  const identity = await Identity.generate();
  const dest = await Destination.SINGLE("myapp", Direction.IN, identity);
  const appData = new Uint8Array([1, 2, 3, 4, 5]);
  const { body } = await buildAnnounceBody(
    identity,
    dest.destinationHash,
    dest.nameHash,
    null,
    appData,
  );
  const result = await Identity.validateAnnounce(
    dest.destinationHash,
    false,
    body,
  );
  assert.ok(result);
  assert.ok(result.appData);
  assert.ok(bytesEqual(result.appData, appData));
});

test("validateAnnounce rejects a tampered signature", async () => {
  const identity = await Identity.generate();
  const dest = await Destination.SINGLE("myapp", Direction.IN, identity);
  const { body } = await buildAnnounceBody(
    identity,
    dest.destinationHash,
    dest.nameHash,
    null,
    null,
  );
  // Flip a byte inside the signature slot [84:148].
  body[90] ^= 0xff;
  const result = await Identity.validateAnnounce(
    dest.destinationHash,
    false,
    body,
  );
  assert.strictEqual(result, null);
});

test("validateAnnounce rejects a destination_hash that does not match (name_hash, public_key)", async () => {
  const identity = await Identity.generate();
  const dest = await Destination.SINGLE("myapp", Direction.IN, identity);
  // Sign over a bogus dest_hash that no (name_hash, public_key) pair hashes to.
  const fakeDest = crypto.getRandomValues(new Uint8Array(16));
  assert.ok(!bytesEqual(fakeDest, dest.destinationHash));
  const { body } = await buildAnnounceBody(
    identity,
    fakeDest,
    dest.nameHash,
    null,
    null,
  );
  // Signature is valid (signed over fakeDest) but the recomputed dest_hash
  // (from name_hash + public_key) differs from fakeDest → rejected at step 3.
  const result = await Identity.validateAnnounce(fakeDest, false, body);
  assert.strictEqual(result, null);
});

test("validateAnnounce rejects a too-short body", async () => {
  const result = await Identity.validateAnnounce(
    new Uint8Array(16),
    false,
    new Uint8Array(10),
  );
  assert.strictEqual(result, null);
});

test("validateAnnounce rejects when the body is too short for a ratchet announce", async () => {
  // A 148-byte body is long enough for context_flag=0 but too short for
  // context_flag=1 (which needs 180). A parser that didn't branch on
  // context_flag would accept this and read a bogus signature.
  const identity = await Identity.generate();
  const dest = await Destination.SINGLE("myapp", Direction.IN, identity);
  const { body } = await buildAnnounceBody(
    identity,
    dest.destinationHash,
    dest.nameHash,
    null,
    null,
  );
  assert.ok(body.length < 180);
  const result = await Identity.validateAnnounce(
    dest.destinationHash,
    true,
    body,
  );
  assert.strictEqual(result, null);
});
