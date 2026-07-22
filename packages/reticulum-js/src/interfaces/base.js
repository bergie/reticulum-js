/**
 * @file base.js
 * @description Interface abstract base class
 */
import { LogLevel, log } from "../utils/log.js";

/**
 * @typedef {CustomEvent<Error>} ErrorEvent
 */

/**
 * @typedef {CustomEvent<{packet: import("../core/packet.js").Packet}>} PacketEvent
 */

/**
 * @typedef {Object} ReconnectingEventDetail
 * @property {number} attempt - The upcoming attempt number (1-based).
 * @property {number} waitSeconds - Seconds waited before this attempt.
 * @property {number} maxTries - The configured attempt cap (`Infinity` for
 *   unlimited).
 */

/**
 * @typedef {CustomEvent<ReconnectingEventDetail>} ReconnectingEvent
 */

/**
 * Reconnect defaults mirroring the Python reference client interfaces
 * (`RECONNECT_WAIT`, `RECONNECT_MAX_TRIES`, `INITIAL_CONNECT_TIMEOUT`).
 */
const RECONNECT_DEFAULTS = {
  autoReconnect: true,
  reconnectWait: 5,
  maxReconnectTries: Number.POSITIVE_INFINITY,
  connectTimeout: 5,
};

/**
 * Shared reconnect options accepted by client interfaces.
 * @typedef {Object} ReconnectOptions
 * @property {boolean} [autoReconnect]
 * @property {number} [reconnectWait]
 * @property {number|null} [maxReconnectTries]
 * @property {number} [connectTimeout]
 */

/**
 * Returns the JSON Schema properties for the shared reconnect options, for
 * client interface schemas to spread in. Mirrors the Python reference config
 * keys (`kiss_framing` and the rest live per-interface).
 * @returns {Record<string, any>}
 */
function reconnectSchemaProperties() {
  return {
    autoReconnect: {
      type: "boolean",
      default: true,
      description:
        "Whether the initiator (outbound dialer) automatically reconnects " +
        "after the connection drops, with a fixed backoff. When false, " +
        "behaviour is one-shot: a drop is terminal (Python config key: " +
        "implicit; only the initiator reconnects).",
    },
    reconnectWait: {
      type: "number",
      minimum: 0,
      default: 5,
      examples: [5],
      description:
        "Seconds to wait between reconnection attempts (Python config key: " +
        "RECONNECT_WAIT).",
    },
    maxReconnectTries: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      description:
        "Maximum reconnection attempts per drop before giving up and firing " +
        "a terminal `closed` event. Omit (or null) to retry forever (Python " +
        "config key: max_reconnect_tries; RECONNECT_MAX_TRIES defaults to " +
        "None).",
    },
    connectTimeout: {
      type: "number",
      minimum: 0,
      default: 5,
      examples: [5],
      description:
        "Per-dial connect timeout in seconds (Python config key: " +
        "connect_timeout; INITIAL_CONNECT_TIMEOUT).",
    },
  };
}

/**
 * Abstract base class for all RNS interfaces.
 * @extends EventTarget
 */
export class Interface extends EventTarget {
  /**
   * Returns a JSON Schema (draft-07) describing the options accepted by this
   * interface's constructor, for dynamically-generated setup UIs.
   *
   * The base schema declares the options common to every interface (`name`,
   * `ifacSize`). Subclasses extend it with their own options via
   * `super.getConfigurationSchema()` + spread, and intentionally omit
   * internal-only options (e.g. an adopted socket).
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Human-readable interface name. Every interface in a node " +
            "should have a unique name so multiple interfaces of the same " +
            "type (e.g. two TCP clients) can be told apart. A descriptive " +
            "name is generated if omitted.",
          examples: ["tcp-client-1", "lora-node"],
        },
        ifacSize: {
          type: "integer",
          minimum: 0,
          default: 0,
          examples: [16],
          description:
            "Optional interface authentication code (IFAC) size in bytes. " +
            "0 disables IFAC.",
        },
      },
      required: [],
    };
  }

  /**
   * The underlying socket, when this interface is backed by a Node.js stream.
   * @type {import('node:net').Socket | null}
   */
  socket = null;
  /**
   * @type {import('node:stream/web').WritableStreamDefaultWriter | null}
   */
  _packetWriter = null;

  /**
   * The name of the interface.
   * @type {string}
   */
  name = "unknown";

  /**
   * Whether this interface is the initiator (the outbound dialer). Only
   * initiators reconnect; adopted/server-spawned sockets never do (matching
   * the Python reference `initiator` flag).
   * @type {boolean}
   */
  initiator = false;

  /**
   * Whether the interface is currently open/online.
   * @type {boolean}
   */
  online = false;

