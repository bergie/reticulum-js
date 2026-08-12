/**
 * rfed channel message envelope codec (work doc #25, Phase 0).
 *
 * Verifies the RTID prelude wrap/unwrap round-trip, the canonical byte layout
 * from `RFed/SPEC.md` ("CANONICAL WIRE FORMAT"), and the spec's integrity
 * invariants (magic enforcement, source_hash ≠ identity hash, signature check).
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Identity } from "../../src/core/identity.js";
import { Message } from "../../src/lxmf/message.js";
import {
  parseFanoutPayload,
  parseSendPayload,
  unwrapChannelMessage,
  unwrapRawChannelMessage,
  wrapChannelMessage,
  wrapRawChannelMessage,
} from "../../src/rfed/blob.js";
import { deliveryHashFor, deriveChannel } from "../../src/rfed/channel.js";
import {
  HASH_LENGTH,
  MAGIC_RTID,
  PUBLIC_KEY_LENGTH,
  STAMP_SIZE,
} from "../../src/rfed/constants.js";
import { validateChannelStamp } from "../../src/rfed/stamp.js";
import { toHex } from "../../src/utils/encoding.js";

const CHANNEL_NAME = "public.test";

/**
 * Builds a fresh channel + sender pair for a test.
 * @returns {Promise<{
 *   channelIdentity: Identity, channelHash: Uint8Array,
 *   channelDeliveryHash: Uint8Array, senderIdentity: Identity,
 *   senderDeliveryHash: Uint8Array,
 * }>}
 */
async function fixture() {
  const { identity: channelIdentity, channelHash } =
    await deriveChannel(CHANNEL_NAME);
  const senderIdentity = await Identity.generate();
  return {
    channelIdentity,
    channelHash,
    channelDeliveryHash: await deliveryHashFor(channelIdentity),
    senderIdentity,
    senderDeliveryHash: await deliveryHashFor(senderIdentity),
  };
}

describe("rfed wrapChannelMessage (no stamp)", () => {
  test("byte layout: channel_hash(16) ‖ inner_blob — no stamp", async () => {
    const f = await fixture();
    const lxm = new Message({ content: "hello" });
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: lxm,
    });

    assert.strictEqual(wrapped.stamp, null);
    assert.deepStrictEqual(wrapped.channelHash, f.channelHash);

    // rfed_payload = channel_hash(16) ‖ inner_blob
    assert.strictEqual(
      wrapped.rfedPayload.length,
      16 + wrapped.innerBlob.length,
    );
    assert.deepStrictEqual(wrapped.rfedPayload.subarray(0, 16), f.channelHash);
    assert.deepStrictEqual(wrapped.rfedPayload.subarray(16), wrapped.innerBlob);
  });

  test("a ~5-byte content yields inner_blob ≈ 256 (SPEC reference)", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "hello" }),
    });
    assert.strictEqual(wrapped.innerBlob.length, 256);
  });

  test("LXMF source_hash is the sender lxmf.delivery hash, not the identity hash", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "addr check" }),
    });
    const decoded = await unwrapChannelMessage({
      innerBlob: wrapped.innerBlob,
      channelIdentity: f.channelIdentity,
      channelDeliveryHash: f.channelDeliveryHash,
    });
    assert.notStrictEqual(
      toHex(decoded.sourceHash),
      toHex(f.senderIdentity.identityHash),
    );
    assert.strictEqual(toHex(decoded.sourceHash), toHex(f.senderDeliveryHash));
  });
});

describe("rfed wrapChannelMessage (with stamp)", () => {
  test("byte layout: channel_hash(16) ‖ inner_blob ‖ stamp(32)", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "hello" }),
      stampCost: 8,
    });

    assert.ok(wrapped.stamp);
    assert.strictEqual(wrapped.stamp.length, STAMP_SIZE);
    // rfed_payload = channel_hash(16) ‖ inner_blob ‖ stamp(32)
    assert.strictEqual(
      wrapped.rfedPayload.length,
      16 + wrapped.innerBlob.length + STAMP_SIZE,
    );
    assert.deepStrictEqual(wrapped.rfedPayload.subarray(0, 16), f.channelHash);
    assert.deepStrictEqual(
      wrapped.rfedPayload.subarray(16, wrapped.rfedPayload.length - STAMP_SIZE),
      wrapped.innerBlob,
    );
    assert.deepStrictEqual(
      wrapped.rfedPayload.subarray(wrapped.rfedPayload.length - STAMP_SIZE),
      wrapped.stamp,
    );
  });

  test("the appended stamp validates against the rfed contract (rounds=16)", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "stamped" }),
      stampCost: 8,
    });
    assert.strictEqual(
      await validateChannelStamp(
        f.channelHash,
        wrapped.innerBlob,
        wrapped.stamp,
        8,
      ),
      true,
    );
  });

  test("stampCost = 0 disables stamping (no stamp appended)", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "x" }),
      stampCost: 0,
    });
    assert.strictEqual(wrapped.stamp, null);
  });
});

