import { LocalClientInterface } from "../interfaces/local_client.js";
import { TransportCore } from "../transport/transport.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { getSharedInstanceEndpoint } from "./config.js";
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

    // Shared-instance role state (Python reference: is_shared_instance /
    // is_connected_to_shared_instance / is_standalone_instance). A node is at
    // most one of these; see connectToSharedInstance().
    /** @type {boolean} */
    this.isSharedInstance = false;
    /** @type {boolean} */
    this.isConnectedToSharedInstance = false;
    /** @type {boolean} */
    this.isStandaloneInstance = false;
    /** @type {LocalClientInterface | null} */
    this.sharedInstanceInterface = null;

    log("Reticulum", "Reticulum Engine initialized.");
  }

  /**
   * Attaches a physical or virtual network interface to the router.
   * @param {import("../interfaces/base.js").Interface} rnsInterface - An instantiated interface (TCP, WebSocket, RNode)
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

  /**
   * Connects this node to a locally running shared instance — a Python `rnsd`
   * or our own daemon — over a loopback socket, sharing its interfaces instead
   * of opening our own. Mirrors the client side of the Python reference
   * `Reticulum.__start_local_interface`.
   *
   * If none of `options.host`, `options.port`, `options.socketPath` is given,
   * the endpoint is discovered from the Python config
   * (`~/.reticulum/config`): `shared_instance_port`, `shared_instance_type`
   * and `instance_name`, with the Python defaults (`share_instance = Yes`,
   * port `37428`) when absent. On platforms without the abstract AF_UNIX
   * namespace (macOS, Windows) the transport is always TCP.
   *
   * Returns the connected {@link LocalClientInterface} on success, or `null`
   * if `share_instance = No` in the config or the endpoint is not currently
   * reachable (the background reconnect loop is cancelled in the latter case,
   * so a caller can cleanly fall back to a standalone interface). On success
   * sets {@link Reticulum#isConnectedToSharedInstance}.
   * @param {Object} [options]
   * @param {string} [options.host] - Override the discovered TCP host
   *   (defaults to `127.0.0.1`).
   * @param {number} [options.port] - Override the discovered TCP port.
   * @param {string} [options.socketPath] - Connect over a Unix domain socket /
   *   named pipe instead of TCP.
   * @param {string} [options.configDir] - Config directory to discover from.
   * @param {number} [options.ifacSize] - Optional IFAC size in bytes.
   * @param {string} [options.name] - Interface name.
   * @param {boolean} [options.autoReconnect=true] - Reconnect after drops.
   * @param {number} [options.reconnectWait=8] - Seconds between attempts.
   * @param {number|null} [options.maxReconnectTries] - Attempt cap, or `null`
   *   for unlimited.
   * @param {number} [options.connectTimeout=5] - Per-dial timeout in seconds.
   * @returns {Promise<LocalClientInterface | null>}
   */
  async connectToSharedInstance(options = {}) {
    let { host, port, socketPath } = options;

    // Discovery is all-or-nothing: if the caller did not pin an endpoint, look
    // it up from the Python config.
    if (socketPath === undefined && port === undefined) {
      const endpoint = getSharedInstanceEndpoint({
        configDir: options.configDir,
      });
      if (!endpoint.shareInstance) {
        log(
          "Reticulum",
          "share_instance disabled in config; not connecting to a shared instance",
          LogLevel.VERBOSE,
        );
        return null;
      }
      socketPath = endpoint.socketPath;
      host = endpoint.host;
      port = endpoint.port;
    }

    if (!socketPath) host = host || "127.0.0.1";

    const iface = new LocalClientInterface({
      host,
      port,
      socketPath,
      name: options.name,
      ifacSize: options.ifacSize,
      autoReconnect: options.autoReconnect,
      reconnectWait: options.reconnectWait,
      maxReconnectTries: options.maxReconnectTries,
      connectTimeout: options.connectTimeout,
    });

    try {
      await iface.connect();
    } catch (e) {
      // First dial failed: cancel the background reconnect loop so we don't
      // leak an endlessly-retrying interface, and let the caller fall back.
      await iface.disconnect();
      log(
        "Reticulum",
        `Shared instance not reachable: ${/** @type {any} */ (e).message}`,
        LogLevel.WARN,
      );
      return null;
    }

    this.addInterface(iface, true);
    this.isConnectedToSharedInstance = true;
    this.isStandaloneInstance = false;
    this.sharedInstanceInterface = iface;
    log("Reticulum", `[+] Connected to shared instance via ${iface.name}`);
    return iface;
  }
}
