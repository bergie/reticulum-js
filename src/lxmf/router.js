/**
 * @file router.js
 * @description LXMF Router for managing incoming and outgoing messages
 */

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { Message } from "./message.js";

/**
 * Handles LXMF routing and message processing.
 * @description LXMF Router for managing incoming and outgoing messages
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
    log("ROUTER", "Initializing...");
    // Register the standard LXMF delivery destination.
    // Assumes Destination.IN was updated to accept the rnsCore as the 4th/5th parameter
    const deliveryDest = await Destination.IN(
      "lxmf.delivery",
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    log("ROUTER", `deliveryDest set: ${deliveryDest.name}`);
    this.deliveryDest = deliveryDest;

    // Bind it to the central routing table
    this.rns.transport.bindLocalDestination(deliveryDest);
    this.rns.registerDestination(deliveryDest);

    this._setupListeners();

    this.dispatchEvent(
      new CustomEvent("ready", { detail: { destination: deliveryDest } }),
    );
    log("ROUTER", "init complete.");
  }

  /**
   * Sets up event listeners for both direct packets and incoming link requests.
   * @private
   */
  _setupListeners() {
    // 1. Listen for standard Single-Packet LXMF Messages
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "data",
      async (/** @type {any} */ event) => {
        const { plaintext } = /** @type {any} */ (event).detail;
        try {
          await this._processIncomingMessage(
            plaintext,
            null,
            this.deliveryDest.destinationHash,
          );
        } catch (e) {
          log(
            "LXMF",
            `[!] Failed to process single-packet LXMF message: ${e}`,
            LogLevel.ERROR,
          );
        }
      },
    );

    // 2. Listen for Large LXMF Messages arriving via Links
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "link_request",
      async (/** @type {any} */ event) => {
        log("LXMF", "[*] Incoming LXMF Link Request");

        try {
          // Use the clean callback we built into Destination.js
          const link = await /** @type {any} */ (this.deliveryDest).acceptLink(
            event.detail.packet,
          );

          // Listen for data streaming over the established link
          link.addEventListener("data", async (/** @type {any} */ pktEvent) => {
            //console.log("RECV", pktEvent.detail.packet, pktEvent.detail.link);
            await this._processIncomingMessage(
              /** @type {any} */ (pktEvent).detail.packet.payload,
              pktEvent.detail.link,
              this.deliveryDest.destinationHash,
            );
          });
        } catch (e) {
          log(
            "LXMF",
            `[!] Failed to respond to LXMF link request: ${e}`,
            LogLevel.ERROR,
          );
        }
      },
    );

    // 2. Listen for IDENTIFY packets so we can process any pending
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "identify",
      async (/** @type {any} */ event) => {
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
            DestType.SINGLE,
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
          this.processPendingMessages(identityHash);
        } catch (e) {
          log(
            "ROUTER",
            `Failed to derive LXMF destination for peer: ${e}`,
            LogLevel.ERROR,
          );
        }
      },
    );
  }

  /**
   * Processes a raw LXMF message wire buffer.
   * @param {Uint8Array} wireData
   * @param {Uint8Array|null} linkId
   * @param {Uint8Array} [expectedDestHash]
   * @private
   */
  async _processIncomingMessage(wireData, linkId, expectedDestHash) {
    if (wireData.length < 80) {
      throw new Error("LXMF message too short to contain required headers");
    }

    // 1. Deserialize the message immediately
    const message = await Message.deserialize(wireData, expectedDestHash);

    const sourceHex = toHex(message.senderHash);

    // 2. Validate signature against the SENDER'S public key
    const senderIdentity = await Destination.recall(message.senderHash);

    if (!senderIdentity) {
      log("ROUTER", `Identity unknown for ${sourceHex}. Requesting...`);
      // TODO: Send path request

      // Park the message for a limited time (e.g., 5 seconds)
      this.pendingMessages.set(sourceHex, wireData);

      return;
    }

    // If we reach here, we have the identity, clear any pending message
    this.pendingMessages.delete(sourceHex);

    // 3. Verify using the identity helper method
    if (
      !(await senderIdentity.validate(message.signature, message.signedPart))
    ) {
      throw new Error(
        "Invalid LXMF message signature: Cryptographic proof failed.",
      );
    }

    // 4. Dispatch to the UI layer
    this.dispatchEvent(
      new CustomEvent("message", {
        detail: {
          message,
          link: linkId,
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
      log(
        "ROUTER",
        `Identity acquired. Re-processing parked message for ${hashHex}`,
      );
      const wireData = this.pendingMessages.get(hashHex);
      await this._processIncomingMessage(
        wireData,
        linkId,
        this.deliveryDest.destinationHash,
      );
    }
  }

  /**
   * @param {Message} message
   * @param {Identity} senderIdentity
   * @param {Uint8Array|null} linkId
   */
  async send(message, senderIdentity, linkId) {
    const { messageId, wireData } = await message.serialize(senderIdentity);
    const packet = new Packet({
      packetType: PacketType.DATA,
      contextFlag: true,
      contextByte: ContextType.NONE,
      destinationHash: message.destinationHash,
      destinationType: DestType.SINGLE,
      transportType: 0,
      payload: wireData,
    });
    log("LXMF", `DEBUG: Sending LXMF Message ID: ${toHex(messageId)}`);
    log("LXMF", `DEBUG: Sending to ${toHex(message.destinationHash)}`);
    // await this.deliveryDest.send(packet);
    // console.log("SEND", packet, linkId);
    await this.rns.transport.sendPacket(packet, linkId);
    //await this.rns.transport.sendPacket(packet, linkId);
  }
}
