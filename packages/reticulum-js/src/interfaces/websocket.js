import { Packet } from "../core/packet.js";
import {
  createKissUnframerStream,
  kissFrame,
} from "../transport/kiss-framer.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface, reconnectSchemaProperties } from "./base.js";

/**
 * @file websocket.js
 * @description Reticulum interface transport over WebSocket (RFC 6455)
 *
 * A WebSocket is message-oriented, so the default (`raw`) framing sends each
 * RNS packet as one binary message in its raw wire format — no HDLC (0x7E)
 * byte-stuffing is applied. This matches the Python reference WebSocket
 * client/server interfaces and the upstream `rns.js` client.
 *
 * For peers that speak KISS over WebSocket (some RNode firmware versions
 * expose a KISS-framed WebSocket link), set `framing: "kiss"`. Each outbound
 * packet is then wrapped as `FEND | CMD_DATA | escaped | FEND` inside a single
 * binary message, and inbound message bytes are fed through the streaming
 * KISS unframer so frames split across (or coalesced within) messages still
 * parse correctly. See `PROTOCOL-SPEC.md` §8.1.
 *
 * The server spawns a client interface per accepted connection, and the
 * framing mode is inherited from the server configuration.
 */

/**
 * Minimum RNS header size in bytes (`RNS.Reticulum.HEADER_MINSIZE`):
 * `2 + 1 + (TRUNCATED_HASHLENGTH / 8)` = `2 + 1 + 16` = 19.
 *
 * Mirrors the defensive floor every Python reference interface
 * (LocalInterface, TCPInterface, BackboneInterface, WebSocketClientInterface)
 * applies in its read loop before handing a frame to Transport: frames no
 * larger than this are silently dropped.
 */
const HEADER_MINSIZE = 19;

/**
 * Decodes a single raw (`framing: "raw"`) WebSocket message into a Packet,
 * honouring the IFAC flag bit (the high bit of the first header byte).
 *
 * In Python, the IFAC field is prepended/masked by `Transport.outbound` and
 * stripped/unmasked by `Transport.inbound`, so an interface normally just
 * passes raw bytes through. When this interface is not configured with an
 * `ifacSize`, IFAC-tagged packets cannot be authenticated and are dropped —
 * matching both the Python reference and the upstream `rns.js` client.
 *
 * Not used when `framing: "kiss"`; in that mode inbound bytes are fed through
 * the streaming KISS unframer instead.
 * @param {Uint8Array} bytes
 * @param {number} ifacSize
 * @returns {import("../core/packet.js").Packet | null} `null` if the message should be ignored.
 */
export function packetFromMessage(bytes, ifacSize) {
  const hasIfac = (bytes[0] & 0x80) !== 0;
  if (hasIfac) {
    if (ifacSize > 0) {
      // Strip the 2-byte header + IFAC signature, matching the existing
      // unframer behaviour. (Full IFAC verification is not yet implemented.)
      return Packet.deserialize(bytes.slice(2 + ifacSize));
    }
    log(
      "WebSocket",
      "Received IFAC packet but no ifacSize configured; dropping",
      LogLevel.DEBUG,
    );
    return null;
  }
  return Packet.deserialize(bytes);
}

/**
 * @typedef {Object} WebSocketClientInterfaceOptions
 * @property {string} [url] - Full WebSocket URL, e.g. `ws://host:port` or
 *   `wss://host/path`. Takes precedence over `host`/`port`.
 * @property {string} [host] - Target host. Used to build `ws://host:port` when
 *   `url` is omitted.
 * @property {number} [port] - Target port. Used to build `ws://host:port` when
 *   `url` is omitted.
 * @property {WebSocket} [websocket] - An already-open WebSocket to adopt
 *   instead of dialing. Used when a server spawns a client interface for an
 *   accepted connection.
 * @property {number} [ifacSize] - Optional IFAC field size, if the remote peer
 *   signs packets with an interface authentication code.
 * @property {"raw"|"kiss"} [framing] - Wire framing. Defaults to `"raw"`
 *   (one RNS packet per binary message). Set to `"kiss"` for peers that
 *   speak KISS over WebSocket (e.g. some RNode firmware versions): each
 *   packet is wrapped as `FEND | CMD_DATA | escaped | FEND` per message.
 * @property {string} [name] - Interface name.
 * @property {boolean} [autoReconnect] - Reconnect after drops (initiator
 *   only). Defaults to `true`.
 * @property {number} [reconnectWait] - Seconds between attempts. Defaults to 5.
 * @property {number|null} [maxReconnectTries] - Attempt cap, or `null` for
 *   unlimited. Defaults to unlimited.
 * @property {number} [connectTimeout] - Per-dial timeout in seconds. Defaults
 *   to 5.
 */

