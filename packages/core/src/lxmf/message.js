/**
 * @file message.js
 * @description LXMF Message serialization and construction.
 *
 * Wire format (§5.2 / §5.1):
 *   direct:         destination_hash(16) || source_hash(16) || signature(64) || msgpack_payload
 *   opportunistic:  source_hash(16) || signature(64) || msgpack_payload
 *                   (the outer Reticulum packet's dest_hash conveys the recipient)
 *
 * msgpack_payload (§5.3) is a 4-element array, with an optional 5th stamp:
 *   [timestamp(double), title(bin), content(bin), fields(map)] [, stamp(bin 32)]
 *
 * Signature (§5.5) is ALWAYS computed over the 4-element payload — the stamp
 * is appended afterwards and stripped by the receiver before hashing.
 */

import { Identity } from "../core/identity.js";
import { base64UrlToBytes, bytesToBase64Url } from "../utils/encoding.js";
import { MicroMsgPack } from "../utils/msgpack.js";
import { PAPER_MDU, URI_SCHEMA } from "./constants.js";

const DESTINATION_LENGTH = 16; // TRUNCATED_HASHLENGTH//8
const SIGNATURE_LENGTH = 64; // SIGLENGTH//8

/**
 * Packs the LXMF msgpack payload with canonical umsgpack encoding:
 * timestamp always float64, title/content always bin, stamp optional.
 *
 * Used both for outbound serialization and for the stamp-stripping re-encode
 * on receive (§5.6.1). `title`/`content` may be a string (UTF-8 → bin) or a
 * Uint8Array (already bin).
 *
 * @param {number} timestamp
 * @param {string|Uint8Array} title
 * @param {string|Uint8Array} content
 * @param {Record<string, any>|Map<any, any>} fields
 * @param {Uint8Array|null} [stamp]
 * @returns {Uint8Array}
 */
function packPayload(timestamp, title, content, fields, stamp) {
  const timestampBytes = MicroMsgPack.encodeFloat64(timestamp);

  const toBin = /** @param {string|Uint8Array} v */ (v) =>
    v instanceof Uint8Array
      ? MicroMsgPack.encode(v)
      : MicroMsgPack.encode(new Uint8Array(new TextEncoder().encode(v ?? "")));

  const titleBytes = toBin(title);
  const contentBytes = toBin(content);
  const fieldsBytes = MicroMsgPack.encode(fields ?? {});

  /** @type {Uint8Array[]} */
  const elements = [timestampBytes, titleBytes, contentBytes, fieldsBytes];
  if (stamp != null) {
    elements.push(MicroMsgPack.encode(stamp));
  }

  const nelem = elements.length;
  /** @type {number[]} */
  let header;
  if (nelem <= 15) {
    header = [0x90 | nelem]; // fixarray
  } else if (nelem <= 0xffff) {
    header = [0xdc, (nelem >> 8) & 0xff, nelem & 0xff]; // array 16
  } else {
    header = [
      0xdd,
      (nelem >> 24) & 0xff,
      (nelem >> 16) & 0xff,
      (nelem >> 8) & 0xff,
      nelem & 0xff,
    ]; // array 32
  }

  let total = header.length;
  for (const e of elements) total += e.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const h of header) out[offset++] = h;
  for (const e of elements) {
    out.set(e, offset);
    offset += e.length;
  }
  return out;
}

/**
 * Computes SHA-256 of the input.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function fullHash(data) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    /** @type {any} */ (data),
  );
  return new Uint8Array(digest);
}

/**
 * Represents an LXMF message.
 */
export class Message {
  /**
   * Constructs an LXMF message.
   * @param {Object} options
   * @param {Uint8Array} options.sourceHash
   * @param {Uint8Array} options.destinationHash
   * @param {number} [options.timestamp]
   * @param {string} [options.title]
   * @param {string} [options.content]
   * @param {Record<string, any>|Map<string, any>} [options.fields]
   * @param {Uint8Array} [options.signature]
   * @param {Uint8Array} [options.signedPart]
   * @param {Uint8Array} [options.stamp] - Optional proof-of-work stamp (§5.7).
   * @param {Uint8Array} [options.messageId] - SHA-256 of the hashed part (§5.5).
   */
  constructor({
    sourceHash,
    destinationHash,
    timestamp,
    title,
    content,
    fields,
    signature,
    signedPart,
    stamp,
    messageId,
  }) {
    this.sourceHash = sourceHash;
    this.destinationHash = destinationHash;
    this.timestamp = timestamp || Date.now() / 1000;
    this.title = title;
    this.content = content;
    this.fields = fields || {};
    this.signature = signature;
    this.signedPart = signedPart;
    /** @type {Uint8Array|null} */
    this.stamp = stamp ?? null;
    /** @type {Uint8Array|null} LXMF message_id = SHA256(dest||src||payload). */
    this.messageId = messageId ?? null;
    // Kept for the §5.6 path-2 (re-encode) signature fallback.
    /** @type {any[]|null} */
    this._decodedPayload = null;
  }

