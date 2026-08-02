/**
 * @file blob.js
 * @description rfed channel message envelope codec (the "RTID" prelude).
 *
 * A channel message is a propagation-style LXMF message wrapped in the RTID
 * source-identity prelude, then EC-encrypted to the channel identity. The
 * resulting `inner_blob` is what rfed stores, syncs, and fans out verbatim —
 * rfed never decrypts or inspects it.
 *
 * Layered wire format (`RFed/SPEC.md` "CANONICAL WIRE FORMAT"):
 * ```
 * plaintext   = "RTID"(4) ‖ sender_identity_pub(64) ‖ LXMF_tail
 * LXMF_tail   = source_hash(16) ‖ signature(64) ‖ msgpack_payload
 * inner_blob  = EC_encrypt(channel_identity.X25519_pub, plaintext)
 * rfed_payload= channel_hash(16) ‖ inner_blob ‖ stamp(32)
 * ```
 *
 * `source_hash` is the sender's `lxmf.delivery` **destination** hash —
 * `truncated_hash(name_hash("lxmf.delivery") ‖ identity_hash)` — NOT the bare
 * identity hash. Integrity is the LXMF Ed25519 signature; cache poisoning is
 * impossible because reaching the EC-decrypt step already required the channel
 * private key (i.e. an authorised subscriber).
 */

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { Message } from "../lxmf/message.js";
import { concatBytes } from "../utils/encoding.js";
import { deliveryHashFor } from "./channel.js";
import {
  HASH_LENGTH,
  MAGIC_LENGTH,
  MAGIC_RTID,
  PUBLIC_KEY_LENGTH,
  STAMP_SIZE,
} from "./constants.js";
import { generateChannelStamp } from "./stamp.js";

/** Byte length of the full RTID prelude: magic(4) ‖ sender_pub(64). */
const PRELUDE_LENGTH = MAGIC_LENGTH + PUBLIC_KEY_LENGTH; // 68

/**
 * Wraps an LXMF message into a rfed channel SEND payload.
 *
 * The LXMF message is serialised (signed by `senderIdentity`), the RTID
 * prelude + sender public key are prepended to the LXMF tail, the whole thing
 * is EC-encrypted to the channel identity, and the channel hash + optional PoW
 * stamp are framed around it.
 *
 * `lxmMessage.sourceHash` / `destinationHash` are forced to the correct
 * `lxmf.delivery` hashes (sender and channel respectively) so the classic
 * "source_hash is the identity hash" bug cannot occur.
 *
 * @param {Object} opts
 * @param {Identity} opts.channelIdentity - Channel's derived Identity (holds
 *   the private key used to EC-encrypt).
 * @param {Identity} opts.senderIdentity - Sender's Identity (signs the LXMF
 *   message and supplies the prelude public key).
 * @param {Uint8Array} opts.senderLxmDeliveryHash - Sender's `lxmf.delivery`
 *   destination hash (16 bytes) — the LXMF `source_hash`.
 * @param {Message} opts.lxmMessage - LXMF message to wrap. `content`/`fields`
 *   are read here; addressing is overwritten per the spec.
 * @param {number|null} [opts.stampCost=null] - rfed PoW cost. `null` or `0`
 *   disables stamping (no stamp appended); any positive value appends a real
 *   32-byte stamp.
 * @returns {Promise<{ rfedPayload: Uint8Array, channelHash: Uint8Array,
 *   channelDeliveryHash: Uint8Array, innerBlob: Uint8Array,
 *   stamp: Uint8Array|null }>}
 */
export async function wrapChannelMessage({
  channelIdentity,
  senderIdentity,
  senderLxmDeliveryHash,
  lxmMessage,
  stampCost = null,
}) {
  const channelHash = channelIdentity.identityHash;
  const channelDeliveryHash = await deliveryHashFor(channelIdentity);

  // Force correct LXMF addressing. `source_hash` MUST be the sender's
  // lxmf.delivery destination hash, never the bare identity hash.
  lxmMessage.destinationHash = channelDeliveryHash;
  lxmMessage.sourceHash = senderLxmDeliveryHash;

  const { wireData } = await lxmMessage.serialize(senderIdentity);
  const senderPub = await senderIdentity.getPublicKey();
  // LXMF tail = wireData after the destination hash: source || sig || payload.
  const lxmfTail = wireData.subarray(HASH_LENGTH);

  const plaintext = concatBytes(MAGIC_RTID, senderPub, lxmfTail);
  const innerBlob = await channelIdentity.encrypt(plaintext);

  /** @type {Uint8Array|null} */
  let stamp = null;
  if (stampCost && stampCost > 0) {
    const [generated] = await generateChannelStamp(
      channelHash,
      innerBlob,
      stampCost,
    );
    stamp = generated;
  }

  const rfedPayload = stamp
    ? concatBytes(channelHash, innerBlob, stamp)
    : concatBytes(channelHash, innerBlob);

  return {
    rfedPayload,
    channelHash,
    channelDeliveryHash,
    innerBlob,
    stamp,
  };
}