/**
 * Reticulum interface that connects to a remote node over a WebSocket.
 *
 * Wraps a `WebSocket` into RNS streams. In `raw` framing each binary message
 * is one RNS packet; in `kiss` framing messages carry KISS-framed bytes that
 * are parsed by the streaming unframer (so split/coalesced frames still
 * parse). Outbound packets are serialized (and optionally KISS-framed) and
 * sent as individual binary messages. The underlying connection may either
 * be dialed via {@link WebSocketClientInterface.connect} or adopted from an
 * already-open socket (e.g. one accepted by a server).
 * @extends Interface
 */
export class WebSocketClientInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link WebSocketClientInterface} constructor (excluding the internal
   * `websocket` adoption option).
   *
   * No field is required: either `url` or (`host` + `port`) must be provided
   * at runtime, but both are surfaced as optional so a UI can render them.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "WebSocket Client Interface",
      description:
        "Connects to a remote Reticulum node over a WebSocket and " +
        "automatically reconnects (as the initiator) after a drop. " +
        "JS-specific; there is no direct Python reference equivalent.",
      properties: {
        ...base.properties,
        url: {
          type: "string",
          format: "uri",
          description:
            "Full WebSocket URL, e.g. ws://host:port or wss://host/path. " +
            "Takes precedence over host/port.",
          examples: ["ws://127.0.0.1:4242", "wss://node.example.org/path"],
        },
        host: {
          type: "string",
          default: "localhost",
          examples: ["localhost", "127.0.0.1"],
          description:
            "Target host. Used to build ws://host:port when url is omitted.",
        },
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          examples: [4242],
          description:
            "Target port. Used to build ws://host:port when url is omitted.",
        },
        ...reconnectSchemaProperties(),
        framing: {
          type: "string",
          enum: ["raw", "kiss"],
          default: "raw",
          description:
            "Wire framing. Defaults to raw (one RNS packet per binary " +
            "message). Set to kiss for peers that speak KISS over WebSocket " +
            "(e.g. some RNode firmware versions).",
        },
      },
      required: [],
      additionalProperties: false,
    };
  }

  /**
   * The underlying WebSocket connection, when one has been opened or adopted.
   * Typed loosely because the base `Interface.socket` is declared as a Node
   * socket; we reuse the same field so the base `send()` helper can see it.
   * @type {any}
   */
  socket = null;

  /**
   * Creates a WebSocket client interface.
   * @param {WebSocketClientInterfaceOptions} options
   */
  constructor(options) {
    super();
    this._initReconnectState(options);
    if (options.url) {
      this.url = options.url;
    } else {
      const host = options.host || "localhost";
      const port = options.port || 0;
      this.url = `ws://${host}:${port}`;
    }
    this.name =
      options.name || `ws-client-${this.url.replace(/^wss?:\/\//, "")}`;
    /** @type {number} */
    this.ifacSize = options.ifacSize || 0;
    /**
     * Nominal bitrate. JS-specific (no Python equivalent); WebSocket is
     * TCP-backed so we assume the same 10 Mbit/s guess as
     * `TCPClientInterface.BITRATE_GUESS`.
     * @type {number}
     */
    this.bitrate = 10000000;
    /** @type {"raw"|"kiss"} */
    this.framing = options.framing === "kiss" ? "kiss" : "raw";
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {boolean} */
    this.online = false;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
    /** @type {any} */
    this._adoptedWebSocket = options.websocket || null;
    // Only the initiator (the outbound dialer) reconnects. An adopted
    // websocket is a server-spawned connection and tears down on close.
    this.initiator = !this._adoptedWebSocket;
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
   * Opens the WebSocket connection (or adopts the provided one) and starts the
   * inbound loop.
   *
   * For an initiator whose first dial fails with auto-reconnect enabled, the
   * promise rejects (so the caller knows the first attempt failed) but the
   * reconnect loop keeps retrying in the background.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._adoptedWebSocket) {
      this.socket = this._adoptedWebSocket;
      this.initiator = false;
      this._setupStreams(this.socket);
      this.online = true;
      this._closed = false;
      this.dispatchEvent(
        new CustomEvent("connected", { detail: { url: this.url } }),
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
   * Dials the WebSocket URL (with the configured connect timeout), sets up the
   * RNS streams, and dispatches `connected`.
   *
   * Used both for the initial connection and for each reconnect attempt.
   * @returns {Promise<void>} Resolves once connected; rejects on failure.
   * @protected
   */
  _establishConnection() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.socket = ws;
      let settled = false;
      const timeoutMs = Math.max(0, this.connectTimeout) * 1000;
      const timeoutHandle =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              try {
                ws.close();
              } catch (_e) {
                // ignore
              }
              reject(
                new Error(
                  `WebSocket connect to ${this.url} timed out after ${this.connectTimeout}s`,
                ),
              );
            }, timeoutMs)
          : null;
      const fail = () => {
        if (settled) return;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        settled = true;
        this.online = false;
        reject(new Error(`WebSocket connection to ${this.url} failed`));
      };
      ws.addEventListener("open", () => {
        if (settled) return;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        settled = true;
        this._setupStreams(ws);
        this.online = true;
        this._closed = false;
        this.dispatchEvent(
          new CustomEvent("connected", { detail: { url: this.url } }),
        );
        resolve();
      });
      ws.addEventListener("error", () => fail());
      ws.addEventListener("close", () => fail());
    });
  }

  /**
   * Tears down the WebSocket, cancels any pending reconnect, and marks the
   * interface offline. Dispatches a terminal `disconnected` followed by
   * `closed`.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._cancelReconnect();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_e) {
        // ignore
      }
      this.socket = null;
    }
    this.online = false;
    this.dispatchEvent(
      new CustomEvent("disconnected", { detail: { url: this.url } }),
    );
    this._dispatchClosed();
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * Bridges a `WebSocket` into RNS streams. In `raw` framing each binary
   * message is one RNS packet; in `kiss` framing messages carry KISS-framed
   * bytes that are parsed by the streaming unframer (so split/coalesced
   * frames still parse). Outbound packets are serialized (and optionally
   * KISS-framed) and sent as individual binary messages.
   * @param {any} ws
   * @private
   */
  _setupStreams(ws) {
    ws.binaryType = "arraybuffer";
    // Streams are replaced on every reconnect; drop any stale writer so the
    // next `send()` re-acquires one bound to the fresh writable.
    this._packetWriter = null;

    const framing = this.framing;
    const ifacSize = this.ifacSize;

    // Inbound: WebSocket binary messages -> bytes (kiss) or packets (raw).
    //
    // In raw mode each binary message is one RNS packet and is parsed here
    // directly. In kiss mode the message bytes are emitted raw and piped
    // through the streaming KISS unframer below, so frames split across (or
    // coalesced within) messages still parse correctly.
    const incoming = new ReadableStream({
      start: (controller) => {
        ws.addEventListener("message", (/** @type {any} */ event) => {
          // `binaryType` is "arraybuffer", so binary frames arrive as
          // ArrayBuffer and text frames as strings.
          if (!(event.data instanceof ArrayBuffer)) {
            log(
              "WebSocket",
              "Ignoring non-binary WebSocket message",
              LogLevel.DEBUG,
            );
            return;
          }
          const bytes = new Uint8Array(event.data);
          if (framing === "kiss") {
            controller.enqueue(bytes);
            return;
          }
          // raw mode: match the Python reference `_read_loop` and drop
          // anything no larger than the header minimum (HEADER_MINSIZE).
          try {
            if (bytes.length <= HEADER_MINSIZE) {
              log(
                "WebSocket",
                `Dropping WebSocket message at or below header minimum (${HEADER_MINSIZE} bytes)`,
                LogLevel.DEBUG,
              );
              return;
            }
            const packet = packetFromMessage(bytes, ifacSize);
            if (packet) controller.enqueue(packet);
          } catch (e) {
            log(
              "WebSocket",
              `Failed to parse incoming message: ${e}`,
              LogLevel.ERROR,
            );
          }
        });
        ws.addEventListener("close", () => {
          try {
            controller.close();
          } catch (_e) {
            // already closed/errored
          }
        });
        ws.addEventListener("error", () => {
          try {
            controller.error(new Error("WebSocket error"));
          } catch (_e) {
            // already closed/errored
          }
        });
      },
      cancel: () => {
        try {
          ws.close();
        } catch (_e) {
          // ignore
        }
      },
    });

    this._readable =
      framing === "kiss"
        ? incoming.pipeThrough(
            /** @type {any} */ (createKissUnframerStream(Packet, ifacSize)),
          )
        : incoming;

    // Outbound: packets -> WebSocket binary messages
    const sink = new WritableStream({
      write: (/** @type {import("../core/packet.js").Packet} */ packet) => {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket is not open");
        }
        ws.send(
          framing === "kiss"
            ? kissFrame(packet.serialize())
            : packet.serialize(),
        );
      },
      close: () => {
        try {
          ws.close();
        } catch (_e) {
          // ignore
        }
      },
      abort: () => {
        try {
          ws.close();
        } catch (_e) {
          // ignore
        }
      },
    });
    this._writable = sink;

    this._loopPromise = this._startInboundLoop();
  }

  /**
   * Reads packets from the inbound stream and dispatches them.
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
