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
import {
  createKissFramerStream,
  createKissUnframerStream,
} from "@reticulum/core/src/transport/kiss-framer.js";
import { LogLevel, log } from "@reticulum/core/src/utils/log.js";

/**
 * Initial TCP keepalive probe delay, in milliseconds. Mirrors the Python
 * reference `TCP_PROBE_AFTER` (5s). Node only exposes the initial delay via
 * `setKeepAlive`; the finer-grained Linux `TCP_USER_TIMEOUT`/
 * `TCP_KEEPCNT`/`TCP_KEEPINTVL` knobs are not reachable from the standard API
 * (see work doc open question E).
 */
const TCP_PROBE_AFTER_MS = 5000;
/**
 * Longer initial keepalive probe delay for I2P-tunneled connections, in
 * milliseconds. Mirrors the Python reference `I2P_PROBE_AFTER` (10s).
 */
const I2P_PROBE_AFTER_MS = 10000;

/**
 * @typedef {Object} TCPClientInterfaceOptions
 * @property {string} [host]
 * @property {number} [port]
 * @property {any} [socket]
 * @property {number} [ifacSize]
 * @property {string} [name]
 * @property {"hdlc"|"kiss"} [framing] - Wire framing to use. Defaults to
 *   `"hdlc"` (Python reference default). `"kiss"` mirrors the Python
 *   `kiss_framing = yes` TCP option.
 * @property {boolean} [autoReconnect] - Reconnect after drops (initiator
 *   only). Defaults to `true`.
 * @property {number} [reconnectWait] - Seconds between attempts. Defaults to 5.
 * @property {number|null} [maxReconnectTries] - Attempt cap, or `null` for
 *   unlimited. Defaults to unlimited.
 * @property {number} [connectTimeout] - Per-dial timeout in seconds. Defaults
 *   to 5.
 * @property {boolean} [i2pTunneled] - Use the longer I2P keepalive values.
 *   Defaults to `false`.
 */

/**
 * @typedef {Object} TCPServerInterfaceOptions
 * @property {number} port
 * @property {number} [ifacSize]
 * @property {"hdlc"|"kiss"} [framing] - Wire framing for spawned client
 *   interfaces. Defaults to `"hdlc"`.
 * @property {string} [name]
 */

/**
 * Reticulum interface that connects to a remote node over a TCP socket.
 *
 * Wraps the Node.js `net.Socket` into RNS streams with HDLC or KISS framing.
 * Used both for outbound client connections and (via a server) for inbound ones.
 * @extends Interface
 */
