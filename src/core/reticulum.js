import { InterfaceDiscovery } from "../transport/discovery.js";
import { TransportCore } from "../transport/transport.js";
import { toHex } from "../utils/encoding.js";
import { log } from "../utils/log.js";
import { Packet } from "./packet.js";

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
   * @param {boolean} [config.useImplicitProof] - §6.5.2 PROOF form for opportunistic DATA: `true` (default, upstream) emits the 64-byte implicit body; `false` emits the 96-byte explicit body.
   * @param {boolean} [config.enableDiscovery] - When true, start an
   *   {@link InterfaceDiscovery} listener on the transport `"announce"` event
   *   so a leaf can discover connectable transport-node interfaces on the
   *   `rnstransport.discovery.interface` aspect (Python `discover_interfaces`).
   *   v1 is surface-only — no auto-connect.
   * @param {Object} [config.discovery] - Extra options forwarded to the
   *   {@link InterfaceDiscovery} constructor when `enableDiscovery` is true
   *   (`requiredValue`, `discoverySources`, `networkIdentity`, `backboneSupport`).
   */
  constructor(config = {}) {
    this.storage = config.storageAdapter || null;
    this.compressionProvider = config.compressionProvider || null;

    // §6.5.2: upstream defaults to `use_implicit_proof = True`, emitting the
    // 64-byte implicit PROOF form. Set `useImplicitProof: false` to emit the
    // 96-byte explicit form (packet_hash || signature).
    this.useImplicitProof = config.useImplicitProof ?? true;

    // The internal router that handles Interface failover, KISS framing, and packet delivery
    this.transport = new TransportCore();

    // Local registered endpoints (e.g., the Yjs sync endpoint, LXMF delivery)
    this.localDestinations = new Map();

    // Interface discovery (work doc #17). Surface-only in v1: parses,
    // stamp-validates and surfaces `rnstransport.discovery.interface` announces
    // as `discovery.on("discovered", ...)`. `start()` is async (it precomputes
    // the aspect name-hash and hydrates from storage) so it is fire-and-forget
    // here; callers that need it ready can `await rns.discovery?.startPromise`.
    this.discovery = null;
    if (config.enableDiscovery) {
      this.discovery = new InterfaceDiscovery({
        transport: this.transport,
        storageAdapter: this.storage,
        ...config.discovery,
      });
      this.discovery.startPromise = this.discovery.start();
    }

    log("Reticulum", "Reticulum Engine initialized.");
  }

  /**
   * Attaches a physical or virtual network interface to the router.
   *
   * Connecting to a local shared instance is now the caller's job — use the
   * `LocalClientInterface.connectToSharedInstance()` static factory (from
   * `reticulum-js/src/interfaces/local_client.js`) and pass the resulting
   * interface here. Keeping shared-instance discovery out of the core keeps
   * `Reticulum` free of Node.js builtins and browser-safe.
   * @param {import("../interfaces/base.js").Interface} rnsInterface - An instantiated interface (TCP, WebSocket, RNode, shared-instance client, ...)
   * @param {boolean} isDefault - If true, unroutable packets fallback to this interface
   */
  addInterface(rnsInterface, isDefault = false) {
    this.transport.addInterface(rnsInterface, isDefault);
    log("Reticulum", `[+] Interface attached: ${rnsInterface.name}`);
  }

  /**
   * Removes an interface and purges its routes from the TransportCore.
   * @param {import("../interfaces/base.js").Interface} rnsInterface - An instantiated interface (TCP, WebSocket, RNode)
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