  /**
   * Nominal physical bitrate of this interface in bits per second
   * (`self.bitrate` on `RNS.Interfaces.Interface` in the Python reference,
   * default 62500). Each interface overrides this with its medium's rate.
   *
   * Used by `TransportCore.prioritizeInterfaces()` to order the interface set
   * highest-bitrate-first (mirrors the Python reference's
   * `Transport.prioritize_interfaces`); the per-bitrate link-timeout and
   * announce-rate-limit behaviours that also build on it are tracked as
   * Phase 2 of work doc #20. Configured bitrates below
   * {@link Reticulum.MINIMUM_BITRATE} are ignored (matching Python).
   * @type {number}
   */
  bitrate = 62500;

  /**
   * Whether this interface is currently open/online.
   * @type {boolean}
   */
  get isOpen() {
    return this.online;
  }

  /**
   * The readable stream of incoming data.
   * @type {import('node:stream/web').ReadableStream | null}
   */
  get readable() {
    throw new Error("Interface.readable is not implemented");
  }

  /**
   * The writable stream of outgoing data.
   * @type {import('node:stream/web').WritableStream | null}
   */
  get writable() {
    throw new Error("Interface.writable is not implemented");
  }

  /**
   * Establishes the connection.
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error("Interface.connect is not implemented");
  }

  /**
   * Dials the peer and sets up the RNS streams, resolving once connected and
   * dispatching `connected`. Implemented by reconnect-capable client
   * subclasses; used both for the initial connection and each reconnect
   * attempt by the shared {@link Interface._runReconnectLoop}.
   * @returns {Promise<void>}
   * @protected
   */
  async _establishConnection() {
    throw new Error("Interface._establishConnection is not implemented");
  }

  /**
   * Closes the connection.
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error("Interface.disconnect is not implemented");
  }

  /**
   * Optional hook invoked by {@link import("../transport/transport.js").TransportCore#addInterface}
   * with the transport that owns this interface, right after the interface is
   * attached.
   *
   * The base implementation is a no-op. Interfaces that spawn sub-interfaces
   * dynamically — notably {@link AutoInterface}, which discovers peers and
   * spawns one per peer — override it to remember the transport so the spawned
   * peers can be auto-registered without a separate `Reticulum` global (the
   * Python reference uses the global `RNS.Transport.add_interface` for this).
   *
   * Overriders should also register any peers spawned before the transport was
   * attached, so the `addInterface`/`connect` call order doesn't matter.
   * @param {import("../transport/transport.js").TransportCore} _transport
   */
  attachTransport(_transport) {}

  /**
   * Sends bytes wrapped in KISS framing
   * @param {import("../core/packet.js").Packet} packet
   */
  async send(packet) {
    if (!this.writable) {
      throw new Error("Interface not ready: No packet writer found.");
    }

    if (!this._packetWriter) {
      // Only get a writer if it doesn't exist yet
      this._packetWriter = this.writable.getWriter();
    }

    await this._packetWriter.write(packet);

    // FORCE DRAIN:
    // If the socket has a buffer, wait for it to empty
    const socket = this.socket;
    if (socket && socket.writable) {
      // This forces Node to push the buffered data out of the NIC
      await new Promise((resolve) => socket.write("", resolve));
    }
  }

  // ------------------------------------------------------------------
  // Shared reconnection machinery (used by client interfaces)
  // ------------------------------------------------------------------

  /**
   * Whether automatic reconnection is enabled for this initiator interface.
   * @type {boolean}
   */
  autoReconnect = RECONNECT_DEFAULTS.autoReconnect;
  /**
   * Seconds to wait between reconnection attempts.
   * @type {number}
   */
  reconnectWait = RECONNECT_DEFAULTS.reconnectWait;
  /**
   * Maximum reconnection attempts per drop. `Infinity` retries forever.
   * @type {number}
   */
  maxReconnectTries = RECONNECT_DEFAULTS.maxReconnectTries;
  /**
   * Per-dial connect timeout in seconds.
   * @type {number}
   */
  connectTimeout = RECONNECT_DEFAULTS.connectTimeout;

  /**
   * Permanent stop signal read by the reconnect loop. Set by `disconnect()`.
   * @type {boolean}
   */
  detached = false;

  /**
   * Single-flight guard: only one reconnect loop runs at a time.
   * @type {boolean}
   * @protected
   */
  _reconnecting = false;

  /**
   * Reconnect attempt counter for the current drop episode. Reset to 0 at the
   * start of each {@link Interface._runReconnectLoop} run.
   * @type {number}
   * @protected
   */
  _reconnectAttempts = 0;

  /**
   * AbortController for the current reconnect wait, so `disconnect()` can
   * cancel an in-flight backoff immediately.
   * @type {AbortController | null}
   * @protected
   */
  _reconnectAbort = null;

  /**
   * Whether a terminal `closed` event has already been dispatched for the
   * current connection episode (dedupe guard).
   * @type {boolean}
   * @protected
   */
  _closed = false;

