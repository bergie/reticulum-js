/**
 * @file local_client.js
 * @description Shared-instance local client interface.
 *
 * Connects a local Reticulum program to a running shared instance (daemon) —
 * either a Python `rnsd` or our own `LocalServerInterface` — over a fast
 * loopback socket. Mirrors the Python reference `RNS.Interfaces.LocalInterface.
 * LocalClientInterface`.
 *
 * The shared-instance socket carries standard HDLC-framed RNS packets (FLAG
 * `0x7E` / ESC `0x7D`), byte-for-byte identical to TCP/RNode interfaces — there
 * is no special wire protocol, so this interface reuses the same framer streams
 * as `TCPClientInterface`. The daemon handles all inter-client forwarding; the
 * client just sends and receives packets like any interface.
 *
 * Transport: TCP to `127.0.0.1:<port>` by default (the universal, portable
 * mode that also matches Python on macOS/Windows), with an optional Unix domain
 * socket / Windows named pipe via `socketPath` for parity with Python's
 * `instance_name`-based abstract AF_UNIX sockets on Linux.
 */
import net from "node:net";
import { Readable, Writable } from "node:stream";
import { Packet } from "../core/packet.js";
import {
  createHdlcFramerStream,
  createHdlcUnframerStream,
} from "../transport/hdlc-framer.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface, reconnectSchemaProperties } from "./base.js";

/**
 * Reconnect backoff for a shared-instance client, matching the Python reference
 * `LocalClientInterface.RECONNECT_WAIT` (8s).
 */
const RECONNECT_WAIT_SECONDS = 8;

/**
 * Initial keepalive probe delay, in milliseconds. Mirrors the Python reference
 * `TCP_PROBE_AFTER` (5s) applied to the shared-instance TCP socket.
 */
const PROBE_AFTER_MS = 5000;

/**
 * @typedef {Object} LocalClientInterfaceOptions
 * @property {number} [port] - TCP port of the shared instance (default 37428).
 * @property {string} [host] - TCP host (default `127.0.0.1`).
 * @property {string} [socketPath] - Unix domain socket / named pipe path. When
 *   set, the interface connects over UDS instead of TCP.
 * @property {any} [socket] - An already-connected socket to adopt (used by
 *   {@link import("./local_server.js").LocalServerInterface} when it spawns one
 *   per accepted connection). An adopted socket never reconnects.
 * @property {number} [ifacSize] - Optional IFAC size in bytes. Defaults to 0.
 * @property {string} [name] - Human-readable interface name.
 * @property {boolean} [autoReconnect] - Reconnect after drops (initiator only).
 *   Defaults to `true`.
 * @property {number} [reconnectWait] - Seconds between attempts. Defaults to 8.
 * @property {number|null} [maxReconnectTries] - Attempt cap, or `null` for
 *   unlimited. Defaults to unlimited.
 * @property {number} [connectTimeout] - Per-dial timeout in seconds. Defaults
 *   to 5.
 */

/**
 * Client interface for a local shared Reticulum instance.
 *
 * When constructed without a `socket` it is the initiator (an outbound dialer
 * to the shared instance): it sets {@link LocalClientInterface#isConnectedToSharedInstance}
 * and auto-reconnects after drops. When constructed with an adopted `socket`
 * (a server-spawned connection on the daemon side) it never reconnects and is
 * flagged as a local client of the owning server.
 * @extends Interface
 */