  /**
   * Serializes the Message into the LXMF wire format.
   *
   * If `this.stamp` is set (e.g. a proof-of-work stamp from the Stamper, or a
   * ticket-derived stamp), it is appended as the 5th payload element. The
   * signature and message_id are always computed over the 4-element payload
   * (§5.5), so adding or removing a stamp never invalidates the signature.
   *
   * @param {import("../core/identity.js").Identity} sourceIdentity
   * @returns {Promise<{messageId: Uint8Array, wireData: Uint8Array}>}
   */
  async serialize(sourceIdentity) {
    const sourceHash = this.sourceHash || sourceIdentity.identityHash;

    // 4-element payload — this is what gets signed and hashed.
    const packedPayload4 = packPayload(
      this.timestamp,
      this.title ?? "",
      this.content ?? "",
      this.fields,
      null,
    );

    // hashed_part = destination_hash(16) || source_hash(16) || msgpack_payload
    const hashedPart = new Uint8Array(
      DESTINATION_LENGTH + DESTINATION_LENGTH + packedPayload4.length,
    );
    hashedPart.set(this.destinationHash, 0);
    hashedPart.set(sourceHash, DESTINATION_LENGTH);
    hashedPart.set(packedPayload4, 2 * DESTINATION_LENGTH);

    // message_id = SHA256(hashed_part)
    const messageId = await fullHash(hashedPart);

    // signed_data = hashed_part || message_id
    const signedPart = new Uint8Array(hashedPart.length + messageId.length);
    signedPart.set(hashedPart, 0);
    signedPart.set(messageId, hashedPart.length);

    const signature = await sourceIdentity.sign(signedPart);

    // Assemble the wire payload (4 or 5 elements).
    const packedPayload =
      this.stamp != null
        ? packPayload(
            this.timestamp,
            this.title ?? "",
            this.content ?? "",
            this.fields,
            this.stamp,
          )
        : packedPayload4;

    const wireData = new Uint8Array(
      2 * DESTINATION_LENGTH + SIGNATURE_LENGTH + packedPayload.length,
    );
    wireData.set(this.destinationHash, 0);
    wireData.set(sourceHash, DESTINATION_LENGTH);
    wireData.set(signature, 2 * DESTINATION_LENGTH);
    wireData.set(packedPayload, 2 * DESTINATION_LENGTH + SIGNATURE_LENGTH);

    this.messageId = messageId;
    this.signature = signature;
    this.signedPart = signedPart;

    return { messageId, wireData };
  }