export class TCPClientInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link TCPClientInterface} constructor (excluding the internal `socket`
   * adoption option). Drives dynamically-generated setup UIs.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "TCP Client Interface",
      description:
        "Connects to a remote Reticulum node over a TCP socket and " +
        "automatically reconnects (as the initiator) after a drop. " +
        "Mirrors the Python reference TCPClientInterface.",
      properties: {
        ...base.properties,
        host: {
          type: "string",
          description:
            "Target host to connect to (Python config key: target_host).",
          examples: ["127.0.0.1", "reticulum.network"],
        },
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          default: 4242,
          examples: [4242],
          description:
            "Target TCP port to connect to (Python config key: " +
            "target_port). The standard rnsd port is 4242.",
        },
        i2pTunneled: {
          type: "boolean",
          default: false,
          description:
            "Use the longer I2P keepalive probe interval for connections " +
            "tunneled through I2P (Python config key: i2p_tunneled).",
        },
        framing: {
          type: "string",
          enum: ["hdlc", "kiss"],
          default: "hdlc",
          description:
            "Wire framing to use on the socket (Python config key: " +
            "kiss_framing). Defaults to hdlc; set to kiss to match a " +
            "Python peer configured with kiss_framing = yes.",
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
   * Creates a TCP client interface.
   *
   * When `options.socket` is provided the interface adopts it (it is an
   * inbound/server-spawned connection) and never reconnects. Otherwise it is
   * the initiator and reconnects after drops per the reconnect options.
   * @param {TCPClientInterfaceOptions} options
   */
  constructor(options) {
    super();
    this._initReconnectState(options);
    this.name =
      options.name || `tcp-client-${options.host || ""}:${options.port || ""}`;
    this.host = options.host || "";
    this.port = options.port || 0;
    this.ifacSize = options.ifacSize || 0;
    /**
     * Nominal bitrate. Matches `TCPClientInterface.BITRATE_GUESS`
     * (10 Mbit/s) in the Python reference; overwritten by the parent server
     * when spawned by a {@link TCPServerInterface}.
     * @type {number}
     */
    this.bitrate = 10000000;
    this.i2pTunneled = options.i2pTunneled === true;
    /** @type {"hdlc"|"kiss"} */
    this.framing = options.framing === "kiss" ? "kiss" : "hdlc";
    /** @type {any} */
    this.socket = options.socket || null;
    // Only the initiator (the outbound dialer) reconnects. An adopted socket
    // is a server-spawned connection and tears down on close instead.
    this.initiator = !this.socket;
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    this.online = false;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
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
   * Establishes the TCP connection (or adopts the provided socket) and starts
   * the inbound loop.
   *
   * For an initiator whose first dial fails with auto-reconnect enabled, the
   * promise rejects (so the caller knows the first attempt failed) but the
   * reconnect loop keeps retrying in the background. Mirrors the Python
   * reference `initial_connect`, which spawns a background reconnect thread on
   * the first failure.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.socket) {
      // Adopted (server-spawned) socket: never reconnects.
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
   * Dials the remote host (with the configured connect timeout), applies TCP
   * keepalive tuning, sets up the RNS streams, and dispatches `connected`.
   *
   * Used both for the initial connection and for each reconnect attempt.
   * @returns {Promise<void>} Resolves once connected; rejects on failure.
   * @protected
   */
  _establishConnection() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.host,
        port: this.port,
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
                  `TCP connect to ${this.host}:${this.port} timed out after ${this.connectTimeout}s`,
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
   * (re)connect: `TCP_NODELAY` and `SO_KEEPALIVE` with the platform-appropriate
   * initial probe delay. Node does not expose the granular Linux
   * `TCP_USER_TIMEOUT`/`TCP_KEEPCNT`/`TCP_KEEPINTVL` knobs, so this is
   * `setKeepAlive`-only parity.
   * @param {any} socket
   * @protected
   */
  _applySocketOptions(socket) {
    try {
      socket.setNoDelay(true);
    } catch (e) {
      log(
        "TCP",
        `Failed to set TCP_NODELAY: ${/** @type {any} */ (e).message}`,
        LogLevel.DEBUG,
      );
    }
    try {
      const probeAfter = this.i2pTunneled
        ? I2P_PROBE_AFTER_MS
        : TCP_PROBE_AFTER_MS;
      socket.setKeepAlive(true, probeAfter);
    } catch (e) {
      log(
        "TCP",
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
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
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
   * Wraps the raw socket into RNS frame/unframe streams and starts the
   * inbound loop.
   * @param {any} socket
   * @private
   */
  _setupStreams(socket) {
    // Streams are replaced on every reconnect; drop any stale writer so the
    // next `send()` re-acquires one bound to the fresh writable.
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
    this._readable = webReadable.pipeThrough(
      this.framing === "kiss"
        ? createKissUnframerStream(Packet, this.ifacSize)
        : createHdlcUnframerStream(Packet, this.ifacSize),
    );

    const framer =
      this.framing === "kiss"
        ? createKissFramerStream()
        : createHdlcFramerStream();

    framer.readable
      .pipeTo(Writable.toWeb(nodeWritable))
      .catch((/** @type {any} */ err) => {
        log("TCP", `Framer pipeTo error: ${err}`, LogLevel.ERROR);
      });
    this._writable = framer.writable;
    this._loopPromise = this._startInboundLoop();
  }

  /**
   * Starts the loop that reads from the inbound stream and dispatches packets.
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
        this.dispatchEvent(new CustomEvent("packet", { detail: { packet } }));
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
        this._handleConnectionLost();
      }
    }
  }
}

/**
 * Reticulum interface that listens for inbound TCP connections.
 *
 * Each accepted connection is exposed as a spawned {@link TCPClientInterface}
 * via the `connection` event.
 * @extends Interface
 */
export class TCPServerInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link TCPServerInterface} constructor.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "TCP Server Interface",
      description:
        "Listens for inbound TCP connections and spawns a client interface " +
        "per accepted connection. Mirrors the Python reference " +
        "TCPServerInterface.",
      properties: {
        ...base.properties,
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          default: 4242,
          examples: [4242],
          description:
            "TCP port to listen on (Python config key: port / " +
            "listen_port). The standard rnsd port is 4242.",
        },
        listenIp: {
          type: "string",
          default: "0.0.0.0",
          examples: ["0.0.0.0", "127.0.0.1"],
          description:
            "Address to bind the listener to (Python config key: listen_ip).",
        },
        framing: {
          type: "string",
          enum: ["hdlc", "kiss"],
          default: "hdlc",
          description:
            "Wire framing for spawned client interfaces (Python config " +
            "key: kiss_framing). Defaults to hdlc.",
        },
      },
      required: ["port"],
      additionalProperties: false,
    };
  }

  /**
   * Creates a TCP server interface.
   * @param {TCPServerInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.name = options.name || `tcp-server-${options.port}`;
    this.port = options.port;
    this.ifacSize = options.ifacSize || 0;
    /** @type {"hdlc"|"kiss"} */
    this.framing = options.framing === "kiss" ? "kiss" : "hdlc";
    /**
     * Nominal bitrate, inherited by spawned client interfaces. Matches
     * `TCPServerInterface.BITRATE_GUESS` (10 Mbit/s) in the Python reference.
     * @type {number}
     */
    this.bitrate = 10000000;
    /** @type {any} */
    this.server = null;
    /** @type {Set<TCPClientInterface>} */
    this.spawnedInterfaces = new Set();
    this.online = false;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.online;
  }

  /** @returns {any} */
  get readable() {
    throw new Error("TCPServerInterface.readable is not implemented");
  }
  /** @returns {any} */
  get writable() {
    throw new Error("TCPServerInterface.writable is not implemented");
  }

  /**
   * Starts listening on the configured port for inbound connections.
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(async (/** @type {any} */ socket) => {
        const client = new TCPClientInterface({
          socket,
          ifacSize: this.ifacSize,
          framing: this.framing,
          name: `tcp-client-from-server-${socket.remoteAddress}:${socket.remotePort}`,
        });
        // Inherit the server's nominal bitrate (Python spawned-interface parity).
        client.bitrate = this.bitrate;
        await client.connect();
        this.spawnedInterfaces.add(client);
        this.dispatchEvent(new CustomEvent("connection", { detail: client }));
      });
      this.server.listen(this.port, () => {
        this.online = true;
        resolve();
      });
      this.server.on("error", (/** @type {Error} */ err) => {
        this.online = false;
        reject(err);
      });
    });
  }

  /**
   * Closes the listening server and disconnects all spawned client interfaces.
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.server) {
      this.server.close();
    }
    const disconnects = Array.from(this.spawnedInterfaces).map((client) =>
      client.disconnect(),
    );
    await Promise.all(disconnects);
    this.spawnedInterfaces.clear();
    this.online = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }
}