/**
 * Splits a fanout delivery payload `[ channel_hash(16) ‖ inner_blob ]` into its
 * two parts. The fanout hop carries no stamp (it was validated and stripped at
 * ingest).
 *
 * @param {Uint8Array} payload
 * @returns {{ channelHash: Uint8Array, innerBlob: Uint8Array }}
 * @throws {Error} when the payload is shorter than a channel hash.
 */
export function parseFanoutPayload(payload) {
  if (payload.length < HASH_LENGTH) {
    throw new Error(
      `rfed fanout payload too short: ${payload.length} bytes (need at least ${HASH_LENGTH})`,
    );
  }
  return {
    channelHash: payload.subarray(0, HASH_LENGTH),
    innerBlob: payload.subarray(HASH_LENGTH),
  };
}

/**
 * Splits a SEND payload `[ channel_hash(16) ‖ inner_blob ‖ stamp(32) ]` into
 * its three parts. Use when a stamp is known to be present (the node's
 * `stamp_cost` is non-nil); use {@link parseFanoutPayload} for the stamp-free
 * fanout form.
 *
 * @param {Uint8Array} payload
 * @returns {{ channelHash: Uint8Array, innerBlob: Uint8Array, stamp: Uint8Array }}
 * @throws {Error} when the payload is too short to contain all three parts.
 */
export function parseSendPayload(payload) {
  const min = HASH_LENGTH + STAMP_SIZE;
  if (payload.length < min) {
    throw new Error(
      `rfed SEND payload too short: ${payload.length} bytes (need at least ${min})`,
    );
  }
  return {
    channelHash: payload.subarray(0, HASH_LENGTH),
    innerBlob: payload.subarray(HASH_LENGTH, payload.length - STAMP_SIZE),
    stamp: payload.subarray(payload.length - STAMP_SIZE),
  };
}

/**
 * Decrypts and reconstructs an LXMF message from a channel `inner_blob`.
 *
 * Inverse of {@link wrapChannelMessage}: EC-decrypts with the channel identity,
 * verifies the RTID magic, extracts the embedded sender public key, and feeds
 * the reconstructed LXMF wire block to `Message.deserialize`. The sender
 * identity is cached via `Destination.remember` so subsequent messages from the
 * same sender validate without the prelude.
 *
 * The returned `signatureValid` is **the** integrity check: a forged
 * `sender_identity_pub` produces a signature mismatch.
 *
 * @param {Object} opts
 * @param {Uint8Array} opts.innerBlob - EC-encrypted channel message (no
 *   channel-hash prefix, no stamp).
 * @param {Identity} opts.channelIdentity - Channel's derived Identity (holds
 *   the private key used to EC-decrypt).
 * @param {Uint8Array} opts.channelDeliveryHash - Channel's `lxmf.delivery`
 *   destination hash (prepended to the LXMF tail before deserialisation).
 * @returns {Promise<{ message: Message, senderPub: Uint8Array,
 *   senderIdentity: Identity, sourceHash: Uint8Array, signatureValid: boolean }>}
 * @throws {Error} when decryption fails, the magic is absent, or the LXMF tail
 *   cannot be parsed.
 */
export async function unwrapChannelMessage({
  innerBlob,
  channelIdentity,
  channelDeliveryHash,
}) {
  const plaintext = await channelIdentity.decrypt(innerBlob);
  if (!plaintext) {
    throw new Error("rfed inner_blob EC-decryption failed (wrong channel?)");
  }
  if (plaintext.length < PRELUDE_LENGTH + HASH_LENGTH) {
    throw new Error(
      `rfed prelude plaintext too short: ${plaintext.length} bytes`,
    );
  }

  // Verify magic — receivers MUST refuse blobs without "RTID".
  for (let i = 0; i < MAGIC_LENGTH; i++) {
    if (plaintext[i] !== MAGIC_RTID[i]) {
      throw new Error(
        `rfed prelude magic mismatch: expected "RTID", got 0x${plaintext[i].toString(16)} at offset ${i}`,
      );
    }
  }

  const senderPub = plaintext.subarray(MAGIC_LENGTH, PRELUDE_LENGTH);
  const lxmfTail = plaintext.subarray(PRELUDE_LENGTH);

  // Reconstruct the canonical LXMF block: dest_hash(16) ‖ source ‖ sig ‖ payload.
  const fullWire = concatBytes(channelDeliveryHash, lxmfTail);
  const message = await Message.deserialize(fullWire, channelDeliveryHash);

  const senderIdentity = await Identity.fromPublicKey(senderPub);

  // Cache the sender identity so future messages validate without the prelude.
  // `source_hash` is the lxmf.delivery destination hash; the public key is the
  // prelude's embedded sender pub. packetHash uses the message id as a stable
  // marker (it is metadata only).
  try {
    await Destination.remember(
      message.messageId ?? message.sourceHash,
      message.sourceHash,
      senderPub,
      null,
    );
  } catch {
    // Caching is a best-effort optimisation; decode must still succeed without it.
  }

  const signatureValid = await message.verifySignature(senderIdentity);

  return {
    message,
    senderPub: new Uint8Array(senderPub),
    senderIdentity,
    sourceHash: message.sourceHash,
    signatureValid,
  };
}
