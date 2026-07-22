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
 *
 * This module also hosts the shared-instance **endpoint discovery** helpers
 * (parsing the Python `~/.reticulum/config` to resolve the loopback
 * host/port/socket). They live here rather than under `core/` so the Node.js
 * builtins they need (`node:fs`/`node:os`/`node:path`) stay out of the
 * browser-safe main entry — the discovery is meaningless without a local
 * socket to connect to anyway.
 */
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { Packet } from "../core/packet.js";
import {
  createHdlcFramerStream,
  createHdlcUnframerStream,
} from "../transport/hdlc-framer.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface, reconnectSchemaProperties } from "./base.js";

/**
 * Resolves the Reticulum configuration directory, mirroring
 * `RNS.Reticulum.__init__` configdir resolution: explicit argument, then
 * `/etc/reticulum` (if present), then `~/.config/reticulum` (if present), then
 * `~/.reticulum` as the final fallback.
 *
 * Unlike the Python reference we do not create the directory if it is missing;
 * discovery callers treat a missing config file as "no shared instance
 * configured".
 * @param {string} [explicit] Optional explicit config directory path.
 * @returns {string}
 */
export function resolveConfigDir(explicit) {
  if (explicit) return explicit;
  const home = homedir();
  if (existsSync("/etc/reticulum") && existsSync("/etc/reticulum/config")) {
    return "/etc/reticulum";
  }
  const xdg = join(home, ".config", "reticulum");
  if (existsSync(xdg) && existsSync(join(xdg, "config"))) {
    return xdg;
  }
  return join(home, ".reticulum");
}

/**
 * Coerces a configobj string value to a boolean, matching
 * `configobj.Section.as_bool`: `True/On/Yes/1` (case-insensitive) → `true`,
 * `False/Off/No/0` → `false`. Anything else throws (configobj raises
 * `ValueError`); we throw to surface malformed configs loudly.
 * @param {string} value
 * @returns {boolean}
 */
export function asBool(value) {
  const v = String(value).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(v)) return true;
  if (["false", "off", "no", "0"].includes(v)) return false;
  throw new Error(`Value "${value}" is neither True nor False`);
}

/**
 * Coerces a configobj string value to an integer, matching
 * `configobj.Section.as_int` (Python `int(value, 10)`).
 * @param {string} value
 * @returns {number}
 */
export function asInt(value) {
  return Number.parseInt(String(value).trim(), 10);
}

/**
 * Parses a Reticulum config file (configobj/INI format) into a nested object.
 *
 * Section headers set the nesting depth by bracket count (`[a]` depth 1,
 * `[[b]]` depth 2 nested under the current depth-1 section). `key = value`
 * pairs populate the current section. Values are kept as strings; use the
 * `as*` coercion helpers when consuming. Lines whose first non-whitespace
 * character is `#` or `;` are comments.
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseConfigFile(text) {
  /** @type {Record<string, any>} */
  const root = {};
  /** @type {{ obj: Record<string, any> }[]} */
  const stack = [];
  let current = root;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^(\[+)(.*?)\]+$/);
    if (sectionMatch) {
      const depth = sectionMatch[1].length;
      const name = sectionMatch[2].trim();
      // Pop back to the parent of this depth (depth N nests under depth N-1).
      while (stack.length >= depth) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].obj : root;
      if (typeof parent[name] !== "object" || parent[name] === null) {
        parent[name] = {};
      }
      stack.push({ obj: parent[name] });
      current = parent[name];
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    current[key] = value;
  }

  return root;
}

/**
 * Reads and parses the Reticulum config from the given (or resolved) directory.
 * Returns `null` if no config file is present.
 * @param {{ configDir?: string }} [options]
 * @returns {{ configDir: string, config: Record<string, any> } | null}
 */
export function loadConfig(options = {}) {
  const configDir = resolveConfigDir(options.configDir);
  const configPath = join(configDir, "config");
  if (!existsSync(configPath)) return null;
  const config = parseConfigFile(readFileSync(configPath, "utf8"));
  return { configDir, config };
}

/**
 * The default shared-instance TCP port, matching the Python reference
 * `RNS.Reticulum.local_interface_port` default of `37428`.
 */
export const DEFAULT_SHARED_INSTANCE_PORT = 37428;

/**
 * The default AF_UNIX abstract-socket prefix used by the Python reference
 * (`\0rns/<instance_name>`). Linux-only; the leading NUL selects the abstract
 * namespace.
 */
export const AF_UNIX_PREFIX = "\0rns/";