  /**
   * Creates a Message from wire data.
   *
   * Accepts both the direct layout (dest+source+signature+payload) and the
   * opportunistic layout (source+signature+payload, with the destination hash
   * supplied separately via `expectedDestinationHash`).
   *
   * If the payload carries an optional 5th stamp element (§5.7.1), it is
   * stripped and the first four elements are re-packed before the message_id
   * and signed_part are computed — exactly matching the upstream Python
   * `unpack_from_bytes` behaviour, so a stamp never invalidates the signature.
   *
   * @param {Uint8Array} wireData
   * @param {Uint8Array} [expectedDestinationHash] - Required for opportunistic delivery.
   * @returns {Promise<Message>}
   */
  static async deserialize(wireData, expectedDestinationHash) {
    let destinationHash;
    let sourceHash;
    let signature;
    let rawPayload;

    const isDirect =
      wireData.length >= 80 + DESTINATION_LENGTH &&
      (!expectedDestinationHash ||
        wireData
          .subarray(0, DESTINATION_LENGTH)
          .every((v, i) => v === expectedDestinationHash[i]));

    if (isDirect) {
      destinationHash = wireData.slice(0, DESTINATION_LENGTH);
      sourceHash = wireData.slice(DESTINATION_LENGTH, 2 * DESTINATION_LENGTH);
      signature = wireData.slice(
        2 * DESTINATION_LENGTH,
        2 * DESTINATION_LENGTH + SIGNATURE_LENGTH,
      );
      rawPayload = wireData.slice(2 * DESTINATION_LENGTH + SIGNATURE_LENGTH);
    } else if (wireData.length >= DESTINATION_LENGTH + SIGNATURE_LENGTH) {
      // Opportunistic delivery: source_hash(16) || signature(64) || msgpack_payload
      sourceHash = wireData.slice(0, DESTINATION_LENGTH);
      signature = wireData.slice(
        DESTINATION_LENGTH,
        DESTINATION_LENGTH + SIGNATURE_LENGTH,
      );
      rawPayload = wireData.slice(DESTINATION_LENGTH + SIGNATURE_LENGTH);
      destinationHash = expectedDestinationHash;
    } else {
      throw new Error("LXMF message too short or format unrecognized");
    }

    if (!destinationHash) {
      throw new Error("Could not determine destination hash for LXMF message");
    }

    // Decode the payload to inspect for an optional stamp (5th element).
    const decodedPayload = MicroMsgPack.decode(rawPayload);
    if (!Array.isArray(decodedPayload) || decodedPayload.length < 4) {
      throw new Error(
        "Invalid LXMF payload format: Expected 4-element MessagePack array",
      );
    }

    let stamp = null;
    // When a stamp is present the receiver MUST re-pack the first four
    // elements to reproduce the bytes the signer hashed over (§5.6 / §5.7.1).
    // When no stamp is present the raw wire bytes are used (path-1).
    /** @type {Uint8Array} */
    let packedPayload = rawPayload;
    if (decodedPayload.length > 4) {
      stamp = decodedPayload[4];
      packedPayload = packPayload(
        decodedPayload[0],
        decodedPayload[1],
        decodedPayload[2],
        decodedPayload[3],
        null,
      );
    }

    // hashed_part = destination_hash(16) || source_hash(16) || packed_payload
    const hashedPart = new Uint8Array(
      2 * DESTINATION_LENGTH + packedPayload.length,
    );
    hashedPart.set(destinationHash, 0);
    hashedPart.set(sourceHash, DESTINATION_LENGTH);
    hashedPart.set(packedPayload, 2 * DESTINATION_LENGTH);

    const messageId = await fullHash(hashedPart);

    // signed_data = hashed_part || message_id
    const signedPart = new Uint8Array(hashedPart.length + messageId.length);
    signedPart.set(hashedPart, 0);
    signedPart.set(messageId, hashedPart.length);

    const [timestamp, titleBytes, contentBytes, fields] = decodedPayload;

    const content =
      contentBytes instanceof Uint8Array
        ? new TextDecoder().decode(contentBytes)
        : contentBytes;
    const title =
      titleBytes instanceof Uint8Array
        ? new TextDecoder().decode(titleBytes)
        : titleBytes;

    const message = new Message({
      sourceHash,
      destinationHash,
      timestamp,
      title,
      content,
      fields,
      signature,
      signedPart,
      stamp,
      messageId,
    });
    message._decodedPayload = decodedPayload;
    return message;
  }

  /**
   * Verifies the message signature against a sender identity, tolerating
   * msgpack encoder variance per §5.6.
   *
   * Two candidate signed buffers are tried:
   *   1. `this.signedPart` — computed from the raw wire payload (unstamped) or
   *      the stamp-stripped re-pack (stamped).
   *   2. A freshly re-encoded 4-element payload, for messages that passed
   *      through a re-encoding relay whose bytes diverge from the signer's.
   *
   * @param {Identity} identity - The sender's identity.
   * @returns {Promise<boolean>}
   */
  async verifySignature(identity) {
    if (!this.signature || !this.signedPart) return false;

    // Path 1: as-received (or stamp-stripped) bytes.
    if (await identity.validate(this.signature, this.signedPart)) {
      return true;
    }

    // Path 2: re-encode the first four payload elements canonically.
    if (this._decodedPayload) {
      const repacked = packPayload(
        this._decodedPayload[0],
        this._decodedPayload[1],
        this._decodedPayload[2],
        this._decodedPayload[3],
        null,
      );
      if (!this.destinationHash || !this.sourceHash) return false;
      const hashedPart = new Uint8Array(
        2 * DESTINATION_LENGTH + repacked.length,
      );
      hashedPart.set(this.destinationHash, 0);
      hashedPart.set(this.sourceHash, DESTINATION_LENGTH);
      hashedPart.set(repacked, 2 * DESTINATION_LENGTH);
      const messageId = await fullHash(hashedPart);
      const signedPart2 = new Uint8Array(hashedPart.length + messageId.length);
      signedPart2.set(hashedPart, 0);
      signedPart2.set(messageId, hashedPart.length);
      if (await identity.validate(this.signature, signedPart2)) {
        return true;
      }
    }

    return false;
  }