  /**
   * Initializes shared reconnect state from constructor options. Called by
   * client interface subclasses (TCP, WebSocket) that support reconnection.
   *
   * Subclasses must also set {@link Interface.initiator}: `true` for an
   * outbound dialer, `false` for an adopted/server-spawned socket.
   * @param {ReconnectOptions} options
   * @protected
   */
  _initReconnectState(options) {
    this.autoReconnect =
      options.autoReconnect !== undefined
        ? options.autoReconnect
        : RECONNECT_DEFAULTS.autoReconnect;
    this.reconnectWait =
      options.reconnectWait !== undefined
        ? options.reconnectWait
        : RECONNECT_DEFAULTS.reconnectWait;
    // Python treats `max_reconnect_tries = None` as "retry forever".
    this.maxReconnectTries =
      options.maxReconnectTries === undefined ||
      options.maxReconnectTries === null
        ? Number.POSITIVE_INFINITY
        : options.maxReconnectTries;
    this.connectTimeout =
      options.connectTimeout !== undefined
        ? options.connectTimeout
        : RECONNECT_DEFAULTS.connectTimeout;
    this._reconnecting = false;
    this._reconnectAttempts = 0;
    this._reconnectAbort = null;
    this.detached = false;
  }

  /**
   * Signals the reconnect loop to stop and cancels any in-flight backoff.
   * Client subclasses call this at the top of their `disconnect()`.
   * @protected
   */
  _cancelReconnect() {
    this.detached = true;
    if (this._reconnectAbort) {
      this._reconnectAbort.abort();
      this._reconnectAbort = null;
    }
  }

  /**
   * Dispatches a terminal `closed` event exactly once per connection episode.
   * @protected
   */
  _dispatchClosed() {
    if (this._closed) return;
    this._closed = true;
    this.online = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  /**
   * Called when the underlying connection drops (the inbound stream ends or
   * errors). For an initiator with auto-reconnect enabled and not deliberately
   * detached, dispatches `disconnected` and kicks off the reconnect loop;
   * otherwise dispatches a terminal `closed` event.
   *
   * Matches the Python reference `read_loop`, which reconnects the initiator
   * on any termination and tears down (non-reconnecting) everyone else.
   * @protected
   */
  _handleConnectionLost() {
    this.online = false;
    if (this.detached) {
      this._dispatchClosed();
      return;
    }
    if (this.initiator && this.autoReconnect) {
      this.dispatchEvent(new CustomEvent("disconnected"));
      this._runReconnectLoop();
    } else {
      this._dispatchClosed();
    }
  }

  /**
   * Runs the single-flight reconnect loop. Repeatedly waits `reconnectWait`
   * seconds then attempts to re-establish the connection via the subclass
   * `_establishConnection()` hook, until it succeeds, the interface is
   * detached, or `maxReconnectTries` is exceeded (terminal `closed`).
   *
   * Each attempt fires a `reconnecting` event with the upcoming attempt
   * number, the wait, and the cap, for observability. A successful reconnect
   * fires `connected` (via `_establishConnection`).
   * @protected
   */
  async _runReconnectLoop() {
    if (this._reconnecting) return; // single-flight
    this._reconnecting = true;
    this._reconnectAttempts = 0;
    this._closed = false;
    this._reconnectAbort = new AbortController();
    const abortSignal = this._reconnectAbort.signal;
    try {
      while (!this.detached) {
        this._reconnectAttempts += 1;
        if (
          this.maxReconnectTries !== Number.POSITIVE_INFINITY &&
          this._reconnectAttempts > this.maxReconnectTries
        ) {
          log(
            this.name,
            `Max reconnection attempts (${this.maxReconnectTries}) reached; giving up`,
            LogLevel.ERROR,
          );
          this._dispatchClosed();
          return;
        }

        this.dispatchEvent(
          new CustomEvent("reconnecting", {
            detail: {
              attempt: this._reconnectAttempts,
              waitSeconds: this.reconnectWait,
              maxTries: this.maxReconnectTries,
            },
          }),
        );

        await this._sleepInterruptible(this.reconnectWait * 1000, abortSignal);
        if (this.detached) break;

        try {
          await this._establishConnection();
          return; // reconnected; the new inbound loop owns the next episode
        } catch (e) {
          log(
            this.name,
            `Reconnection attempt ${this._reconnectAttempts} failed: ${/** @type {any} */ (e).message}`,
            LogLevel.DEBUG,
          );
          // loop and try again
        }
      }
    } finally {
      this._reconnecting = false;
    }
  }

  /**
   * Resolves after `ms`, or immediately if `signal` aborts. Used so
   * `disconnect()` can cancel an in-flight reconnect backoff at once.
   * @param {number} ms
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   * @protected
   */
  _sleepInterruptible(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export { reconnectSchemaProperties };
