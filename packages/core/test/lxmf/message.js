import assert from "node:assert";
import fs from "node:fs";
import { test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import { Message } from "../../src/lxmf/message.js";
import {
  generateStamp,
  WORKBLOCK_EXPAND_ROUNDS_PEERING,
} from "../../src/lxmf/stamper.js";

const fixtures = JSON.parse(
  fs.readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
);

const hexToBytes = (/** @type {string} */ hex) =>
  new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));

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
    // messageId is now exposed on the deserialized message (§5.5).
    assert.deepStrictEqual(deserializedMsg.messageId, messageId);
    assert.strictEqual(deserializedMsg.stamp, null);
  });

  await t.test(
    "verifySignature validates against the sender identity",
    async () => {
      const deserializedMsg = await Message.deserialize(wireData, destHash);
      assert.ok(await deserializedMsg.verifySignature(identity));
    },
  );
});

test("Stamp handling (§5.7)", async (t) => {
  await t.test(
    "serialize includes the stamp as 5th payload element",
    async () => {
      const identity = await Identity.generate();
      const destHash = new Uint8Array(16).fill(0xcc);
      const sourceHash = new Uint8Array(16).fill(0xdd);
      const stamp = crypto.getRandomValues(new Uint8Array(32));

      const msg = new Message({
        sourceHash,
        destinationHash: destHash,
        title: "T",
        content: "C",
        fields: {},
        stamp,
      });
      const { wireData } = await msg.serialize(identity);

      // Wire layout: dest(16) + source(16) + sig(64) + payload
      const deserialized = await Message.deserialize(wireData, destHash);
      assert.deepStrictEqual(deserialized.stamp, stamp);
    },
  );

  await t.test(
    "deserialize strips the stamp before hashing (Python compatibility)",
    async () => {
      const { packed_hex, pubkey_hex, message_id_hex, stamp_hex } =
        fixtures.stamped;
      const wireData = hexToBytes(packed_hex);
      const destHash = wireData.slice(0, 16);

      const msg = await Message.deserialize(wireData, destHash);
      // The 5th-element stamp must be extracted verbatim.
      assert.deepStrictEqual(msg.stamp, hexToBytes(stamp_hex));
      // The message_id must be computed over the stamp-stripped 4-element payload.
      assert.deepStrictEqual(msg.messageId, hexToBytes(message_id_hex));
      // Title/content round-trip.
      assert.strictEqual(msg.title, "StampTest");
      assert.strictEqual(msg.content, "Hello stamped!");

      // Signature must verify once the stamp is stripped.
      const identity = await Identity.fromPublicKey(hexToBytes(pubkey_hex));
      assert.ok(await msg.verifySignature(identity));
    },
  );

  await t.test(
    "a PoW stamp generated for the message_id validates",
    async () => {
      const identity = await Identity.generate();
      const destHash = new Uint8Array(16).fill(0xee);
      const nameHash = new Uint8Array(10).fill(0x11);
      const combined = new Uint8Array(
        nameHash.length + identity.identityHash.length,
      );
      combined.set(nameHash, 0);
      combined.set(identity.identityHash, nameHash.length);
      const sourceHash = new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", combined),
      ).subarray(0, 16);

      // First pack without a stamp to learn the message_id.
      const timestamp = Math.floor(Date.now() / 1000);
      const base = new Message({
        sourceHash,
        destinationHash: destHash,
        timestamp,
        content: "pow",
        fields: {},
      });
      const { messageId } = await base.serialize(identity);

      // Generate a cheap PoW stamp for that message_id and resend with it.
      const [stamp] = await generateStamp(
        messageId,
        6,
        WORKBLOCK_EXPAND_ROUNDS_PEERING,
      );
      const stamped = new Message({
        sourceHash,
        destinationHash: destHash,
        timestamp,
        content: "pow",
        fields: {},
        stamp,
      });
      const { wireData } = await stamped.serialize(identity);

      const received = await Message.deserialize(wireData, destHash);
      assert.deepStrictEqual(received.stamp, stamp);
      assert.ok(await received.verifySignature(identity));
      assert.deepStrictEqual(received.messageId, messageId);
    },
  );
});

test("Signature verification tolerance (§5.6)", async (t) => {
  await t.test(
    "path-2 re-encode fallback verifies a uint-encoded timestamp",
    async () => {
      const identity = await Identity.generate();
      const destHash = new Uint8Array(16).fill(0xaa);
      const nameHash = new Uint8Array(10).fill(0xbb);
      const combined = new Uint8Array(
        nameHash.length + identity.identityHash.length,
      );
      combined.set(nameHash, 0);
      combined.set(identity.identityHash, nameHash.length);
      const sourceHash = new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", combined),
      ).subarray(0, 16);

      // Build a canonical message and pack it.
      const timestamp = Math.floor(Date.now() / 1000); // integer-valued
      const msg = new Message({
        sourceHash,
        destinationHash: destHash,
        timestamp,
        content: "hello",
        title: "",
        fields: {},
      });
      const { messageId, wireData } = await msg.serialize(identity);

      // Tamper with the wire payload: replace the float64 timestamp byte
      // (0xcb) with a uint32 encoding (0xce) of the same value. This mimics a
      // relay that re-encoded the timestamp with a different msgpack encoder.
      // Layout inside payload: [0x94][0xcb <8 bytes ts>][title][content][fields]
      const tampered = new Uint8Array(wireData);
      const payloadStart = 16 + 16 + 64;
      assert.strictEqual(tampered[payloadStart], 0x94); // fixarray 4
      assert.strictEqual(tampered[payloadStart + 1], 0xcb); // float64
      // float64 occupies 1 type byte + 8 payload bytes; uint32 is 1 + 4.
      // Rebuild the payload with a uint32 timestamp instead.
      const tsBytes = tampered.subarray(payloadStart + 2, payloadStart + 10);
      const dv = new DataView(tsBytes.buffer, tsBytes.byteOffset, 8);
      const tsVal = dv.getFloat64(0, false);
      assert.strictEqual(tsVal, timestamp); // sanity: integer-valued
      const tsUint = new Uint8Array([
        0xce,
        (tsVal >>> 24) & 0xff,
        (tsVal >>> 16) & 0xff,
        (tsVal >>> 8) & 0xff,
        tsVal & 0xff,
      ]);
      const tail = tampered.subarray(payloadStart + 10);
      const newPayload = new Uint8Array(1 + tsUint.length + tail.length);
      newPayload[0] = 0x94;
      newPayload.set(tsUint, 1);
      newPayload.set(tail, 1 + tsUint.length);
      const tamperedWire = new Uint8Array(payloadStart + newPayload.length);
      tamperedWire.set(tampered.subarray(0, payloadStart), 0);
      tamperedWire.set(newPayload, payloadStart);

      const received = await Message.deserialize(tamperedWire, destHash);
      // Raw path-1 should fail (uint bytes != signer's float64 bytes)...
      assert.ok(
        !(await identity.validate(received.signature, received.signedPart)),
      );
      // The tampered messageId legitimately differs from the canonical one.
      assert.notDeepStrictEqual(received.messageId, messageId);
      // ...but the re-encode fallback must succeed.
      assert.ok(await received.verifySignature(identity));
    },
  );
});
