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
   * @param {Uint8Array} sourceHash
   * @param {Uint8Array} destinationHash
   * @param {number} timestamp
   * @param {string} title
   * @param {string} content
   * @param {Record<string, any>} fields
   * @param {Uint8Array} signature
   * @param {Uint8Array} signedPart
   */
  constructor(sourceHash, destinationHash, timestamp, title, content, fields, signature, signedPart) {
    this.sourceHash = sourceHash;
    this.senderHash = sourceHash;
    this.destinationHash = destinationHash;
    this.timestamp = timestamp;
    this.title = title;
    this.content = content;
    this.fields = fields;
    this.signature = signature;
    this.signedPart = signedPart;
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
    const messageId = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", idBuffer));

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

    const [timestamp, contentBytes, titleBytes, fields] = decodedPayload;

    // MessagePack often yields raw Uint8Arrays for strings in LXMF, decode them:
    const content =
      contentBytes instanceof Uint8Array
        ? new TextDecoder().decode(contentBytes)
        : contentBytes;

    const title =
      titleBytes instanceof Uint8Array
        ? new TextDecoder().decode(titleBytes)
        : titleBytes;

    return new Message(sourceHash, destinationHash, timestamp, title, content, fields, signature, signedPart);
  }

  /**
   * Serializes the Message into the wire format.
   * @param {import("../core/identity.js").Identity} sourceIdentity
   * @returns {Promise<{messageId: Uint8Array, wireData: Uint8Array}>}
   */
  async serialize(sourceIdentity) {
    const sourceHash = sourceIdentity.identityHash;

    // 1. Construct the MessagePack payload
    // LXMF enforces this exact array order: [Timestamp, Content, Title, Fields]
    const payloadData = [this.timestamp, this.content, this.title, this.fields];
    const msgpackPayload = MicroMsgPack.encode(payloadData);

    // 2. Generate the Message ID (SHA-256 of Dest + Source + Payload)
    const idBuffer = new Uint8Array(32 + msgpackPayload.length);
    idBuffer.set(this.destinationHash, 0);
    idBuffer.set(sourceHash, 16);
    idBuffer.set(msgpackPayload, 32);

    const messageIdBuffer = await globalThis.crypto.subtle.digest(
      "SHA-256",
      idBuffer,
    );
    const messageId = new Uint8Array(messageIdBuffer);

    // 3. Cryptographically sign the ACTUAL buffer that LXMF expects
    // Dest (16) + Source (16) + Payload (N) + MessageID (32)
    const signedPart = new Uint8Array(16 + 16 + msgpackPayload.length + 32);
    signedPart.set(this.destinationHash, 0);
    signedPart.set(sourceHash, 16);
    signedPart.set(msgpackPayload, 32);
    signedPart.set(messageId, 16 + 16 + msgpackPayload.length);

    const signature = await sourceIdentity.sign(signedPart);

    // 4. Assemble the final LXMF wire-format byte array
    const wireData = new Uint8Array(96 + msgpackPayload.length);
    wireData.set(this.destinationHash, 0);
    wireData.set(sourceHash, 16);
    wireData.set(signature, 32);
    wireData.set(msgpackPayload, 96);

    return { messageId, wireData };
  }
}
