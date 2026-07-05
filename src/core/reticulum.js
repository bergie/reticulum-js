// src/core/reticulum.js
import { TransportCore } from "../transport/transport.js";
import { Packet, HeaderType, DestType, PacketType } from "./packet.js";
import { toHex } from "../utils/encoding.js";

/**
 * The primary entry point and orchestrator for the Reticulum Network System.
 */
export class Reticulum {
  /**
   * Initializes the Reticulum engine.
   * @param {Object} config - Configuration options for the node.
   * @param {Object} [config.storageAdapter] - Interface for persisting identities and caches.
   * @param {Object} [config.compressionProvider] - Engine for handling bz2 Resources (e.g., for rngit).
   */
  constructor(config = {}) {
    this.storage = config.storageAdapter || null;
    this.compressionProvider = config.compressionProvider || null;

    // The internal router that handles Interface failover, KISS framing, and packet delivery
    this.transport = new TransportCore();

    // Local registered endpoints (e.g., the Yjs sync endpoint, LXMF delivery)
    this.localDestinations = new Map();

    console.log("Reticulum Engine initialized.");
  }

  /**
   * Attaches a physical or virtual network interface to the router.
   * @param {import("../interfaces/base.js").Interface} rnsInterface - An instantiated interface (TCP, WebSocket, RNode)
   * @param {boolean} isDefault - If true, unroutable packets fallback to this interface
   */
  addInterface(rnsInterface, isDefault = false) {
    this.transport.addInterface(rnsInterface, isDefault);
    console.log(`[+] Interface attached: ${rnsInterface.name}`);
  }

  /**
   * Removes an interface and purges its routes from the TransportCore.
   */
  removeInterface(rnsInterface) {
    this.transport.removeInterface(rnsInterface);
    console.log(`[-] Interface removed: ${rnsInterface.name}`);
  }

  /**
   * Requests the identity and path for a given destination hash.
   * @param {Uint8Array} targetHash - The 16-byte destination/identity hash
   */
  async requestIdentity(targetHash) {
    // 1. Construct the Identity Request Packet
    // Reticulum uses PacketType.LINKREQUEST (0x02) or specific Announce
    // management flags depending on the protocol version.
    const requestPacket = new Packet({
      headerType: HeaderType.HEADER_1,
      hops: 0,
      transportType: 0, // Broadcast/propagation
      destinationType: DestType.PLAIN,
      packetType: PacketType.ANNOUNCE, // Announce-related management
      contextFlag: true,
      contextByte: 0xfd, // Packet.ID_REQUEST
      destinationHash: targetHash,
      payload: new Uint8Array(0), // No payload needed, the hash is in the header
    });

    // 2. Broadcast the request to the network
    console.log(`[RNS] Broadcasting Identity Request for ${toHex(targetHash)}`);
    await this.transport.sendPacket(requestPacket);
  }

  /**
   * Binds an application-level Destination to the network.
   * When your web components spin up and instantiate a Yjs provider,
   * this is where they register their collaborative endpoints to receive traffic.
   * @param {import("../core/destination.js").Destination} destination
   */
  registerDestination(destination) {
    const hashHex = Buffer.from(destination.destinationHash).toString("hex");

    if (this.localDestinations.has(hashHex)) {
      throw new Error(`Destination ${destination.name} is already registered.`);
    }

    // 1. Store locally for inbound routing
    this.localDestinations.set(hashHex, destination);

    // 2. Bind the destination to the transport layer so the router knows
    // to deliver incoming packets here instead of dropping/forwarding them.
    // this.transport.bindLocalDestination(destination);

    // 3. Inject the compression provider if the destination needs to handle Resources
    const appData = new TextDecoder().decode(destination.identity.appData);
    console.log(`[+] Destination registered: ${destination.name} (${appData})`);
  }

  /**
   * Removes a local destination, ceasing all incoming traffic to that application endpoint.
   */
  deregisterDestination(destination) {
    const hashHex = Buffer.from(destination.hash).toString("hex");
    this.localDestinations.delete(hashHex);
    this.transport.unbindLocalDestination(destination);
  }

  /**
   * Broadcasts a packet from a specific destination to the mesh.
   * @param {Packet} packet
   */
  broadcast(packet) {
    // The core acts as the mediator
    this.transport.broadcast(packet);
  }
}
