/**
 * @file router.js
 * @description LXMF Router for managing incoming and outgoing messages
 */

import { Destination, DestinationType } from "../core/destination.js";
import { MicroMsgPack } from "../utils/msgpack.js";

/**
 * Handles LXMF routing and message processing.
 */
export class LXMRouter extends EventTarget {
  /**
   * @param {import("../core/identity.js").Identity} identity
   * @param {import("../core/reticulum.js").Reticulum} rnsCore - The Reticulum instance
   */
  constructor(identity, rnsCore) {
    super();
    this.identity = identity;
    this.rns = rnsCore;
    this.deliveryDest = null;
  }

  /**
   * Initializes the router and registers the LXMF delivery destination.
   */
  async init() {
    // Register the standard LXMF delivery destination.
    // Assumes Destination.IN was updated to accept the rnsCore as the 4th/5th parameter
    this.deliveryDest = await Destination.IN(
      "lxmf.delivery",
      DestinationType.SINGLE,
      this.identity,
      this.rns,
    );

    // Bind it to the central routing table
    this.rns.transport.bindLocalDestination(this.deliveryDest);

    this._setupListeners();

    this.dispatchEvent(
      new CustomEvent("ready", { detail: { destination: this.deliveryDest } }),
    );
  }

  /**
   * Sets up event listeners for both direct packets and incoming link requests.
   * @private
   */
  _setupListeners() {
    // 1. Listen for standard Single-Packet LXMF Messages
    this.deliveryDest.addEventListener("data", async (event) => {
      const { plaintext } = event.detail;
      try {
        await this._processIncomingMessage(plaintext);
      } catch (e) {
        console.error("[!] Failed to process single-packet LXMF message:", e);
      }
    });

    // 2. Listen for Large LXMF Messages arriving via Links
    this.deliveryDest.addEventListener("link_request", async (event) => {
      console.log("[*] Incoming LXMF Link Request");

      try {
        // Use the clean callback we built into Destination.js
        const link = await this.deliveryDest.acceptLink(
          event.detail.packet,
          event.detail.transport,
        );

        // Listen for data streaming over the established link
        link.addEventListener("data", async (pktEvent) => {
          await this._processIncomingMessage(pktEvent.detail.packet.raw);
        });
      } catch (e) {
        console.error("[!] Failed to respond to LXMF link request:", e);
      }
    });
  }

  /**
   * Processes a raw LXMF message wire buffer.
   * @param {Uint8Array} wireData
   * @private
   */
  async _processIncomingMessage(wireData) {
    if (wireData.length < 96) {
      throw new Error("LXMF message too short to contain required headers");
    }

    // 1. Slice the wireData into Hash, Hash, Sig, and Payload views
    const destinationHash = wireData.slice(0, 16);
    const sourceHash = wireData.slice(16, 32);
    const signature = wireData.slice(32, 96);
    const payload = wireData.slice(96);

    // 2. Reconstruct the Message ID
    const idBuffer = new Uint8Array(32 + payload.length);
    idBuffer.set(destinationHash, 0);
    idBuffer.set(sourceHash, 16);
    idBuffer.set(payload, 32);

    const messageIdBuffer = await globalThis.crypto.subtle.digest(
      "SHA-256",
      idBuffer,
    );
    const messageId = new Uint8Array(messageIdBuffer).subarray(0, 16);

    // 3. CRYPTO FIX: Validate signature against the SENDER'S public key, not ours!
    const senderIdentity = await Destination.recall(sourceHash);

    if (!senderIdentity) {
      // In a full implementation, you might queue an Identity Request here.
      // For now, we drop it because we can't mathematically prove who sent it.
      throw new Error(
        "Cannot verify message: Sender identity unknown (No Announce received).",
      );
    }

    const isValid = await senderIdentity.validate(signature, messageId);

    if (!isValid) {
      throw new Error(
        "Invalid LXMF message signature: Cryptographic proof failed.",
      );
    }

    // 4. Decode the MessagePack payload
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

    // 5. Dispatch to the UI layer
    this.dispatchEvent(
      new CustomEvent("message", {
        detail: {
          source: sourceHash,
          title,
          content,
          timestamp,
          fields,
        },
      }),
    );
  }
}
