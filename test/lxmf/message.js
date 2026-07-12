import assert from "node:assert";
import { test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import { Message } from "../../src/lxmf/message.js";

test("Message serialization and deserialization", async (t) => {
  const identity = await Identity.generate();
  const destHash = new Uint8Array(16).fill(0xaa);
  const content = "Test Content";
  const title = "Test Title";
  const fields = { test: "field" };
  const timestamp = Date.now() / 1000.0;

  // Compute a proper sourceHash (the sender's destination hash)
  // source_hash = SHA256(name_hash || identity_hash)[:16]
  const nameHash = new Uint8Array(10).fill(0xbb);
  const combined = new Uint8Array(
    nameHash.length + identity.identityHash.length,
  );
  combined.set(nameHash, 0);
  combined.set(identity.identityHash, nameHash.length);
  const sourceHashBuffer = await globalThis.crypto.subtle.digest(
    "SHA-256",
    combined,
  );
  const sourceHash = new Uint8Array(sourceHashBuffer).slice(0, 16);

  const msg = new Message({
    sourceHash,
    destinationHash: destHash,
    timestamp,
    title,
    content,
    fields,
  });
  const { messageId, wireData } = await msg.serialize(identity);

  await t.test("serialization produces valid wireData", async () => {
    assert.ok(wireData.length >= 96);

    // Check destination hash
    const decodedDestHash = wireData.slice(0, 16);
    assert.deepStrictEqual(decodedDestHash, destHash);

    // Check source hash (should be the calculated sourceHash, not identityHash)
    const decodedSourceHash = wireData.slice(16, 32);
    assert.deepStrictEqual(decodedSourceHash, sourceHash);

    // Check signature length (64 bytes)
    const signature = wireData.slice(32, 96);
    assert.strictEqual(signature.length, 64);

    // Verify signature
    const destinationHash = wireData.slice(0, 16);
    const sourceHashWire = wireData.slice(16, 32);
    const payload = wireData.slice(96);
    const signedPart = new Uint8Array(16 + 16 + payload.length + 32);
    signedPart.set(destinationHash, 0);
    signedPart.set(sourceHashWire, 16);
    signedPart.set(payload, 32);
    signedPart.set(messageId, 16 + 16 + payload.length);

    const isValid = await identity.validate(signature, signedPart);
    assert.strictEqual(isValid, true);
  });

  await t.test("deserialization produces equivalent Message", async () => {
    const deserializedMsg = await Message.deserialize(wireData, destHash);

    assert.deepStrictEqual(deserializedMsg.sourceHash, sourceHash);
    assert.deepStrictEqual(deserializedMsg.destinationHash, destHash);
    assert.strictEqual(deserializedMsg.timestamp, timestamp);
    assert.strictEqual(deserializedMsg.title, title);
    assert.strictEqual(deserializedMsg.content, content);
    assert.deepStrictEqual(deserializedMsg.fields, fields);
  });
});
