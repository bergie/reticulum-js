// src/transport/transport.js

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, getEnumName, PacketType } from "../core/packet.js";
import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { RoutingTable } from "./router.js";

/**
 * The central network router for the Reticulum node.
 * Routes packets emitted by Interfaces.
 */
export class TransportCore extends EventTarget {
  /**
   * Creates an empty transport core with no interfaces, links or routes.
   */
  constructor() {
    super();
    this.interfaces = new Set();
    this.localDestinations = new Map();
    this.activeLinks = new Map();
    this.routingTable = new RoutingTable();
    this.defaultInterface = null;
  }

  /**
   * Attaches an interface that emits "packet" events.
   * @param {import("../interfaces/base.js").Interface} iface
   * @param {boolean} isDefault
   */
  addInterface(iface, isDefault = false) {
    this.interfaces.add(iface);
    if (isDefault) this.defaultInterface = iface;

    // 1. Hook into the Interface's existing outbound Framer
    // Since iface.writable is the input to the RNSFramerStream, we just get a writer for it
    const writable = iface.writable;
    if (writable && !iface._packetWriter) {
      iface._packetWriter = writable.getWriter();
    }

    // 2. Listen to the Interface's inbound Packet loop
    iface.addEventListener("packet", (/** @type {any} */ event) => {
      return this._routeIncomingPacket(event.detail.packet, iface);
    });

    // 3. Handle graceful teardown
    iface.addEventListener("closed", () => this.removeInterface(iface));
    iface.addEventListener("error", (/** @type {any} */ e) =>
      log(
        "Transport",
        `[!] Interface ${iface.name} error: ${e.detail.message}`,
        LogLevel.ERROR,
      ),
    );

    log("Transport", `[+] Transport bound to interface: ${iface.name}`);
  }

  /**
   * Detaches an interface, releases its writer and purges its routes.
   * @param {import("../interfaces/base.js").Interface} iface
   */
  removeInterface(iface) {
    if (iface._packetWriter) {
      iface._packetWriter.releaseLock();
    }
    this.interfaces.delete(iface);
    this.routingTable.dropInterface(iface);
    if (this.defaultInterface === iface) this.defaultInterface = null;
    log("Transport", `[-] Interface removed: ${iface.name}`, LogLevel.WARN);
  }

  /**
   * Registers an active link keyed by its destination hash.
   * @param {Uint8Array} destinationHash
   * @param {import("./link.js").Link} link
   */
  addLink(destinationHash, link) {
    const hex = toHex(destinationHash);
    log("Transport", `Registering link ${hex}`);
    this.activeLinks.set(hex, link);
  }

  /**
   * Removes a previously registered link.
   * @param {Uint8Array} destinationHash
   */
  removeLink(destinationHash) {
    const hex = toHex(destinationHash);
    this.activeLinks.delete(hex);
    log("Transport", `[-] Link closed for ${hex}`);
  }

  /**
   * Binds a local destination so inbound packets for it are delivered locally.
   * @param {import("../core/destination.js").Destination} destination
   */
  bindLocalDestination(destination) {
    const hash = destination.destinationHash;
    if (!hash) return;
    const destHex = toHex(hash);
    log("ROUTER", `Binding local destination: ${destHex}`);
    this.localDestinations.set(destHex, destination);
  }

  /**
   * Removes a previously bound local destination.
   * @param {import("../core/destination.js").Destination} destination
   */
  unbindLocalDestination(destination) {
    const hash = destination.destinationHash;
    if (!hash) return;
    const destHex = toHex(hash);
    this.localDestinations.delete(destHex);
    log("Transport", `[-] Unbinding local destination: ${destHex}`);
  }

  /**
   * Dispatches an inbound packet to the matching local destination or link,
   * or drops it if no route exists.
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface} receivingInterface
   * @private
   */
  async _routeIncomingPacket(packet, receivingInterface) {
    // 1. Log arrival
    log(
      "ROUTER",
      `Processing packet type ${getEnumName(PacketType, packet.packetType)} (ctx ${getEnumName(ContextType, packet.contextByte)}) for ${toHex(packet.destinationHash)}`,
    );

    // Force a dump if it's a LINKREQUEST so we can see why it's not triggering
    if (packet.packetType === PacketType.LINKREQUEST) {
      log(
        "Transport",
        `[!] CRITICAL: Received Type 2 request for ${toHex(packet.destinationHash)}`,
      );
    }

    // If it's an ANNOUNCE, the router handles it, but don't re-broadcast it!
    if (packet.packetType === PacketType.ANNOUNCE) {
      await this._handleAnnounce(packet);
      return; // STOP! Do not pass to any other logic.
    }

    // 2. CHECK IF THIS PACKET IS FOR US
    const destHex = toHex(packet.destinationHash);

    // 3. If it's for a known local destination, route it there
    if (this.localDestinations.has(destHex)) {
      log("Transport", `Packet to local destination ${destHex}`);
      const destination = this.localDestinations.get(destHex);
      await destination.receive(packet, receivingInterface);
      return; // STOP! Success.
    }

    // 4. If it's for an active link, route it there
    if (this.activeLinks.has(destHex)) {
      log("Transport", `Packet to LINK ${destHex}`);
      const link = this.activeLinks.get(destHex);
      await link.receive(packet);
      return; // STOP! Success.
    }

    // 5. IF WE REACH HERE: It's not for us.
    // If you are acting as a router/node, you'd forward it.
    // But since you are a bot, JUST DROP IT.
    log("ROUTER", `Packet for ${destHex} is not for us. Dropping.`);
    log(
      "ROUTER",
      `Registered local destinations: ${Array.from(this.localDestinations.keys()).join(", ")}`,
    );
  }

