/**
 * @file router.js
 * @description LXMF Router for managing incoming and outgoing messages
 */

import { Destination, DestinationType } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { MicroMsgPack } from "../utils/msgpack.js";
import { toHex } from "../utils/encoding.js";

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
    this.pendingMessages = new Map();
  }

  /**
   * Initializes the router and registers the LXMF delivery destination.
   */
  async init() {
    // Register the standard LXMF delivery destination.
    // Assumes Destination.IN was updated to accept the rnsCore as the 4th/5th parameter
    const deliveryDest = await Destination.IN(
      "lxmf.delivery",
      DestinationType.SINGLE,
      this.identity,
      this.rns,
    );
    this.deliveryDest = deliveryDest;

    // Bind it to the central routing table
    this.rns.transport.bindLocalDestination(deliveryDest);

    this._setupListeners();

    this.dispatchEvent(
      new CustomEvent("ready", { detail: { destination: deliveryDest } }),
    );
  }

  /**
   * Sets up event listeners for both direct packets and incoming link requests.
   * @private
   */
  _setupListeners() {
    // 1. Listen for standard Single-Packet LXMF Messages
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "data",
      async (event) => {
        const { plaintext } = /** @type {any} */ (event).detail;
        try {
          await this._processIncomingMessage(plaintext, null);
        } catch (e) {
          console.error("[!] Failed to process single-packet LXMF message:", e);
        }
      },
    );

    // 2. Listen for Large LXMF Messages arriving via Links
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "link_request",
      async (event) => {
        console.log("[*] Incoming LXMF Link Request");

        try {
          // Use the clean callback we built into Destination.js
          const link = await /** @type {any} */ (this.deliveryDest).acceptLink(
            /** @type {any} */ (event).detail.packet,
            /** @type {any} */ (event).detail.transport,
          );

          // Listen for data streaming over the established link
          link.addEventListener("data", async (pktEvent) => {
            await this._processIncomingMessage(
              /** @type {any} */ (pktEvent).detail.packet.payload,
              pktEvent.detail.link,
            );
          });
        } catch (e) {
          console.error("[!] Failed to respond to LXMF link request:", e);
        }
      },
    );

    // 2. Listen for IDENTIFY packets so we can process any pending
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "identify",
      async (event) => {
        try {
          // 1. Proactively create an OUT destination representing the sender's LXMF inbox
          // (Adjust the parameters if your Destination.OUT signature differs slightly)
          const peerDeliveryDest = await Destination.OUT(
            "lxmf.delivery",
            DestinationType.SINGLE,
            peerIdentity,
            this.rns
          );

          const lxmfHash = peerDeliveryDest.hash;
          const lxmfHex = toHex(lxmfHash);

          console.log(`[ROUTER] Derived LXMF Destination ${lxmfHex} from Link Identity.`);

          // 2. Force this LXMF Destination into the known destinations cache!
          // We use the Identity hash as a pseudo 'packetHash' for the cache entry.
          const identityHash = await Identity.truncatedHash(peerIdentity.publicKey);
          await Destination.remember(identityHash, lxmfHash, peerIdentity.publicKey);

          // 3. Now, tell the router to process messages parked for the LXMF Destination Hash!
          this.processPendingMessages(lxmfHash);

        } catch (e) {
          console.error("[ROUTER] Failed to derive LXMF destination for peer:", e);
        }
      },
    );
  }

  /**
   * Processes a raw LXMF message wire buffer.
   * @param {Uint8Array} wireData
   * @param {Uint8Array|null} linkId
   * @private
   */
  async _processIncomingMessage(wireData, linkId) {
    if (wireData.length < 96) {
      throw new Error("LXMF message too short to contain required headers");
    }

    // 1. Slice the wireData into Hash, Hash, Sig, and Payload views
    const destinationHash = wireData.slice(0, 16);
    const sourceHash = wireData.slice(16, 32);
    const sourceHex = toHex(sourceHash);
    const signature = wireData.slice(32, 96);
    const payload = wireData.slice(96);

    console.log(`[DEBUG] Looking for key: ${toHex(sourceHash)}`);
    console.log(`[DEBUG] Pending keys: ${[...this.pendingMessages.keys()].join(', ')}`);
    console.log(`[DEBUG] Known keys: ${[...Destination.knownDestinations.keys()].join(', ')}`);

    // 3. Validate signature against the SENDER'S public key
    const senderIdentity = await Destination.recall(sourceHash);

    if (!senderIdentity) {
      console.log(`[ROUTER] Identity unknown for ${sourceHex}. Requesting...`);
      console.log(`[ROUTER] Destination ${toHex(destinationHash)}`);

      // Broadcast an Identity Request over the network
      await this.rns.requestIdentity(sourceHash);

      // Park the message for a limited time (e.g., 5 seconds)
      this.pendingMessages.set(sourceHex, wireData);

      return;
    }

    // If we reach here, we have the identity, clear any pending message
    this.pendingMessages.delete(sourceHex);

    // Reconstruct the idBuffer (Destination + Source + Payload)
    const idBuffer = new Uint8Array(32 + payload.length);
    idBuffer.set(destinationHash, 0);
    idBuffer.set(sourceHash, 16);
    idBuffer.set(payload, 32);

    // Calculate the Message ID (SHA-256 of the idBuffer)
    const messageIdBuffer = await crypto.subtle.digest("SHA-256", idBuffer);
    const messageId = new Uint8Array(messageIdBuffer);

    // CRITICAL FIX: The sender ONLY signed the 32-byte Message ID.
    // Do not concatenate anything else!
    const isValid = await senderIdentity.validate(signature, messageId);

    if (!isValid) {
      throw new Error("Invalid LXMF message signature: Cryptographic proof failed.");
    }

    // Decode the MessagePack payload
    const decodedPayload = MicroMsgPack.decode(payload);

    if (!Array.isArray(decodedPayload) || decodedPayload.length < 4) {
      throw new Error(
        "Invalid LXMF payload format: Expected 4-element MessagePack array",
      );
    }

    const [timestamp, titleBytes, contentBytes, fields] = decodedPayload;

    // MessagePack often yields raw Uint8Arrays for strings in LXMF, decode them:
    const title =
      titleBytes instanceof Uint8Array
      ? new TextDecoder().decode(titleBytes)
      : titleBytes;

    const content =
      contentBytes instanceof Uint8Array
      ? new TextDecoder().decode(contentBytes)
      : contentBytes;

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

  /**
   * Call this when a new Identity is cached (e.g., in your IDENTIFY handler).
   * It checks if any parked messages are now ready for processing.
   * @param {Uint8Array} linkId
   */
  async processPendingMessages(linkId) {
    const hashHex = toHex(linkId);
    if (this.pendingMessages.has(hashHex)) {
      console.log(`[ROUTER] Identity acquired. Re-processing parked message for ${hashHex}`);
      const wireData = this.pendingMessages.get(hashHex);
      await this._processIncomingMessage(wireData, linkId);
    }
  }
}