/**
 * @typedef {Object} SharedInstanceEndpoint
 * @property {string} configDir - The config directory this was resolved from.
 * @property {boolean} shareInstance - Whether `share_instance` is enabled.
 * @property {("tcp"|"unix")} transport - Resolved loopback transport.
 * @property {string} [host] - TCP bind host (`"127.0.0.1"`) when `tcp`.
 * @property {number} [port] - TCP port when `tcp`.
 * @property {string} [socketPath] - AF_UNIX path when `unix`.
 * @property {string} instanceName - Configured instance name (`"default"`).
 */

/**
 * Whether this platform supports the abstract AF_UNIX namespace Python uses for
 * shared-instance sockets. Abstract namespace is a Linux kernel feature.
 * @returns {boolean}
 */
export function supportsAbstractAfUnix() {
  return process.platform === "linux" || process.platform === "android";
}

/**
 * Resolves how to reach the local shared instance, mirroring the Python
 * reference `__start_local_interface` / `__apply_config` transport resolution.
 *
 * Defaults (`share_instance = Yes`, port `37428`) match the Python reference
 * constructor defaults; config values override them. On platforms without the
 * abstract AF_UNIX namespace (macOS, Windows) the transport is always `tcp`
 * regardless of `shared_instance_type`, exactly as Python forces it.
 * @param {{ configDir?: string }} [options]
 * @returns {SharedInstanceEndpoint}
 */
export function getSharedInstanceEndpoint(options = {}) {
  const loaded = loadConfig(options);
  const configDir = loaded
    ? loaded.configDir
    : resolveConfigDir(options.configDir);
  const r = loaded?.config?.reticulum || {};

  const shareInstance =
    r.share_instance !== undefined ? asBool(r.share_instance) : true;
  const port =
    r.shared_instance_port !== undefined
      ? asInt(r.shared_instance_port)
      : DEFAULT_SHARED_INSTANCE_PORT;
  const instanceName =
    r.instance_name !== undefined ? String(r.instance_name).trim() : "default";
  const configuredType =
    r.shared_instance_type !== undefined
      ? String(r.shared_instance_type).trim().toLowerCase()
      : undefined;

  // Transport resolution mirrors Python: abstract AF_UNIX is only available on
  // Linux/Android; an explicit `shared_instance_type = tcp` forces TCP even
  // there; everywhere else (incl. macOS/Windows) it's TCP.
  /** @type {("tcp" | "unix")} */
  let transport = "tcp";
  if (supportsAbstractAfUnix() && configuredType !== "tcp") {
    transport = "unix";
  }

  /** @type {SharedInstanceEndpoint} */
  const endpoint = {
    configDir,
    shareInstance,
    transport,
    instanceName,
  };
  if (transport === "tcp") {
    endpoint.host = "127.0.0.1";
    endpoint.port = port;
  } else {
    endpoint.socketPath = `${AF_UNIX_PREFIX}${instanceName}`;
  }
  return endpoint;
}

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
   * Static async factory: discovers the local shared-instance endpoint (from
   * the Python `~/.reticulum/config` unless pinned by `options`), connects a
   * {@link LocalClientInterface} to it, and returns the connected interface —
   * or `null` if `share_instance` is disabled in the config or the endpoint is
   * not currently reachable.
   *
   * Mirrors the client side of the Python reference
   * `Reticulum.__start_local_interface`. This is a factory only: it discovers
   * and connects, but does **not** attach the interface to any transport —
   * the caller wires it, e.g. `rns.addInterface(iface, true)`.
   *
   * On a first-dial failure the background reconnect loop is cancelled (via
   * `disconnect()`) so nothing leaks and the caller can cleanly fall back to
   * a standalone interface.
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
  static async connectToSharedInstance(options = {}) {
    let { host, port, socketPath } = options;

    // Discovery is all-or-nothing: if the caller did not pin an endpoint, look
    // it up from the Python config.
    if (socketPath === undefined && port === undefined) {
      const endpoint = getSharedInstanceEndpoint({
        configDir: options.configDir,
      });
      if (!endpoint.shareInstance) {
        log(
          "LocalClient",
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
        "LocalClient",
        `Shared instance not reachable: ${/** @type {any} */ (e).message}`,
        LogLevel.WARNING,
      );
      return null;
    }

    log("LocalClient", `[+] Connected to shared instance via ${iface.name}`);
    return iface;
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
    /**
     * Nominal bitrate. Matches `RNS.Interfaces.LocalInterface` (1 Gbit/s) in
     * the Python reference — the shared-instance Unix/TCP socket is a
     * very-high-bandwidth local hop.
     * @type {number}
     */
    this.bitrate = 1000000000;
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
    const webReadable = /** @type {ReadableStream<Uint8Array>} */ (
      Readable.toWeb(nodeReadable)
    );
    this._readable = webReadable.pipeThrough(
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
