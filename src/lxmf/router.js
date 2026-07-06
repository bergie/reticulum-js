/**
 * @file router.js
 * @description LXMF Router for managing incoming and outgoing messages
 */

import { Destination, DestinationType } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { toHex } from "../utils/encoding.js";
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
          // Inside your link.addEventListener("identify", ...)
          const peerIdentity = event.detail.identity;
          const identityHash = await Identity.truncatedHash(
            peerIdentity.publicKey,
          );

          // 1. Store by the base Identity Hash
          await Destination.remember(
            identityHash,
            identityHash,
            peerIdentity.publicKey,
          );

          // 2. CRITICAL: Derive and store by the LXMF Address (sourceHash)
          // This binds the "Author" to their "Inbox"
          const peerDeliveryDest = await Destination.OUT(
            "lxmf.delivery",
            DestinationType.SINGLE,
            peerIdentity,
            this.rns,
          );

          // Map the LXMF Address to the Identity Key
          await Destination.remember(
            identityHash,
            peerDeliveryDest.destinationHash,
            peerIdentity.publicKey,
          );

          // Now, when processIncomingMessage(wireData) calls recall(sourceHash),
          // it will find the link between the 178b9... hash and the 6c8f... identity key!
          this.processPendingMessages(peerDeliveryDest.destinationHash);
        } catch (e) {
          console.error(
            "[ROUTER] Failed to derive LXMF destination for peer:",
            e,
          );
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

    // Slice the wireData into Hash, Hash, Sig, and Payload views
    const destinationHash = wireData.slice(0, 16);
    const sourceHash = wireData.slice(16, 32);
    const sourceHex = toHex(sourceHash);
    const signature = wireData.slice(32, 96);
    const payload = wireData.slice(96);

    console.log(`[DEBUG] Looking for key: ${toHex(sourceHash)}`);
    console.log(
      `[DEBUG] Pending keys: ${[...this.pendingMessages.keys()].join(", ")}`,
    );
    console.log(
      `[DEBUG] Known keys: ${[...Destination.knownDestinations.keys()].join(", ")}`,
    );

    // Validate signature against the SENDER'S public key
    const senderIdentity = await Destination.recall(sourceHash);

    if (!senderIdentity) {
      console.log(`[ROUTER] Identity unknown for ${sourceHex}. Requesting...`);
      console.log(`[ROUTER] Destination ${toHex(destinationHash)}`);

      // TODO: Broadcast a path request over Reticulum to try to find the sender identity

      // Park the message for a limited time (e.g., 5 seconds)
      this.pendingMessages.set(sourceHex, wireData);

      return;
    }

    // If we reach here, we have the identity, clear any pending message
    this.pendingMessages.delete(sourceHex);

    const identityHash = await Identity.truncatedHash(senderIdentity.publicKey);

    // Calculate the Message ID exactly as LXMF expects
    // SHA-256 of: Dest (16) + Source (16) + Payload (N)
    const idBuffer = new Uint8Array(16 + 16 + payload.length);
    idBuffer.set(destinationHash, 0);
    idBuffer.set(sourceHash, 16);
    idBuffer.set(payload, 32);
    const messageId = new Uint8Array(await crypto.subtle.digest("SHA-256", idBuffer));

    // Construct the actual buffer that was signed by the sender
    // Dest (16) + Source (16) + Payload (N) + MessageID (32)
    const signedPart = new Uint8Array(16 + 16 + payload.length + 32);
    signedPart.set(destinationHash, 0);
    signedPart.set(sourceHash, 16);
    signedPart.set(payload, 32);
    signedPart.set(messageId, 16 + 16 + payload.length);

    // Verify using pure WebCrypto
    // Your senderIdentity.ed25519Pub is already correctly sized at 32 bytes
    const isValid = await crypto.subtle.verify(
      "Ed25519",
      senderIdentity.ed25519Pub,
      signature,
      signedPart
    );

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
      console.log(
        `[ROUTER] Identity acquired. Re-processing parked message for ${hashHex}`,
      );
      const wireData = this.pendingMessages.get(hashHex);
      await this._processIncomingMessage(wireData, linkId);
    }
  }
}