describe("rfed unwrapChannelMessage (round-trip)", () => {
  test("decodes content, sender pub, and verifies the signature", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "round-trip body", title: "t" }),
    });
    const decoded = await unwrapChannelMessage({
      innerBlob: wrapped.innerBlob,
      channelIdentity: f.channelIdentity,
      channelDeliveryHash: f.channelDeliveryHash,
    });

    assert.strictEqual(decoded.message.content, "round-trip body");
    assert.strictEqual(decoded.message.title, "t");
    assert.strictEqual(decoded.signatureValid, true);
    assert.deepStrictEqual(
      decoded.senderPub,
      await f.senderIdentity.getPublicKey(),
    );
  });

  test("a tampered sender pubkey breaks signature validation", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "forge me" }),
    });

    // Decrypt, flip a bit in the embedded pubkey, re-encrypt with the channel key.
    const plaintext = await f.channelIdentity.decrypt(wrapped.innerBlob);
    plaintext[PUBLIC_KEY_LENGTH] ^= 0x01; // flip inside sender_identity_pub
    const tamperedBlob = await f.channelIdentity.encrypt(plaintext);

    const decoded = await unwrapChannelMessage({
      innerBlob: tamperedBlob,
      channelIdentity: f.channelIdentity,
      channelDeliveryHash: f.channelDeliveryHash,
    });
    assert.strictEqual(decoded.signatureValid, false);
  });

  test("decryption fails with the wrong channel identity", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "x" }),
    });
    const wrongChannel = await deriveChannel("public.wrong");
    await assert.rejects(
      unwrapChannelMessage({
        innerBlob: wrapped.innerBlob,
        channelIdentity: wrongChannel.identity,
        channelDeliveryHash: await deliveryHashFor(wrongChannel.identity),
      }),
    );
  });

  test("a blob whose plaintext lacks the RTID magic is rejected", async () => {
    const f = await fixture();
    // Plaintext with a wrong magic, encrypted with the real channel key.
    const bad = new Uint8Array(MAGIC_RTID);
    bad[0] = 0x00; // corrupt the magic
    const rest = new Uint8Array(PUBLIC_KEY_LENGTH + HASH_LENGTH + 64 + 8);
    const plaintext = new Uint8Array([...bad, ...rest]);
    const innerBlob = await f.channelIdentity.encrypt(plaintext);

    await assert.rejects(
      unwrapChannelMessage({
        innerBlob,
        channelIdentity: f.channelIdentity,
        channelDeliveryHash: f.channelDeliveryHash,
      }),
      /magic/i,
    );
  });
});

describe("rfed payload parsers", () => {
  test("parseSendPayload splits channel_hash ‖ inner_blob ‖ stamp", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "parse" }),
      stampCost: 8,
    });
    const parts = parseSendPayload(wrapped.rfedPayload);
    assert.deepStrictEqual(parts.channelHash, f.channelHash);
    assert.deepStrictEqual(parts.innerBlob, wrapped.innerBlob);
    assert.deepStrictEqual(parts.stamp, wrapped.stamp);
  });

  test("parseFanoutPayload splits channel_hash ‖ inner_blob (no stamp)", async () => {
    const f = await fixture();
    const wrapped = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "fanout" }),
    });
    // A fanout payload is channel_hash(16) ‖ inner_blob.
    const parts = parseFanoutPayload(wrapped.rfedPayload);
    assert.deepStrictEqual(parts.channelHash, f.channelHash);
    assert.deepStrictEqual(parts.innerBlob, wrapped.innerBlob);
  });

  test("parseSendPayload rejects a too-short payload", () => {
    assert.throws(() => parseSendPayload(new Uint8Array(10)), /too short/i);
    assert.throws(() => parseFanoutPayload(new Uint8Array(10)), /too short/i);
  });
});

describe("rfed wrapRawChannelMessage (no stamp)", () => {
  test("byte layout: channel_hash(16) ‖ inner_blob — no stamp, no LXMF", async () => {
    const f = await fixture();
    const payload = new TextEncoder().encode("raw-delta-bytes");
    const wrapped = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload,
    });

    assert.strictEqual(wrapped.stamp, null);
    assert.deepStrictEqual(wrapped.channelHash, f.channelHash);
    assert.deepStrictEqual(wrapped.channelHash, f.channelHash);
    // rfed_payload = channel_hash(16) ‖ inner_blob (no LXMF, no stamp)
    assert.strictEqual(
      wrapped.rfedPayload.length,
      16 + wrapped.innerBlob.length,
    );
    assert.deepStrictEqual(wrapped.rfedPayload.subarray(0, 16), f.channelHash);
    assert.deepStrictEqual(wrapped.rfedPayload.subarray(16), wrapped.innerBlob);
  });

  test("inner_blob is smaller than the LXMF form for the same payload", async () => {
    // The raw format drops the LXMF tail (source_hash(16) + signature(64) +
    // msgpack framing) — ~111 bytes — so a given payload should be noticeably
    // cheaper on the wire than when wrapped as LXMF.
    const f = await fixture();
    const payload = new TextEncoder().encode("shared payload body");

    const raw = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload,
    });
    const lxm = await wrapChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      senderLxmDeliveryHash: f.senderDeliveryHash,
      lxmMessage: new Message({ content: "shared payload body" }),
    });
    assert.ok(
      raw.innerBlob.length < lxm.innerBlob.length,
      `raw inner_blob (${raw.innerBlob.length}) should be smaller than LXMF (${lxm.innerBlob.length})`,
    );
  });
});

