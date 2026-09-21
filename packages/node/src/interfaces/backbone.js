/**
 * @file backbone.js
 * @description BackboneInterface / BackboneClientInterface — the
 *   high-performance TCP interfaces used between transport nodes,
 *   wire-compatible with the Python reference `BackboneInterface` (work doc
 *   #34).
 *
 * Backbone speaks the same HDLC framing as the TCP interfaces; what makes it
 * a *backbone* is the policy profile:
 *
 * - **Backbone defaults:** a 1 Gbit/s nominal bitrate guess (vs 10 Mbit/s on
 *   plain TCP), which drives interface prioritization and MTU
 *   autoconfiguration (`optimiseMtu()`), and a 1 MiB hard cap on frame size.
 * - **Fast-flapping protection:** inbound connections from a remote IP that
 *   live shorter than the flap threshold are counted; once flaps exceed the
 *   grace count, the IP is blocked for the block time. State is shared
 *   process-wide across all backbone listeners, matching the reference.
 * - **Discovery participation:** `supportsDiscovery` is `true`, so the
 *   interface participates in interface discovery (work doc #17).
 *
 * The Python reference implements this with a process-wide `select.epoll`
 * loop and is therefore Linux-only. That is an implementation artifact, not
 * a protocol requirement: the JS event loop provides the same
 * single-threaded, multiplexed, non-blocking I/O model on every platform,
 * so these interfaces work on any OS with TCP. The fine-grained Linux TCP
 * keepalive knobs (`TCP_USER_TIMEOUT`, `TCP_KEEPINTVL`, `TCP_KEEPCNT`) are
 * not reachable from the standard `node:net` API; `socket.setKeepAlive()`
 * covers `SO_KEEPALIVE` + the initial probe delay (the same accepted gap as
 * the TCP interfaces).
 */

import net from "node:net";
import { Readable, Writable } from "node:stream";
import { Packet } from "@reticulum/core/src/core/packet.js";
import {
  Interface,
  reconnectSchemaProperties,
} from "@reticulum/core/src/interfaces/base.js";
import {
  createHdlcFramerStream,
  createHdlcUnframerStream,
} from "@reticulum/core/src/transport/hdlc-framer.js";
import { LogLevel, log } from "@reticulum/core/src/utils/log.js";
import { AF_INET, AF_INET6, listAddresses } from "../utils/netinfo.js";

/**
 * Largest frame the backbone can carry (`HW_MTU`, 1 MiB), the pre-MTU-
 * autoconfiguration cap.
 */
const BACKBONE_HW_MTU = 1048576;

/**
 * Nominal bitrate guess for the backbone listener (1 Gbit/s, matching the
 * Python reference). Drives interface prioritization and `optimiseMtu()`.
 */
const BACKBONE_BITRATE_GUESS = 1_000_000_000;

/**
 * Default fast-flapping protections, matching the Python reference:
 * connections living shorter than 20 s are counted as flaps; after 5 grace
 * flaps the remote IP is ignored for 12 hours.
 */
const BLOCK_FAST_FLAPPING = true;
const FAST_FLAP_THRESHOLD_SECS = 20;
const FAST_FLAP_GRACE = 5;
const FAST_FLAP_EXPIRY_SECS = 12 * 60 * 60;

/**
 * Per-remote-IP fast-flapping entry: first flap time, latest flap time, and
 * flap count (all epoch seconds).
 *
 * @typedef {[number, number, number]} FlapEntry
 */

/**
 * Fast-flapping state, shared process-wide across every backbone listener
 * (matching the Python reference's class-level state).
 * @type {Map<string, FlapEntry>}
 */
const fastFlapping = new Map();

/**
 * Normalizes a peer address to the form the Python reference's
 * `socket.getpeername()[0]` reports: Node spells IPv4 peers as
 * IPv6-mapped (`::ffff:127.0.0.1`), Python as bare dotted quads.
 * @param {string} address
 * @returns {string}
 */
function normalizeRemoteAddress(address) {
  if (address.startsWith("::ffff:")) {
    const v4 = address.slice("::ffff:".length);
    if (v4.includes(".")) return v4;
  }
  return address;
}