  // ------------------------------------------------------------------
  // Propagation form (§5.3)
  // ------------------------------------------------------------------

  /**
   * Packs this message into the propagation ("lxmf_data") form used when
   * submitting to a propagation node or syncing between nodes (§5.3):
   *
   *   lxmf_data = destination_hash(16)
   *             || E_outbound(source_hash(16) || signature(64) || payload)
   *
   * Only the leading destination hash is in cleartext (so the node can route
   * by recipient and compute the dedup key); the body is encrypted to the
   * recipient (using their recalled ratchet when one is known, §7.4). The
   * `transientId` is SHA-256 over the whole `lxmf_data` and is the store/
   * dedup key (LXMRouter.lxmf_propagation).
   *
   * Serializes first if needed.
   *
   * @param {import("../core/identity.js").Identity} sourceIdentity
   * @param {import("../core/destination.js").Destination} outboundDestination
   *   recipient `lxmf.delivery` destination (Direction.OUT; holds the
   *   recipient public key + recalled ratchet). Must share this message's
   *   `destinationHash`.
   * @returns {Promise<{lxmfData: Uint8Array, transientId: Uint8Array, wireData: Uint8Array}>}
   */
  async toPropagationData(sourceIdentity, outboundDestination) {
    const { wireData } = await this.serialize(sourceIdentity);
    const encrypted = await outboundDestination.encrypt(
      wireData.subarray(DESTINATION_LENGTH),
    );
    const lxmfData = new Uint8Array(DESTINATION_LENGTH + encrypted.length);
    lxmfData.set(wireData.subarray(0, DESTINATION_LENGTH), 0);
    lxmfData.set(encrypted, DESTINATION_LENGTH);
    const transientId = await Message.transientIdFromPropagationData(lxmfData);
    return { lxmfData, transientId, wireData };
  }

  /**
   * Computes the propagation dedup key `transient_id = SHA-256(lxmf_data)`
   * (LXMRouter.lxmf_propagation). Identical on both client and node.
   *
   * @param {Uint8Array} lxmfData
   * @returns {Promise<Uint8Array>}
   */
  static async transientIdFromPropagationData(lxmfData) {
    return await fullHash(lxmfData);
  }

  /**
   * Decrypts and reconstructs an LXMF message from its propagation
   * ("lxmf_data") form (§5.3). The destination hash is taken from the leading
   * 16 bytes; the remainder is decrypted with the recipient's inbound
   * `lxmf.delivery` destination (long-term key + owned ratchet ring, §7.4).
   *
   * @param {Uint8Array} lxmfData
   * @param {import("../core/destination.js").Destination} deliveryDestination
   *   recipient's inbound `lxmf.delivery` destination.
   * @returns {Promise<Message|null>} `null` when decryption fails (wrong
   *   recipient / unknown ratchet) or the input is too short.
   */
  static async fromPropagationData(lxmfData, deliveryDestination) {
    if (!lxmfData || lxmfData.length < DESTINATION_LENGTH) return null;
    const destinationHash = lxmfData.subarray(0, DESTINATION_LENGTH);
    const encrypted = lxmfData.subarray(DESTINATION_LENGTH);
    const decrypted = await deliveryDestination.decrypt(encrypted);
    if (!decrypted) return null;
    const wireData = new Uint8Array(DESTINATION_LENGTH + decrypted.length);
    wireData.set(destinationHash, 0);
    wireData.set(decrypted, DESTINATION_LENGTH);
    return await Message.deserialize(wireData, destinationHash);
  }

  // ------------------------------------------------------------------
  // Paper message form (§5.4 / LXMessage.py PAPER branch)
  //
  // A paper message is byte-identical to the propagation `lxmf_data` form
  // (`destination_hash(16) || E_outbound(source_hash(16) || signature(64) ||
  // payload)`), but it is carried out-of-band — printed, photographed as a QR
  // code, or shared as an `lxm://` URI — instead of over the network. The
  // receiver ingests it through the same decrypt-and-unpack path as a
  // propagated message, with stamp enforcement disabled.
  // ------------------------------------------------------------------