export class LocalClientInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link LocalClientInterface} constructor (excluding the internal `socket`
   * adoption option). Drives dynamically-generated setup UIs.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "Local Shared Instance Client",
      description:
        "Connects to a locally running shared Reticulum instance (e.g. rnsd) " +
        "over a loopback socket and shares its interfaces. Mirrors the Python " +
        "reference LocalClientInterface.",
      properties: {
        ...base.properties,
        host: {
          type: "string",
          default: "127.0.0.1",
          description:
            "Shared instance TCP host (Python config key: implicit 127.0.0.1).",
        },
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          default: 37428,
          examples: [37428, 4242],
          description:
            "Shared instance TCP port (Python config key: " +
            "shared_instance_port; defaults to 37428).",
        },
        socketPath: {
          type: "string",
          description:
            "Optional Unix domain socket / named pipe path. When set, the " +
            "interface connects over UDS instead of TCP (Python AF_UNIX " +
            "abstract socket on Linux).",
        },
        ...reconnectSchemaProperties(),
      },
      required: [],
      additionalProperties: false,
    };
  }

  /**
   * The underlying socket (if any).
   * @type {import('node:net').Socket | null}
   */
  socket = null;

  /**
   * `true` when this interface is the initiator that connected out to a shared
   * instance (i.e. this program is *using* a daemon, not being one). Mirrors
   * the Python reference `LocalClientInterface.is_connected_to_shared_instance`.
   * @type {boolean}
   */
  isConnectedToSharedInstance = false;

  /**
   * `true` when this interface was spawned by a {@link
   * import("./local_server.js").LocalServerInterface} to wrap an accepted
   * connection (i.e. this program *is* the daemon). Set by the server.
   * @type {boolean}
   */
  isLocalClient = false;

  /**
   * Creates a local shared-instance client interface.
   *
   * Without `options.socket` it is the initiator and reconnects after drops.
   * With an adopted `options.socket` (server-spawned) it never reconnects.
   * @param {LocalClientInterfaceOptions} options
   */
  constructor(options = {}) {
    super();
    this._initReconnectState({
      reconnectWait: RECONNECT_WAIT_SECONDS,
      ...options,
    });
    this.name =
      options.name ||
      (options.socketPath
        ? `local-client-${options.socketPath.replace("\0", "")}`
        : `local-client-${options.host || "127.0.0.1"}:${options.port || ""}`);
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 0;
    this.socketPath = options.socketPath || null;
    this.ifacSize = options.ifacSize || 0;
    /** @type {any} */
    this.socket = options.socket || null;
    // Only the initiator (the outbound dialer) reconnects. An adopted socket is
    // a server-spawned connection and tears down on close instead.
    this.initiator = !this.socket;
    // The initiator is the program that connected out to a shared instance.
    this.isConnectedToSharedInstance = this.initiator;
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
   * Establishes the loopback connection (or adopts the provided socket) and
   * starts the inbound loop.
   *
   * For an initiator whose first dial fails with auto-reconnect enabled, the
   * promise rejects (so the caller knows) but the reconnect loop keeps retrying
   * in the background — matching the Python reference `LocalClientInterface`
   * behaviour.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.socket) {
      this.initiator = false;
      this.isConnectedToSharedInstance = false;
      this._applySocketOptions(this.socket);
      this._setupStreams(this.socket);
      this.online = true;
      this._closed = false;
      this.dispatchEvent(new CustomEvent("connected", this._connectDetail()));
      return;
    }
    this.initiator = true;
    this.isConnectedToSharedInstance = true;
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
   * @returns {{ detail: { host?: string, port?: number, socketPath?: string } }}
   * @private
   */
  _connectDetail() {
    return this.socketPath
      ? { detail: { socketPath: this.socketPath } }
      : { detail: { host: this.host, port: this.port } };
  }

  /**
   * Dials the shared instance (TCP or UDS, with the configured connect
   * timeout), applies keepalive tuning, sets up the RNS streams, and dispatches
   * `connected`. Used both for the initial connection and each reconnect.
   * @returns {Promise<void>} Resolves once connected; rejects on failure.
   * @protected
   */
  async _establishConnection() {
    return new Promise((resolve, reject) => {
      const dialOptions = this.socketPath
        ? { path: this.socketPath }
        : { host: this.host, port: this.port };
      const socket = net.createConnection(dialOptions);
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
                  this.socketPath
                    ? `Local socket connect to ${this.socketPath} timed out after ${this.connectTimeout}s`
                    : `Local socket connect to ${this.host}:${this.port} timed out after ${this.connectTimeout}s`,
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
        this.dispatchEvent(new CustomEvent("connected", this._connectDetail()));
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
   * Applies socket tuning the Python reference applies to the shared-instance
   * socket: `TCP_NODELAY` and `SO_KEEPALIVE` so a dead daemon is detected and
   * reconnect can trigger. No-op for UDS (these options are TCP-only).
   * @param {any} socket
   * @protected
   */
  _applySocketOptions(socket) {
    if (this.socketPath) return; // UDS: TCP options do not apply.
    try {
      socket.setNoDelay(true);
    } catch (e) {
      log(
        "LocalClient",
        `Failed to set TCP_NODELAY: ${/** @type {any} */ (e).message}`,
        LogLevel.DEBUG,
      );
    }
    try {
      socket.setKeepAlive(true, PROBE_AFTER_MS);
    } catch (e) {
      log(
        "LocalClient",
        `Failed to set SO_KEEPALIVE: ${/** @type {any} */ (e).message}`,
        LogLevel.DEBUG,
      );
    }
  }

  /**
   * Tears down the socket, cancels any pending reconnect, and marks the
   * interface offline.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._cancelReconnect();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.online = false;
    this.isConnectedToSharedInstance = false;
    this.dispatchEvent(new CustomEvent("disconnected", this._connectDetail()));
    this._dispatchClosed();
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * Wraps the raw socket into RNS frame/unframe streams and starts the inbound
   * loop.
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
    this._readable = Readable.toWeb(nodeReadable).pipeThrough(
      createHdlcUnframerStream(Packet, this.ifacSize),
    );

    const framer = createHdlcFramerStream();

    framer.readable
      .pipeTo(Writable.toWeb(nodeWritable))
      .catch((/** @type {any} */ err) => {
        log("LocalClient", `Framer pipeTo error: ${err}`, LogLevel.ERROR);
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
