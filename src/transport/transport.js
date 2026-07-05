// src/transport/transport.js

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { PacketType } from "../core/packet.js";
import { toHex } from "../utils/encoding.js";
import { RoutingTable } from "./router.js";

/**
 * The central network router for the Reticulum node.
 * Routes packets emitted by Interfaces.
 */
export class TransportCore extends EventTarget {
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
    if (!iface._packetWriter) {
      iface._packetWriter = iface.writable.getWriter();
    }

    // 2. Listen to the Interface's inbound Packet loop
    iface.addEventListener("packet", async (event) => {
      await this._routeIncomingPacket(event.detail.packet, iface);
    });

    // 3. Handle graceful teardown
    iface.addEventListener("closed", () => this.removeInterface(iface));
    iface.addEventListener("error", (e) =>
      console.error(`[!] Interface ${iface.name} error:`, e.message),
    );

    console.log(`[+] Transport bound to interface: ${iface.name}`);
  }

  /**
   * @param {import("../interfaces/base.js").Interface} iface
   */
  removeInterface(iface) {
    if (iface._packetWriter) {
      iface._packetWriter.releaseLock();
    }
    this.interfaces.delete(iface);
    this.routingTable.dropInterface(iface);
    if (this.defaultInterface === iface) this.defaultInterface = null;
    console.warn(`[-] Interface removed: ${iface.name}`);
  }

  /**
   * @param {Uint8Array} destinationHash
   * @param {import("./link.js").Link} link
   */
  addLink(destinationHash, link) {
    const hex = toHex(destinationHash);
    console.log(`Registering link ${hex}`);
    this.activeLinks.set(hex, link);
  }

  /**
   * @param {Uint8Array} destinationHash
   */
  removeLink(destinationHash) {
    const hex = toHex(destinationHash);
    this.activeLinks.delete(hex);
    console.log(`[-] Link closed for ${hex}`);
  }

  /**
   * @param {import("../core/destination.js").Destination} destination
   */
  bindLocalDestination(destination) {
    const destHex = toHex(destination.destinationHash);
    console.log(`[ROUTER] Binding local destination: ${destHex}`);
    this.localDestinations.set(destHex, destination);
  }

  /**
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface} receivingInterface
   */
  async _routeIncomingPacket(packet, receivingInterface) {
    // 1. Log arrival
    console.log(
      `[ROUTER] Processing packet type ${packet.packetType} for ${toHex(packet.destinationHash)}`,
    );

    // Force a dump if it's a LINKREQUEST so we can see why it's not triggering
    if (packet.packetType === PacketType.LINKREQUEST) {
      console.log(
        `[!] CRITICAL: Received Type 2 request for ${toHex(packet.destinationHash)}`,
      );
    }

    // If it's an ANNOUNCE, the router handles it, but don't re-broadcast it!
    if (packet.packetType === PacketType.ANNOUNCE) {
      this._handleAnnounce(packet);
      return; // STOP! Do not pass to any other logic.
    }

    // 2. CHECK IF THIS PACKET IS FOR US
    const destHex = toHex(packet.destinationHash);

    // 3. If it's for a known local destination, route it there
    if (this.localDestinations.has(destHex)) {
      console.log(`Packet to local destination ${destHex}`);
      const destination = this.localDestinations.get(destHex);
      await destination.receive(packet, receivingInterface);
      return; // STOP! Success.
    }

    // 4. If it's for an active link, route it there
    if (this.activeLinks.has(destHex)) {
      console.log(`Packet to LINK ${destHex}`);
      const link = this.activeLinks.get(destHex);
      await link.receive(packet);
      return; // STOP! Success.
    }

    // 5. IF WE REACH HERE: It's not for us.
    // If you are acting as a router/node, you'd forward it.
    // But since you are a bot, JUST DROP IT.
    console.log(`[ROUTER] Packet for ${destHex} is not for us. Dropping.`);
    console.log(
      `[ROUTER] Registered local destinations: ${Array.from(this.localDestinations.keys()).join(", ")}`,
    );
  }

  /**
   * @param {import("../core/packet.js").Packet} packet
   */
  async _handleAnnounce(packet) {
    // 1. The payload of an ANNOUNCE packet contains the public key
    //    and metadata required to build an Identity.
    // 2. We use Destination.remember to store this peer
    console.log(`[DEBUG] Announce payload length: ${packet.payload.length}`);

    // In Reticulum, the identity key is at the very beginning of the payload.
    // If it's less than 32 bytes, the packet is corrupted.
    if (packet.payload.length < 64) {
      console.error("[!] Announce payload too short!");
      return;
    }

    try {
      // The payload contains the full identity block at the start
      const identityBlock = packet.payload.slice(0, 64);
      // Log the first 32 bytes and the last 32 bytes
      // console.log("Bytes 0-32 (Ed25519?):", identityBlock.slice(0, 32));
      // console.log("Bytes 32-64 (X25519?):", identityBlock.slice(32, 64));
      const appData = packet.payload.slice(64);

      // For ANNOUNCE, the sender hash is actually the hash of the public key
      // embedded in the payload.
      // Use your Identity class to derive the hash:
      const identity = await Identity.fromPublicKey(identityBlock);
      const senderHash = await Identity.truncatedHash(identity.publicKey);

      // Use your existing Destination.remember to add this to the network graph
      await Destination.remember(
        senderHash,
        packet.destinationHash,
        identityBlock,
        appData,
      );

      console.log(`[!] Network: Remembered new peer ${toHex(senderHash)}`);
    } catch (e) {
      console.error("[!] Failed to process announce:", e);
    }
  }

  /**
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface|null} sourceInterface
   */
  broadcast(packet, sourceInterface = null) {
    for (const iface of this.interfaces) {
      if (iface === sourceInterface || !iface._packetWriter) continue;

      // Write the Packet object directly. The interface's Framer turns it into bytes.
      iface._packetWriter.write(packet).catch((err) => {
        console.error(`[!] Broadcast failed on ${iface.name}:`, err);
      });
    }
  }

  /**
   * @param {import("../core/packet.js").Packet} packet
   */
  async sendPacket(packet) {
    const destHex = Buffer.from(packet.destinationHash).toString("hex");
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
