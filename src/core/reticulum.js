import { TransportCore } from "../transport/transport.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { DestType, HeaderType, Packet, PacketType } from "./packet.js";

/**
 * The primary entry point and orchestrator for the Reticulum Network System.
 * @description The Reticulum class orchestrates the transport and local destinations.
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

    log("Reticulum", "Reticulum Engine initialized.");
  }

  /**
   * Attaches a physical or virtual network interface to the router.
   * @param {any} rnsInterface - An instantiated interface (TCP, WebSocket, RNode)
   * @param {boolean} isDefault - If true, unroutable packets fallback to this interface
   */
  addInterface(rnsInterface, isDefault = false) {
    this.transport.addInterface(rnsInterface, isDefault);
    log("Reticulum", `[+] Interface attached: ${rnsInterface.name}`);
  }

  /**
   * Removes an interface and purges its routes from the TransportCore.
   * @param {any} rnsInterface
   */
  removeInterface(rnsInterface) {
    this.transport.removeInterface(rnsInterface);
    log("Reticulum", `[-] Interface removed: ${rnsInterface.name}`);
  }

  /**
   * Binds an application-level Destination to the network.
   * When your web components spin up and instantiate a Yjs provider,
   * this is where they register their collaborative endpoints to receive traffic.
   * @param {import("../core/destination.js").Destination} destination
   */
  registerDestination(destination) {
    if (!destination.destinationHash) {
      throw new Error("Destination hash must be computed before registration.");
    }
    const hashHex = toHex(destination.destinationHash);

    if (this.localDestinations.has(hashHex)) {
      throw new Error(`Destination ${destination.name} is already registered.`);
    }

    // 1. Store locally for inbound routing
    this.localDestinations.set(hashHex, destination);

    // 2. Bind the destination to the transport layer so the router knows
    // to deliver incoming packets here instead of dropping/forwarding them.
    // this.transport.bindLocalDestination(destination);

    // 3. Inject the compression provider if the destination needs to handle Resources
    // and log the app data if an identity is present.
    if (destination.identity) {
      const appData = new TextDecoder().decode(destination.identity.appData);
      log(
        "Reticulum",
        `[+] Destination registered: ${destination.name} (${appData})`,
      );
    } else {
      log("Reticulum", `[+] Destination registered: ${destination.name}`);
    }
  }

  /**
   * Removes a local destination, ceasing all incoming traffic to that application endpoint.
   * @param {import("../core/destination.js").Destination} destination
   */
  deregisterDestination(destination) {
    if (!destination.destinationHash) {
      throw new Error(
        "Destination hash must be computed before deregistration.",
      );
    }
    const hashHex = toHex(destination.destinationHash);
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