/**
 * Returns a snapshot of the shared fast-flapping table (remote IP → flap
 * entry). Exposed for tests and observability.
 * @returns {ReadonlyMap<string, FlapEntry>}
 */
export function getFastFlappingState() {
  return fastFlapping;
}

/**
 * Clears the shared fast-flapping state. Exposed for tests; production code
 * relies on block expiry instead.
 */
export function resetFastFlappingState() {
  fastFlapping.clear();
}

/**
 * Records a fast flap for a remote IP, logging when the grace count is
 * exceeded (the reference does this in its teardown path).
 * @param {string} remoteIp
 * @param {number} fastFlapGrace
 * @returns {void}
 */
function recordFastFlap(remoteIp, fastFlapGrace) {
  const now = Date.now() / 1000;
  const entry = fastFlapping.get(remoteIp) ?? [now, now, 0];
  entry[1] = now;
  entry[2] += 1;
  fastFlapping.set(remoteIp, entry);
  if (entry[2] > fastFlapGrace) {
    log(
      "BackboneInterface",
      `Ignoring further connections from ${remoteIp} due to fast-flapping`,
      LogLevel.WARNING,
    );
  }
}

/**
 * Returns the JSON Schema properties for the fast-flapping options, for the
 * backbone listener schema to spread in.
 * @returns {Record<string, any>}
 */
function flapSchemaProperties() {
  return {
    blockFastFlapping: {
      type: "boolean",
      default: BLOCK_FAST_FLAPPING,
      description:
        "Protect the listener against fast-flapping connection sources: " +
        "remote IPs whose connections repeatedly live shorter than " +
        "fastFlappingThreshold are blocked for fastFlappingBlockTime.",
    },
    fastFlappingThreshold: {
      type: "number",
      minimum: 0,
      default: FAST_FLAP_THRESHOLD_SECS,
      examples: [20],
      description:
        "Connection lifetime in seconds under which a disconnect counts " +
        "as a fast flap.",
    },
    fastFlappingGrace: {
      type: "integer",
      minimum: 0,
      default: FAST_FLAP_GRACE,
      examples: [5],
      description: "Number of fast flaps after which the remote IP is blocked.",
    },
    fastFlappingBlockTime: {
      type: "number",
      minimum: 0,
      default: FAST_FLAP_EXPIRY_SECS / 60,
      examples: [720],
      description:
        "Minutes a fast-flapping block lasts before it expires " +
        "(12 hours by default).",
    },
  };
}

/**
 * @typedef {Object} BackboneInterfaceOptions
 * @property {string} [name]
 * @property {string} [listenIp] - Address to bind the listener to. Defaults
 *   to `"0.0.0.0"`; a `device` may be given instead.
 * @property {number} [listenPort] - TCP port to listen on (`port` is an
 *   alias, matching the Python reference config option). Port 0 requests an
 *   ephemeral port.
 * @property {number} [port] - Alias for `listenPort`.
 * @property {string} [device] - Kernel interface to derive the bind address
 *   from (an alternative to `listenIp`).
 * @property {boolean} [preferIpv6] - Prefer an IPv6 bind address when
 *   resolving `device`. Defaults to `false`.
 * @property {number} [ifacSize]
 * @property {string} [networkName] - Shared IFAC network name
 *   (`ifac_netname`).
 * @property {string} [passphrase] - Shared IFAC passphrase (`ifac_netkey`).
 * @property {boolean} [blockFastFlapping] - See {@link flapSchemaProperties}.
 * @property {number} [fastFlappingThreshold]
 * @property {number} [fastFlappingGrace]
 * @property {number} [fastFlappingBlockTime] - Minutes.
 */

/**
 * Reticulum interface that listens for inbound backbone TCP connections,
 * spawning a {@link BackboneClientInterface} per accepted connection.
 * Wire-compatible with the Python reference `BackboneInterface`.
 * @extends Interface
 */
