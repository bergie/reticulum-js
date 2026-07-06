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

  const msg = new Message(identity.identityHash, destHash, timestamp, title, content, fields);
  const { messageId, wireData } = await msg.serialize(identity);

  await t.test("serialization produces valid wireData", async () => {
    assert.ok(wireData.length >= 96);

    // Check destination hash
    const decodedDestHash = wireData.slice(0, 16);
    assert.deepStrictEqual(decodedDestHash, destHash);

    // Check source hash (identityHash)
    const decodedSourceHash = wireData.slice(16, 32);
    assert.deepStrictEqual(decodedSourceHash, identity.identityHash);

    // Check signature length (64 bytes)
    const signature = wireData.slice(32, 96);
    assert.strictEqual(signature.length, 64);

    // Verify signature
    const destinationHash = wireData.slice(0, 16);
    const sourceHash = wireData.slice(16, 32);
    const payload = wireData.slice(96);
    const signedPart = new Uint8Array(16 + 16 + payload.length + 32);
    signedPart.set(destinationHash, 0);
    signedPart.set(sourceHash, 16);
    signedPart.set(payload, 32);
    signedPart.set(messageId, 16 + 16 + payload.length);

    const isValid = await identity.validate(signature, signedPart);
    assert.strictEqual(isValid, true);
  });

  await t.test("deserialization produces equivalent Message", async () => {
    const deserializedMsg = await Message.deserialize(wireData);

    assert.deepStrictEqual(deserializedMsg.sourceHash, identity.identityHash);
    assert.deepStrictEqual(deserializedMsg.destinationHash, destHash);
    assert.strictEqual(deserializedMsg.timestamp, timestamp);
    assert.strictEqual(deserializedMsg.title, title);
    assert.strictEqual(deserializedMsg.content, content);
    assert.deepStrictEqual(deserializedMsg.fields, fields);
  });
});
