/**
 * @file router.js
 * @description LXMF Router for managing incoming and outgoing messages
 */

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import {
  buildAnnounceAppData,
  parseAnnounceAppData,
} from "./announce_data.js";
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
    // Tracks outbound links (by hex link_id) we have already sent LINKIDENTIFY
    // on, so we identify once per link rather than on every message.
    this.identifiedLinks = new Set();
    // Last display name / stamp cost we announced with (§4.3 app_data).
    this.displayName = null;
    this.stampCost = null;
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
   * Announces the `lxmf.delivery` destination with the given display name.
   *
   * Builds the §4.3 msgpack `app_data` (`[name(bin8), stamp_cost, [SF_COMPRESSION]]`)
   * and attaches it to the identity so `Destination.announce` signs it as part
   * of the announce body.
   *
   * @param {string} displayName - Human-readable node name shown to peers.
   * @param {number|null} [stampCost=null] - Active stamp cost (1-254), or null
   *   to advertise stamping as disabled.
   * @returns {Promise<void>}
   */
  async announce(displayName, stampCost = null) {
    if (!this.deliveryDest) {
      throw new Error("Router not initialized; call init() first.");
    }
    this.displayName = displayName;
    this.stampCost = stampCost;
    // Slice so the identity owns an ArrayBuffer-backed copy (the §4.3 blob is
    // signed verbatim by Destination.announce, so the bytes must not alias a
    // larger transient buffer).
    this.identity.appData = buildAnnounceAppData(displayName, stampCost).slice();
    await this.deliveryDest.announce();
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

    // 3. Listen for validated announces from the transport (SPEC §4.5) and
    //    decode the lxmf.delivery `app_data` (§4.3) so the app layer learns
    //    peer display names / stamp costs without a separate handshake.
    //    Self-echo for local destinations is already filtered by the transport
    //    (§9.5), so we only see remote announces here.
    this.rns.transport.addEventListener("announce", (event) => {
      const { destinationHash, identity, appData } =
        /** @type {CustomEvent} */ (event).detail;
      this.dispatchEvent(
        new CustomEvent("peer", {
          detail: {
            destinationHash,
            identity,
            appData: parseAnnounceAppData(appData),
          },
        }),
      );
    });
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

      // Park the message until the link identifies (or the pending-link
      // timeout fires), which is when we can learn the sender's identity.
      this.pendingMessages.set(linkId, wireData);

      return;
    }

    // The sender identity is already known, so there is no need to wait for
    // LINKIDENTIFY. Python's lxmf_delivery delivers immediately in this case;
    // we match that behaviour and only park when the identity is unknown.
    this.pendingMessages.delete(linkId);

    // 3. Verify the signature with §5.6 msgpack-variant tolerance.
    if (!(await message.verifySignature(senderIdentity))) {
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
   * Serializes and sends an LXMF message.
   *
   * When delivering over a link, this waits for the link to become ACTIVE and
   * then sends LINKIDENTIFY (once per initiator link) *before* the message
   * DATA — Python LXMF otherwise drops packets that arrive before identify.
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
      const linkKey = toHex(linkId);
      const link = this.rns.transport.activeLinks.get(linkKey);
      if (link) {
        await link.whenActive();
        // Python LXMF will not process application DATA on a link until the
        // initiator has sent LINKIDENTIFY (it drops anything arriving before
        // that). We enforce the counterpart on our side: identify ourselves to
        // the responder before sending the message, once per initiator link.
        if (link.initiator && !this.identifiedLinks.has(linkKey)) {
          await link.identify(senderIdentity);
          this.identifiedLinks.add(linkKey);
        }
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