describe("rfed wrapRawChannelMessage (with stamp)", () => {
  test("byte layout: channel_hash(16) ‖ inner_blob ‖ stamp(32)", async () => {
    const f = await fixture();
    const payload = new TextEncoder().encode("stamped raw");
    const wrapped = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload,
      stampCost: 8,
    });

    assert.ok(wrapped.stamp);
    assert.strictEqual(wrapped.stamp.length, STAMP_SIZE);
    assert.strictEqual(
      wrapped.rfedPayload.length,
      16 + wrapped.innerBlob.length + STAMP_SIZE,
    );
    assert.deepStrictEqual(wrapped.rfedPayload.subarray(0, 16), f.channelHash);
    assert.deepStrictEqual(
      wrapped.rfedPayload.subarray(16, wrapped.rfedPayload.length - STAMP_SIZE),
      wrapped.innerBlob,
    );
    assert.deepStrictEqual(
      wrapped.rfedPayload.subarray(wrapped.rfedPayload.length - STAMP_SIZE),
      wrapped.stamp,
    );
  });

  test("the appended stamp validates against the rfed contract", async () => {
    const f = await fixture();
    const wrapped = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload: new TextEncoder().encode("stamp me raw"),
      stampCost: 8,
    });
    assert.strictEqual(
      await validateChannelStamp(
        f.channelHash,
        wrapped.innerBlob,
        wrapped.stamp,
        8,
      ),
      true,
    );
  });

  test("stampCost = 0 disables stamping (no stamp appended)", async () => {
    const f = await fixture();
    const wrapped = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload: new TextEncoder().encode("x"),
      stampCost: 0,
    });
    assert.strictEqual(wrapped.stamp, null);
  });
});

describe("rfed unwrapRawChannelMessage (round-trip)", () => {
  test("recovers the payload and sender identity", async () => {
    const f = await fixture();
    const payload = crypto.getRandomValues(new Uint8Array(170));
    const wrapped = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload,
    });
    const decoded = await unwrapRawChannelMessage({
      innerBlob: wrapped.innerBlob,
      channelIdentity: f.channelIdentity,
    });

    assert.deepStrictEqual(decoded.payload, payload);
    assert.deepStrictEqual(
      decoded.senderPub,
      await f.senderIdentity.getPublicKey(),
    );
    assert.deepStrictEqual(
      decoded.senderIdentity.identityHash,
      f.senderIdentity.identityHash,
    );
  });

  test("a forged sender pubkey is still recoverable (no LXMF sig to check)", async () => {
    // Unlike the LXMF path, the raw format has no LXMF signature to validate
    // against — integrity is the application's job. A tampered sender_pub is
    // simply recovered as a different identity; the channel EC gate is the
    // authorisation, and the payload's own auth is what matters.
    const f = await fixture();
    const wrapped = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload: new TextEncoder().encode("forge me"),
    });

    const plaintext = await f.channelIdentity.decrypt(wrapped.innerBlob);
    plaintext[PUBLIC_KEY_LENGTH] ^= 0x01; // flip inside sender_identity_pub
    const tamperedBlob = await f.channelIdentity.encrypt(plaintext);

    const decoded = await unwrapRawChannelMessage({
      innerBlob: tamperedBlob,
      channelIdentity: f.channelIdentity,
    });
    assert.notStrictEqual(
      toHex(decoded.senderIdentity.identityHash),
      toHex(f.senderIdentity.identityHash),
    );
    // The payload still round-trips (it's untouched).
    assert.deepStrictEqual(
      decoded.payload,
      new TextEncoder().encode("forge me"),
    );
  });

  test("decryption fails with the wrong channel identity", async () => {
    const f = await fixture();
    const wrapped = await wrapRawChannelMessage({
      channelIdentity: f.channelIdentity,
      senderIdentity: f.senderIdentity,
      payload: new TextEncoder().encode("x"),
    });
    const wrongChannel = await deriveChannel("public.wrong");
    await assert.rejects(
      unwrapRawChannelMessage({
        innerBlob: wrapped.innerBlob,
        channelIdentity: wrongChannel.identity,
      }),
    );
  });

  test("a blob whose plaintext lacks the RTID magic is rejected", async () => {
    const f = await fixture();
    const bad = new Uint8Array(MAGIC_RTID);
    bad[0] = 0x00; // corrupt the magic
    const rest = new Uint8Array(PUBLIC_KEY_LENGTH + 8);
    const plaintext = new Uint8Array([...bad, ...rest]);
    const innerBlob = await f.channelIdentity.encrypt(plaintext);

    await assert.rejects(
      unwrapRawChannelMessage({
        innerBlob,
        channelIdentity: f.channelIdentity,
      }),
      /magic/i,
    );
  });
});
