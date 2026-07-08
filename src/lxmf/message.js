/**
 * @file message.js
 * @description LXMF Message serialization and construction
 */

import { MicroMsgPack } from "../utils/msgpack.js";

/**
 * Represents an LXMF message.
 */
export class Message {
  /**
   * @param {Object} options
   * @param {Uint8Array} options.sourceHash
   * @param {Uint8Array} options.destinationHash
   * @param {number} [options.timestamp]
   * @param {string} [options.title]
   * @param {string} [options.content]
   * @param {Map<string, any>} [options.fields]
   * @param {Uint8Array} [options.signature]
   * @param {Uint8Array} [options.signedPart]
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
  }) {
    this.sourceHash = sourceHash;
    this.senderHash = sourceHash;
    this.destinationHash = destinationHash;
    (this.timestamp = timestamp || Date.now() / 1000), (this.title = title);
    this.content = content;
    this.fields = fields || new Map();
    this.signature = signature;
    this.signedPart = signedPart;
  }

  /**
   * Serializes the Message into the wire format.
   * @param {import("../core/identity.js").Identity} sourceIdentity
   * @returns {Promise<{messageId: Uint8Array, wireData: Uint8Array}>}
   */
  async serialize(sourceIdentity) {
    const sourceHash = sourceIdentity.identityHash;

    // LXMF Standard: [timestamp, title, content, fields]
    const msgpackPayload = MicroMsgPack.encode([this.timestamp, this.title, this.content, this.fields]);

    // 1. Construct the 'hashed_part' (Dest + Source + Payload)
    const hashedPart = new Uint8Array(16 + 16 + msgpackPayload.length);
    hashedPart.set(this.destinationHash, 0);
    hashedPart.set(sourceHash, 16);
    hashedPart.set(msgpackPayload, 32);

    // 2. Generate Message ID (SHA-256 of hashedPart)
    const messageIdBuffer = await crypto.subtle.digest("SHA-256", hashedPart);
    const messageId = new Uint8Array(messageIdBuffer);

    // 3. Construct the 'signed_part'
    // Python signs (hashedPart + messageId)
    const signedPart = new Uint8Array(hashedPart.length + messageId.length);
    signedPart.set(hashedPart, 0);
    signedPart.set(messageId, hashedPart.length);

    // 4. SIGN THE signedPart
    const signature = await sourceIdentity.sign(signedPart);

    // 5. Assemble wireData
    const wireData = new Uint8Array(16 + 16 + 64 + msgpackPayload.length);
    wireData.set(this.destinationHash, 0);
    wireData.set(sourceHash, 16);
    wireData.set(signature, 32);
    wireData.set(msgpackPayload, 96);

    return { messageId, wireData };
  }

  /**
   * Creates a Message from wire data.
   * @param {Uint8Array} wireData
   * @returns {Promise<Message>}
   */
  static async deserialize(wireData) {
    if (wireData.length < 96) {
      throw new Error("LXMF message too short to contain required headers");
    }

    // Slice the wireData into Hash, Hash, Sig, and Payload views
    const destinationHash = wireData.slice(0, 16);
    const sourceHash = wireData.slice(16, 32);
    const signature = wireData.slice(32, 96);
    const payload = wireData.slice(96);

    // Calculate the Message ID exactly as LXMF expects
    // SHA-256 of: Dest (16) + Source (16) + Payload (N)
    const idBuffer = new Uint8Array(16 + 16 + payload.length);
    idBuffer.set(destinationHash, 0);
    idBuffer.set(sourceHash, 16);
    idBuffer.set(payload, 32);
    const messageId = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", idBuffer),
    );

    // Construct the actual buffer that was signed by the sender
    // Dest (16) + Source (16) + Payload (N) + MessageID (32)
    const signedPart = new Uint8Array(16 + 16 + payload.length + 32);
    signedPart.set(destinationHash, 0);
    signedPart.set(sourceHash, 16);
    signedPart.set(payload, 32);
    signedPart.set(messageId, 16 + 16 + payload.length);

    // Decode the MessagePack payload
    const decodedPayload = MicroMsgPack.decode(payload);

    if (!Array.isArray(decodedPayload) || decodedPayload.length < 4) {
      throw new Error(
        "Invalid LXMF payload format: Expected 4-element MessagePack array",
      );
    }

    const [timestamp, titleBytes, contentBytes, fields] = decodedPayload;

    // MessagePack often yields raw Uint8Arrays for strings in LXMF, decode them:
    const content =
      contentBytes instanceof Uint8Array
        ? new TextDecoder().decode(contentBytes)
        : contentBytes;

    const title =
      titleBytes instanceof Uint8Array
        ? new TextDecoder().decode(titleBytes)
        : titleBytes;

    return new Message({
      sourceHash,
      destinationHash,
      timestamp,
      title,
      content,
      fields,
      signature,
      signedPart,
    });
  }
}