  /**
   * Serializes and encrypts the message into the paper delivery form, ready to
   * be encoded as an `lxm://` URI or QR code (`LXMessage.pack()` PAPER branch).
   *
   * The encrypted paper payload must fit within {@link PAPER_MDU} bytes (the
   * QR-code capacity); a `TypeError` is thrown otherwise, mirroring the
   * Python reference.
   *
   * @param {import("../core/identity.js").Identity} sourceIdentity
   * @param {import("../core/destination.js").Destination} outboundDestination
   *   recipient `lxmf.delivery` destination (Direction.OUT; holds the
   *   recipient public key + recalled ratchet).
   * @returns {Promise<{paperData: Uint8Array, transientId: Uint8Array, wireData: Uint8Array}>}
   * @throws {TypeError} when the encrypted paper payload exceeds `PAPER_MDU`.
   */
  async toPaperData(sourceIdentity, outboundDestination) {
    const { lxmfData, transientId, wireData } = await this.toPropagationData(
      sourceIdentity,
      outboundDestination,
    );
    if (lxmfData.length > PAPER_MDU) {
      throw new TypeError(
        `LXMF paper delivery requested, but content of ${lxmfData.length} bytes exceeds the paper message maximum of ${PAPER_MDU} bytes.`,
      );
    }
    return { paperData: lxmfData, transientId, wireData };
  }

  /**
   * Serializes, encrypts, and encodes the message as an `lxm://` URI
   * (`LXMessage.as_uri`): the URL-safe base64 of the paper payload, padding
   * stripped, prefixed with the `lxm` scheme.
   *
   * @param {import("../core/identity.js").Identity} sourceIdentity
   * @param {import("../core/destination.js").Destination} outboundDestination
   * @returns {Promise<string>}
   */
  async toPaperUri(sourceIdentity, outboundDestination) {
    const { paperData } = await this.toPaperData(
      sourceIdentity,
      outboundDestination,
    );
    return Message.paperDataToUri(paperData);
  }

  /**
   * Formats raw paper data as an `lxm://` URI.
   *
   * @param {Uint8Array} paperData
   * @returns {string}
   */
  static paperDataToUri(paperData) {
    return `${URI_SCHEMA}://${bytesToBase64Url(paperData)}`;
  }

  /**
   * Parses an `lxm://` URI back into the raw encrypted paper data
   * (`LXMRouter.ingest_lxm_uri`). The scheme match is case-insensitive and
   * any stray `/` characters in the body are tolerated, matching the Python
   * reference's lenient decoding.
   *
   * @param {string} uri
   * @returns {Uint8Array}
   * @throws {Error} when the URI does not use the `lxm` scheme.
   */
  static paperDataFromUri(uri) {
    if (typeof uri !== "string") {
      throw new TypeError("paperDataFromUri expects a string URI");
    }
    const prefix = `${URI_SCHEMA}://`;
    if (!uri.toLowerCase().startsWith(prefix)) {
      throw new Error(
        `Not an LXMF paper URI: expected the '${prefix}' scheme prefix`,
      );
    }
    return base64UrlToBytes(uri.slice(prefix.length).replace(/\//g, ""));
  }

  /**
   * Decrypts and reconstructs an LXMF message from raw paper data. The paper
   * form is byte-identical to the propagation `lxmf_data` form, so this
   * delegates to {@link Message.fromPropagationData}
   * (`LXMRouter.lxmf_propagation` with `is_paper_message=True`).
   *
   * @param {Uint8Array} paperData
   * @param {import("../core/destination.js").Destination} deliveryDestination
   *   recipient's inbound `lxmf.delivery` destination.
   * @returns {Promise<Message|null>} `null` when decryption fails (wrong
   *   recipient / unknown ratchet) or the input is too short.
   */
  static async fromPaperData(paperData, deliveryDestination) {
    return await Message.fromPropagationData(paperData, deliveryDestination);
  }

  /**
   * Decrypts and reconstructs an LXMF message from an `lxm://` URI — the
   * inverse of {@link Message.toPaperUri}
   * (`LXMRouter.ingest_lxm_uri` + `lxmf_propagation`).
   *
   * @param {string} uri
   * @param {import("../core/destination.js").Destination} deliveryDestination
   * @returns {Promise<Message|null>}
   */
  static async fromPaperUri(uri, deliveryDestination) {
    return await Message.fromPaperData(
      Message.paperDataFromUri(uri),
      deliveryDestination,
    );
  }
}