export class BackboneInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link BackboneInterface} constructor.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "Backbone Interface",
      description:
        "High-performance TCP listener for backbone links between " +
        "transport nodes, with fast-flapping protection and MTU " +
        "autoconfiguration from a 1 Gbit/s nominal bitrate. " +
        "Wire-compatible with the Python reference BackboneInterface. " +
        "Unlike the Python reference (Linux-only due to its epoll " +
        "architecture), this interface works on any OS with TCP.",
      properties: {
        ...base.properties,
        listenIp: {
          type: "string",
          default: "0.0.0.0",
          examples: ["0.0.0.0", "127.0.0.1"],
          description:
            "Address to bind the listener to. Either this or device must " +
            "be set.",
        },
        listenPort: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          examples: [4242],
          description:
            "TCP port to listen on (port 0 requests an ephemeral port). " +
            "The standard rnsd port is 4242.",
        },
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          examples: [4242],
          description: "Alias for listenPort.",
        },
        device: {
          type: "string",
          description:
            "Kernel interface (e.g. eth0) to derive the bind address from, " +
            "as an alternative to listenIp.",
        },
        preferIpv6: {
          type: "boolean",
          default: false,
          description: "Prefer an IPv6 bind address when resolving device.",
        },
        ...flapSchemaProperties(),
      },
      required: ["listenPort"],
      additionalProperties: false,
    };
  }

  /**
   * Creates a backbone listener interface.
   * @param {BackboneInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.name = options.name || "backbone";
    /** @type {string} */
    this.bindIp = options.device
      ? this._addressForDevice(options.device, options.preferIpv6 === true)
      : (options.listenIp ?? "0.0.0.0");
    /** @type {number|null} */
    const requestedPort = options.listenPort ?? options.port ?? null;
    if (requestedPort === null) {
      throw new Error(
        `No TCP port configured for interface "${this.name}" (the Python reference raises SystemError)`,
      );
    }
    /** @type {number} */
    this.bindPort = requestedPort;
    this.ifacSize = options.ifacSize || 0;
    /** @type {string|null} */
    this.ifacNetname = options.networkName || null;
    /** @type {string|null} */
    this.ifacNetkey = options.passphrase || null;
    /** @type {boolean} */
    this.blockFastFlapping = options.blockFastFlapping ?? BLOCK_FAST_FLAPPING;
    /** @type {number} Seconds under which a disconnect counts as a flap. */
    this.fastFlapThreshold =
      options.fastFlappingThreshold ?? FAST_FLAP_THRESHOLD_SECS;
    /** @type {number} Flaps beyond this count block the remote IP. */
    this.fastFlapGrace = options.fastFlappingGrace ?? FAST_FLAP_GRACE;
    /** @type {number} Block expiry in seconds. */
    this.fastFlapExpiry =
      (options.fastFlappingBlockTime ?? FAST_FLAP_EXPIRY_SECS / 60) * 60;
    /**
     * Nominal backbone bitrate (1 Gbit/s), inherited by spawned client
     * interfaces, matching the Python reference.
     * @type {number}
     */
    this.bitrate = BACKBONE_BITRATE_GUESS;
    /** @type {any} */
    this.server = null;
    /** @type {Set<BackboneClientInterface>} */
    this.spawnedInterfaces = new Set();
    this.online = false;
    /**
     * Backbone interfaces participate in interface discovery (the Python
     * reference's `supports_discovery`).
     * @type {boolean}
     */
    this.supportsDiscovery = true;
    /**
     * Transport that owns this interface, set via {@link attachTransport}.
     * When present, spawned clients are auto-registered with it; otherwise
     * the caller registers them via the `"connection"` event.
     * @type {import("@reticulum/core/src/transport/transport.js").TransportCore | null}
     */
    this.transport = null;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.online;
  }

  /** @returns {any} */
  get readable() {
    throw new Error("BackboneInterface.readable is not implemented");
  }
  /** @returns {any} */
  get writable() {
    throw new Error("BackboneInterface.writable is not implemented");
  }

  /**
   * Number of currently connected client interfaces (the Python reference's
   * `clients` property).
   * @returns {number}
   */
  get clients() {
    return this.spawnedInterfaces.size;
  }

  /**
   * Remote IPs currently blocked for fast-flapping, with expired blocks
   * pruned (the Python reference's `blocked_ip_list`).
   * @returns {string[]}
   */
  get blockedIpList() {
    if (!this.blockFastFlapping) return [];
    this._pruneExpiredFlapBlocks();
    return Array.from(fastFlapping.entries())
      .filter(([, entry]) => entry[2] > this.fastFlapGrace)
      .map(([ip]) => ip);
  }

  /**
   * Number of remote IPs currently blocked for fast-flapping (the Python
   * reference's `blocked_ip_count`).
   * @returns {number}
   */
  get blockedIpCount() {
    return this.blockedIpList.length;
  }

  /**
   * Starts listening on the configured address/port for inbound backbone
   * connections. When port 0 was requested, `bindPort` is updated to the
   * ephemeral port the OS assigned.
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((/** @type {any} */ socket) => {
        this._incomingConnection(socket);
      });
      this.server.on("error", (/** @type {Error} */ err) => {
        this.online = false;
        reject(err);
      });
      this.server.listen(this.bindPort, this.bindIp, () => {
        const address = /** @type {import('node:net').AddressInfo} */ (
          this.server.address()
        );
        if (typeof address === "object") this.bindPort = address.port;
        this.online = true;
        log(
          "BackboneInterface",
          `Listening on ${this.bindIp}:${this.bindPort}`,
          LogLevel.DEBUG,
        );
        resolve();
      });
    });
  }

  /**
   * Closes the listening server and disconnects all spawned client
   * interfaces.
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    const disconnects = Array.from(this.spawnedInterfaces).map((client) =>
      client.disconnect(),
    );
    await Promise.all(disconnects);
    this.spawnedInterfaces.clear();
    this.online = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  /**
   * Applies the node-global ingress-control overrides to this interface and
   * every spawned client, matching the reference's spawned-interface
   * inheritance.
   * @param {Partial<import("@reticulum/core/src/interfaces/base.js").IngressControlConfig>} overrides
   */
  applyIngressConfig(overrides) {
    super.applyIngressConfig(overrides);
    for (const spawned of this.spawnedInterfaces) {
      spawned.applyIngressConfig(overrides);
    }
  }

  /**
   * Remember the owning transport so spawned client interfaces are
   * auto-registered with it (the Python reference registers spawned
   * interfaces with its global Transport at spawn time).
   * @param {import("@reticulum/core/src/transport/transport.js").TransportCore} transport
   */
  attachTransport(transport) {
    this.transport = transport;
    for (const spawned of this.spawnedInterfaces) {
      transport.addInterface(spawned);
    }
  }

  /**
   * Handles an accepted socket: rejects blocked fast-flappers, otherwise
   * spawns a {@link BackboneClientInterface} adopting the socket.
   * @param {any} socket
   * @private
   */
  _incomingConnection(socket) {
    // Node reports IPv4 peers as IPv6-mapped (`::ffff:127.0.0.1`); normalize
    // to the bare IPv4 form the Python reference's getpeername reports, so
    // blocklists and logs match.
    const remoteIp = normalizeRemoteAddress(
      /** @type {string} */ (socket.remoteAddress || ""),
    );
    if (this._isFlapBlocked(remoteIp)) {
      log(
        "BackboneInterface",
        `Ignoring incoming connection from fast-flapping IP ${remoteIp}`,
        LogLevel.PATHING,
      );
      socket.destroy();
      return;
    }
    log("BackboneInterface", "Accepting incoming connection", LogLevel.PATHING);
    try {
      const spawned = new BackboneClientInterface({
        socket,
        name: `backbone-client-on-${this.name}`,
        ifacSize: this.ifacSize,
        networkName: this.ifacNetname ?? undefined,
        passphrase: this.ifacNetkey ?? undefined,
      });
      spawned.parentInterface = this;
      spawned.host = remoteIp;
      spawned.port = socket.remotePort || 0;
      // Backbone inheritance, matching the Python reference's spawn site:
      // the parent's bitrate (hence MTU autoconfiguration) and ingress
      // settings flow to every spawned client.
      spawned.bitrate = this.bitrate;
      spawned.optimiseMtu();
      spawned.ingressControl = this.ingressControl;
      spawned.icMaxHeldAnnounces = this.icMaxHeldAnnounces;
      spawned.icBurstHold = this.icBurstHold;
      spawned.icBurstFreq = this.icBurstFreq;
      spawned.icBurstFreqNew = this.icBurstFreqNew;
      spawned.icNewTime = this.icNewTime;
      spawned.icBurstPenalty = this.icBurstPenalty;
      spawned.icHeldReleaseInterval = this.icHeldReleaseInterval;
      spawned.icPrBurstFreqNew = this.icPrBurstFreqNew;
      spawned.icPrBurstFreq = this.icPrBurstFreq;
      // Tell the spawned client how to record fast flaps on connection
      // loss.
      spawned._flapGuard = {
        enabled: this.blockFastFlapping,
        threshold: this.fastFlapThreshold,
        grace: this.fastFlapGrace,
      };
      /** Epoch seconds when the spawned interface connected. */
      spawned.spawnedAt = Date.now() / 1000;
      spawned
        .connect()
        .then(() => {
          this.spawnedInterfaces.add(spawned);
          if (this.transport) this.transport.addInterface(spawned);
          this.dispatchEvent(
            new CustomEvent("connection", { detail: spawned }),
          );
        })
        .catch((/** @type {any} */ e) => {
          log(
            "BackboneInterface",
            `Error while accepting incoming connection on ${this}: ${e.message}`,
            LogLevel.ERROR,
          );
          socket.destroy();
        });
    } catch (e) {
      log(
        "BackboneInterface",
        `Error while accepting incoming connection on ${this}: ${/** @type {any} */ (e).message}`,
        LogLevel.ERROR,
      );
      socket.destroy();
    }
  }

  /**
   * Whether a remote IP is currently blocked for fast-flapping.
   * @param {string} remoteIp
   * @returns {boolean}
   * @private
   */
  _isFlapBlocked(remoteIp) {
    if (!this.blockFastFlapping) return false;
    this._pruneExpiredFlapBlocks();
    const entry = fastFlapping.get(remoteIp);
    return entry !== undefined && entry[2] > this.fastFlapGrace;
  }

  /**
   * Removes fast-flapping entries whose block has expired (the reference
   * prunes them inside `blocked_ip_count`).
   * @private
   */
  _pruneExpiredFlapBlocks() {
    const now = Date.now() / 1000;
    for (const [remoteIp, entry] of fastFlapping) {
      if (now - entry[1] > this.fastFlapExpiry) {
        fastFlapping.delete(remoteIp);
        log(
          "BackboneInterface",
          `Fast-flapping block expired for ${remoteIp}`,
          LogLevel.DEBUG,
        );
      }
    }
  }

  /**
   * Resolves the bind address from a kernel interface name, preferring IPv6
   * when requested and available, matching the reference's
   * `get_address_for_if`.
   * @param {string} device
   * @param {boolean} preferIpv6
   * @returns {string}
   * @private
   */
  _addressForDevice(device, preferIpv6) {
    const addresses = listAddresses(device);
    const v6 = addresses[AF_INET6];
    const v4 = addresses[AF_INET];
    if ((preferIpv6 || !v4?.length) && v6?.length) {
      return v6[0].addr;
    }
    if (v4?.length) {
      return v4[0].addr;
    }
    throw new Error(
      `No addresses available on specified kernel interface "${device}" for BackboneInterface to bind to`,
    );
  }

  /**
   * @returns {string}
   */
  toString() {
    const ipStr = this.bindIp.includes(":") ? `[${this.bindIp}]` : this.bindIp;
    return `BackboneInterface[${this.name}/${ipStr}:${this.bindPort}]`;
  }
}

