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
   * Creates an LXMF router bound to the given identity and Reticulum instance.
   * @param {import("../core/identity.js").Identity} identity
   * @param {import("../core/reticulum.js").Reticulum} rnsCore - The Reticulum instance
   */
  constructor(identity, rnsCore) {
    super();
    this.identity = identity;
    this.rns = rnsCore;
    this.deliveryDest = null;
    this.pendingMessages = new Map();
    this.pendingLinks = new Map();
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
    const deliveryDest = this.deliveryDest;
    const expectedDestHash = deliveryDest?.destinationHash;
    if (!expectedDestHash) {
      throw new Error(
        "Cannot set up listeners: delivery destination not initialized",
      );
    }

    // 1. Listen for standard Single-Packet LXMF Messages
    /** @type {any} */ (this.deliveryDest).addEventListener(
      "data",
      async (/** @type {any} */ event) => {
        const { plaintext } = /** @type {any} */ (event).detail;
        try {
          await this._processIncomingMessage(plaintext, null, expectedDestHash);
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
            await this._processIncomingMessage(
              /** @type {any} */ (pktEvent).detail.packet.payload,
              pktEvent.detail.link,
              expectedDestHash,
            );
          });

          // Python LXMF is not ready to receive messages until it has identified
          // We should park messages until we receive LINKIDENTIFY (or a timeout)
          const linkHex = toHex(link.linkId);
          this.pendingLinks.set(linkHex, true);
          const timer = setTimeout(() => {
            log("LXMF", `Timeout waiting for link ${linkHex} to identify`);
            this.pendingLinks.delete(linkHex);
            this.processPendingMessages(link.linkId);
          }, 10000);

          // Listen for identity on the link
          link.addEventListener(
            "identify",
            async (/** @type {any} */ event) => {
              try {
                if (timer) {
                  clearTimeout(timer);
                }

                const peerIdentity = event.detail.identity;
                const identityHash = await Identity.truncatedHash(
                  peerIdentity.publicKey,
                );
                log(
                  "LXMF",
                  `Received LINKIDENTIFY for ${toHex(identityHash)} (${linkHex})`,
                );

                // 2. CRITICAL: Derive and store by the LXMF Address (sourceHash)
                const peerDeliveryDest = await Destination.OUT(
                  "lxmf.delivery",
                  DestType.SINGLE,
                  peerIdentity,
                  this.rns,
                );

                // Map the LXMF Address to the Identity Key
                if (!peerDeliveryDest.destinationHash) {
                  throw new Error(
                    "Failed to derive peer delivery destination hash",
                  );
                }
                await Destination.remember(
                  identityHash,
                  peerDeliveryDest.destinationHash,
                  peerIdentity.publicKey,
                );

                this.pendingLinks.delete(linkHex);
                this.processPendingMessages(link.linkId);
              } catch (e) {
                log(
                  "ROUTER",
                  `Failed to derive LXMF destination for peer from link: ${e}`,
                  LogLevel.ERROR,
                );
              }
            },
          );
        } catch (e) {
          log(
            "LXMF",
            `[!] Failed to respond to LXMF link request: ${e}`,
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

    const linkHex = linkId ? toHex(linkId) : null;

    // 1. Deserialize the message immediately
    const message = await Message.deserialize(wireData, expectedDestHash);

    log("LXMF", `Incoming message from source ${toHex(message.sourceHash)}`);

    // 2. Validate signature against the SENDER'S public key
    const senderIdentity = await Destination.recall(message.sourceHash);

    if (!senderIdentity) {
      log(
        "LXMF",
        `Identity unknown for ${toHex(message.sourceHash)}. Requesting...`,
      );

      // Park the message for a limited time (e.g., 5 seconds)
      this.pendingMessages.set(linkId, wireData);

      return;
    }
    if (linkHex && this.pendingLinks.has(linkHex)) {
      log(
        "LXMF",
        `Link ${linkHex} is pending identification, parking incoming message.`,
      );

      // Park the message for a limited time (e.g., 5 seconds)
      this.pendingMessages.set(linkId, wireData);
      return;
    }

    // If we reach here, we have the identity, clear any pending message
    this.pendingMessages.delete(linkId);

    // 3. Verify using the identity helper method
    if (
      !message.signature ||
      !message.signedPart ||
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
    const expectedDestHash = this.deliveryDest?.destinationHash;
    if (!expectedDestHash) {
      return;
    }
    if (this.pendingMessages.has(linkId)) {
      log(
        "LXMF",
        `Identity acquired. Re-processing parked message for ${hashHex}`,
      );
      const wireData = this.pendingMessages.get(linkId);
      await this._processIncomingMessage(wireData, linkId, expectedDestHash);
    }
  }

  /**
   * Serializes and sends an LXMF message, waiting for the link to become
   * active before delivery when a link id is given.
   * @param {Message} message
   * @param {Identity} senderIdentity
   * @param {Uint8Array|null} linkId
   * @returns {Promise<void>}
   */
  async send(message, senderIdentity, linkId) {
    const { messageId, wireData } = await message.serialize(senderIdentity);
    log("LXMF", `DEBUG: Sending LXMF Message ID: ${toHex(messageId)}`);
    log("LXMF", `DEBUG: Sending to ${toHex(message.destinationHash)}`);

    // Direct delivery happens over a Link. `createLink()` resolves as soon as
    // the handshake is *initiated*, but the session token is only derived once
    // the handshake completes and the Link becomes ACTIVE. Wait for that so we
    // don't try to encrypt with a token that doesn't exist yet.
    if (linkId) {
      const link = this.rns.transport.activeLinks.get(toHex(linkId));
      if (link) {
        await link.whenActive();
      }
    }

    const packet = new Packet({
      packetType: PacketType.DATA,
      contextFlag: true,
      contextByte: ContextType.NONE,
      destinationHash: message.destinationHash,
      destinationType: DestType.SINGLE,
      transportType: 0,
      payload: wireData,
    });
    await this.rns.transport.sendPacket(packet, linkId);
  }
}