  /**
   * Validates and ingests an ANNOUNCE packet (SPEC.md §4.5).
   *
   * Delegates the body parse, Ed25519 signature verification and destination
   * hash recomputation to {@link Identity.validateAnnounce} (steps 1-3), then
   * performs the public-key collision rejection (step 4) and caches the
   * identity / app_data / ratchet (step 6). Forged or malformed announces are
   * dropped silently; a validated announce is also dispatched as an `announce`
   * event for application-layer handlers (§4.4 name_hash filtering, contact
   * list population, etc.).
   *
   * @param {import("../core/packet.js").Packet} packet
   * @private
   */
  async _handleAnnounce(packet) {
    const destHex = toHex(packet.destinationHash);

    // Self-announce filter (SPEC.md §9.5 / §4.5 step 8): never ingest our own
    // destinations — otherwise we'd populate our contact list with ourselves.
    if (this.localDestinations.has(destHex)) {
      log(
        "Transport",
        `Ignoring ANNOUNCE for local destination ${destHex}`,
        LogLevel.DEBUG,
      );
      return;
    }

    const result = await Identity.validateAnnounce(
      packet.destinationHash,
      packet.contextFlag,
      packet.payload,
    );
    if (!result) return; // validateAnnounce already logged the rejection reason

    const { identity, nameHash, randomHash, ratchet, appData } = result;

    // §4.5 step 4 — public-key collision rejection. First-announcer-wins: a
    // different public_key for an already-known destination_hash is treated as
    // a hash-collision / spoofing attempt and rejected even though the
    // signature is otherwise valid. (In practice this requires a 2^128 hash
    // collision, so it should never fire — but the defense is non-optional.)
    const existing = Destination.knownDestinations.get(destHex);
    if (
      existing &&
      existing[2] &&
      !bytesEqual(existing[2], identity.publicKey)
    ) {
      log(
        "Transport",
        `CRITICAL: public-key collision for ${destHex} — rejecting announce`,
        LogLevel.ERROR,
      );
      return;
    }

    // §4.5 step 6 — cache the announce contents.
    const packetHash = await packet.getHash();
    await Destination.remember(
      packetHash,
      packet.destinationHash,
      identity.publicKey,
      appData,
    );
    if (ratchet) {
      Destination.rememberRatchet(packet.destinationHash, ratchet);
    }

    log(
      "Transport",
      `Validated announce from ${destHex} (name_hash=${toHex(nameHash)}, ratchet=${ratchet ? "yes" : "no"})`,
      LogLevel.DEBUG,
    );
    this.dispatchEvent(
      new CustomEvent("announce", {
        detail: {
          destinationHash: packet.destinationHash,
          identity,
          nameHash,
          randomHash,
          ratchet,
          appData,
          packet,
        },
      }),
    );
  }

  /**
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface|null} sourceInterface
   */
  broadcast(packet, sourceInterface = null) {
    for (const iface of this.interfaces) {
      if (iface === sourceInterface || !iface._packetWriter) continue;

      // Write the Packet object directly. The interface's Framer turns it into bytes.
      iface._packetWriter.write(packet).catch((/** @type {Error} */ err) => {
        log(
          "Transport",
          `[!] Broadcast failed on ${iface.name}: ${err}`,
          LogLevel.ERROR,
        );
      });
    }
  }

  /**
   * @param {import("../core/packet.js").Packet} packet
   * @param {Uint8Array|null} linkId
   */
  async sendPacket(packet, linkId = null) {
    const destHex = toHex(packet.destinationHash);
    const packetHex = toHex(await packet.getHash());
    log("Transport", `Send ${packetHex} to ${destHex}`);

    if (linkId) {
      const linkHex = toHex(linkId);
      const link = this.activeLinks.get(linkHex);
      if (!link) {
        throw new Error(`Link ${linkHex} is not available`);
      }
      await link.send(packet);
      return;
    }

    const nextHopInterface =
      this.routingTable.getRoute(packet.destinationHash)?.interface ||
      this.defaultInterface;

    if (nextHopInterface && nextHopInterface._packetWriter) {
      await nextHopInterface._packetWriter.write(packet);
    } else {
      throw new Error(`No route to host: ${destHex}`);
    }
  }
}