/**
 * @typedef {Object} BackboneClientInterfaceOptions
 * @property {string} [host] - Target host to connect to (initiator only).
 * @property {number} [port] - Target port to connect to (initiator only).
 * @property {any} [socket] - Existing socket to adopt (spawned by a
 *   {@link BackboneInterface}); never reconnects.
 * @property {number} [ifacSize]
 * @property {string} [networkName] - Shared IFAC network name
 *   (`ifac_netname`).
 * @property {string} [passphrase] - Shared IFAC passphrase (`ifac_netkey`).
 * @property {string} [name]
 * @property {boolean} [i2pTunneled] - Use the longer I2P keepalive
 *   interval. Defaults to `false`.
 * @property {boolean} [autoReconnect] - Reconnect after drops (initiator
 *   only). Defaults to `true`.
 * @property {number} [reconnectWait] - Seconds between attempts. Defaults
 *   to 5.
 * @property {number|null} [maxReconnectTries] - Attempt cap, or `null` for
 *   unlimited.
 * @property {number} [connectTimeout] - Per-dial timeout in seconds.
 *   Defaults to 5.
 * @property {boolean} [preferIpv6] - Prefer IPv6 when resolving the target
 *   host. Defaults to `false`.
 */

/**
 * Reticulum interface for a single backbone TCP connection: either the
 * initiator dialing a remote backbone listener, or a connection spawned by a
 * {@link BackboneInterface}. Wire-compatible with the Python reference
 * `BackboneClientInterface`.
 * @extends Interface
 */
export class BackboneClientInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link BackboneClientInterface} constructor (excluding the internal
   * `socket` adoption option).
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "Backbone Client Interface",
      description:
        "Connects to a remote backbone listener over TCP and " +
        "automatically reconnects (as the initiator) after a drop. " +
        "Wire-compatible with the Python reference BackboneClientInterface. " +
        "Unlike the Python reference (Linux-only due to its epoll " +
        "architecture), this interface works on any OS with TCP.",
      properties: {
        ...base.properties,
        host: {
          type: "string",
          description: "Target host to connect to.",
          examples: ["127.0.0.1", "reticulum.network"],
        },
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          default: 4242,
          examples: [4242],
          description:
            "Target TCP port to connect to. The standard rnsd port is " +
            "4242.",
        },
        i2pTunneled: {
          type: "boolean",
          default: false,
          description:
            "Use the longer I2P keepalive probe interval for connections " +
            "tunneled through I2P.",
        },
        preferIpv6: {
          type: "boolean",
          default: false,
          description: "Prefer an IPv6 address when resolving the target host.",
        },
        ...reconnectSchemaProperties(),
      },
      required: ["host", "port"],
      additionalProperties: false,
    };
  }

  /**
   * The underlying socket (if any).
   * @type {import('node:net').Socket | null}
   */
  socket = null;

  /**
   * Creates a backbone client interface.
   *
   * When `options.socket` is provided the interface adopts it (it is a
   * listener-spawned connection) and never reconnects. Otherwise it is the
   * initiator and reconnects after drops per the reconnect options.
   * @param {BackboneClientInterfaceOptions} options
   */
  constructor(options) {
    super();
    this._initReconnectState(options);
    this.name = options.name || `backbone-client-${options.host || ""}`;
    /** @type {string} Remote host (or the spawned connection's remote IP). */
    this.host = options.host || "";
    /** @type {number} */
    this.port = options.port || 0;
    this.ifacSize = options.ifacSize || 0;
    /** @type {string|null} */
    this.ifacNetname = options.networkName || null;
    /** @type {string|null} */
    this.ifacNetkey = options.passphrase || null;
    this.i2pTunneled = options.i2pTunneled === true;
    this.preferIpv6 = options.preferIpv6 === true;
    /**
     * Nominal bitrate guess for the initiator (100 Mbit/s, matching the
     * Python reference `BackboneClientInterface.BITRATE_GUESS`); overwritten
     * by the parent listener when spawned by a {@link BackboneInterface}.
     * @type {number}
     */
    this.bitrate = 100_000_000;
    this.autoconfigureMtu = true;
    this.hwMtu = BACKBONE_HW_MTU;
    this.optimiseMtu();
    /** @type {any} */
    this.socket = options.socket || null;
    this.initiator = !this.socket;
    /** @type {BackboneInterface | null} */
    this.parentInterface = null;
    /** @type {number} Epoch seconds when a listener spawned this client. */
    this.spawnedAt = 0;
    /**
     * Fast-flap recording parameters inherited from the spawning listener.
     * @type {{ enabled: boolean, threshold: number, grace: number } | null}
     */
    this._flapGuard = null;
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
    this.online = false;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.online;
  }

  /** @returns {any} */
  get readable() {
    return this._readable;
  }
  /** @returns {any} */
  get writable() {
    return this._writable;
  }

  /**
   * Establishes the backbone connection (or adopts the provided socket) and
   * starts the inbound loop. Behavior matches the TCP client: a failed first
   * dial rejects but keeps retrying in the background when auto-reconnect
   * is enabled.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.socket) {
      // Adopted (listener-spawned) socket: never reconnects.
      this.initiator = false;
      this._applySocketOptions(this.socket);
      this._setupStreams(this.socket);
      this.online = true;
      this._closed = false;
      this.dispatchEvent(
        new CustomEvent("connected", {
          detail: { host: this.host, port: this.port },
        }),
      );
      return;
    }
    this.initiator = true;
    try {
      await this._establishConnection();
    } catch (e) {
      if (this.autoReconnect && !this.detached) {
        this._runReconnectLoop();
      }
      throw e;
    }
  }

  /**
   * Dials the remote backbone listener (with the configured connect
   * timeout), applies TCP socket tuning, sets up the RNS streams, and
   * dispatches `connected`. Used both for the initial connection and for
   * each reconnect attempt.
   * @returns {Promise<void>} Resolves once connected; rejects on failure.
   * @protected
   */
  _establishConnection() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.host,
        port: this.port,
        family: this.preferIpv6 ? 6 : undefined,
      });
      let settled = false;
      const timeoutMs = Math.max(0, this.connectTimeout) * 1000;
      const timeoutHandle =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              socket.destroy();
              reject(
                new Error(
                  `Backbone connect to ${this.host}:${this.port} timed out after ${this.connectTimeout}s`,
                ),
              );
            }, timeoutMs)
          : null;
      socket.once("connect", () => {
        if (settled) return;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        settled = true;
        this._applySocketOptions(socket);
        this.socket = socket;
        this._setupStreams(socket);
        this.online = true;
        this._closed = false;
        this.dispatchEvent(
          new CustomEvent("connected", {
            detail: { host: this.host, port: this.port },
          }),
        );
        resolve();
      });
      socket.once("error", (/** @type {any} */ err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (settled) return;
        settled = true;
        this.online = false;
        reject(err);
      });
    });
  }

  /**
   * Applies the TCP socket tuning the Python reference applies on every
   * (re)connect: `TCP_NODELAY` and `SO_KEEPALIVE` with the initial probe
   * delay. See the module docstring for the keepalive-knob caveat.
   * @param {any} socket
   * @protected
   */
  _applySocketOptions(socket) {
    try {
      socket.setNoDelay(true);
    } catch (e) {
      log(
        "BackboneInterface",
        `Failed to set TCP_NODELAY: ${/** @type {any} */ (e).message}`,
        LogLevel.DEBUG,
      );
    }
    try {
      // The reference probes after 5 s at 2 s intervals up to 12 times;
      // Node only exposes the initial delay.
      socket.setKeepAlive(true, 5000);
    } catch (e) {
      log(
        "BackboneInterface",
        `Failed to set SO_KEEPALIVE: ${/** @type {any} */ (e).message}`,
        LogLevel.DEBUG,
      );
    }
  }

  /**
   * Tears down the socket, cancels any pending reconnect, and marks the
   * interface offline. Dispatches a terminal `disconnected` followed by
   * `closed`.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._cancelReconnect();
    this._destroySocket();
    if (this.parentInterface) {
      this.parentInterface.spawnedInterfaces.delete(this);
    }
    this.online = false;
    this.dispatchEvent(
      new CustomEvent("disconnected", {
        detail: { host: this.host, port: this.port },
      }),
    );
    this._dispatchClosed();
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * Destroys the socket and clears the stream handles.
   * @private
   */
  _destroySocket() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._readable = null;
    this._writable = null;
  }

  /**
   * Wraps the raw socket into RNS frame/unframe streams and starts the
   * inbound loop, with the backbone's twice-the-hardware-MTU frame bound
   * (the Python reference's `frame_buffer` cap).
   * @param {any} socket
   * @private
   */
  _setupStreams(socket) {
    // Streams are replaced on every reconnect; drop any stale writer so the
    // next `send()` (or the transport's `connected` listener) re-acquires
    // one bound to the fresh writable.
    this._packetWriter = null;
    const nodeReadable = Readable.from(socket);
    const nodeWritable = new Writable({
      /**
       * @param {Uint8Array} chunk
       * @param {string} encoding
       * @param {any} callback
       */
      write(chunk, encoding, callback) {
        socket.write(chunk, encoding, callback);
      },
    });
    const webReadable = /** @type {ReadableStream<Uint8Array>} */ (
      Readable.toWeb(nodeReadable)
    );
    const maxFrameSize = this.hwMtu ? this.hwMtu * 2 : BACKBONE_HW_MTU;
    this._readable = webReadable.pipeThrough(
      createHdlcUnframerStream(
        Packet,
        (raw) => this._openRaw(raw),
        maxFrameSize,
      ),
    );

    const framer = createHdlcFramerStream((raw) => this._sealRaw(raw));

    // Count every outbound packet at the single TX chokepoint, piped ahead
    // of the framer so it sees Packet objects.
    const txCounter = new TransformStream({
      transform: (
        /** @type {import("@reticulum/core/src/core/packet.js").Packet} */ packet,
        controller,
      ) => {
        this._recordOutbound(packet);
        controller.enqueue(packet);
      },
    });
    txCounter.readable
      .pipeTo(framer.writable)
      .catch((/** @type {any} */ err) => {
        log(
          "BackboneInterface",
          `TX counter pipeTo error: ${err}`,
          LogLevel.ERROR,
        );
      });
    framer.readable
      .pipeTo(Writable.toWeb(nodeWritable))
      .catch((/** @type {any} */ err) => {
        log("BackboneInterface", `Framer pipeTo error: ${err}`, LogLevel.ERROR);
      });
    this._writable = txCounter.writable;
    this._loopPromise = this._startInboundLoop();
  }

  /**
   * Starts the loop that reads from the inbound stream and dispatches
   * packets. On connection loss, records a fast flap when a listener-spawned
   * short-lived connection ends, then hands off to the shared connection-lost
   * handling (reconnect for the initiator, terminal `closed` otherwise).
   * @private
   */
  async _startInboundLoop() {
    const reader = this._readable.getReader();
    let lost = false;
    try {
      while (true) {
        const { value: packet, done } = await reader.read();
        if (done) {
          lost = true;
          break;
        }
        this._dispatchPacket(packet);
      }
    } catch (e) {
      lost = true;
      if (
        /** @type {any} */ (e).name !== "AbortError" &&
        /** @type {any} */ (e).code !== "ABORT_ERR"
      ) {
        this.dispatchEvent(
          new CustomEvent("error", { detail: /** @type {any} */ (e) }),
        );
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_e) {
        // already released
      }
      if (lost) {
        this._destroySocket();
        if (this.parentInterface) {
          this.parentInterface.spawnedInterfaces.delete(this);
        }
        this._maybeRecordFlap();
        this._handleConnectionLost();
      }
    }
  }

  /**
   * Records a fast flap when a listener-spawned connection that lived
   * shorter than the flap threshold is lost, matching the reference's
   * teardown path. Deliberate local disconnects do not count.
   * @private
   */
  _maybeRecordFlap() {
    const guard = this._flapGuard;
    if (!guard?.enabled || !this.parentInterface || !this.spawnedAt) return;
    const connectedTime = Date.now() / 1000 - this.spawnedAt;
    if (connectedTime >= guard.threshold) return;
    log(
      "BackboneInterface",
      `${this} is fast flapping, connection time was ${connectedTime.toFixed(2)}s`,
      LogLevel.DEBUG,
    );
    recordFastFlap(this.host, guard.grace);
  }

  /**
   * @returns {string}
   */
  toString() {
    const ipStr = this.host.includes(":") ? `[${this.host}]` : this.host;
    return `BackboneInterface[${this.name}/${ipStr}:${this.port}]`;
  }
}
