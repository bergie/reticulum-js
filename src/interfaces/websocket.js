import { Packet } from "../core/packet.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface } from "./base.js";

/**
 * @file websocket.js
 * @description Reticulum interface transport over WebSocket (RFC 6455)
 *
 * Unlike a raw TCP or serial connection, a WebSocket is already
 * message-oriented, so each binary message carries exactly one RNS packet in
 * its raw wire format. No HDLC (0x7E) framing or byte-stuffing is applied.
 *
 * This matches the Python reference WebSocket client/server interfaces: the
 * server spawns a client interface per accepted connection, and both sides
 * simply read and write raw packets as individual WebSocket binary messages.
 * Neither side forces `compression=None`, so permessage-deflate may be
 * negotiated — the standard `WebSocket` API handles that transparently, so it
 * has no effect on the RNS framing.
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
 * Decodes a single raw WebSocket message into a Packet, honouring the IFAC
 * flag bit (the high bit of the first header byte).
 *
 * In Python, the IFAC field is prepended/masked by `Transport.outbound` and
 * stripped/unmasked by `Transport.inbound`, so an interface normally just
 * passes raw bytes through. When this interface is not configured with an
 * `ifacSize`, IFAC-tagged packets cannot be authenticated and are dropped —
 * matching both the Python reference and the upstream `rns.js` client.
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
 * @property {string} [name] - Interface name.
 */

/**
 * Reticulum interface that connects to a remote node over a WebSocket.
 *
 * Wraps a `WebSocket` into RNS streams. Each outbound `Packet` is serialized
 * and sent as a single binary message; each inbound binary message is parsed
 * back into a `Packet`. The underlying connection may either be dialed via
 * {@link WebSocketClientInterface.connect} or adopted from an already-open
 * socket (e.g. one accepted by a server).
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
        "Connects to a remote Reticulum node over a WebSocket. " +
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
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {boolean} */
    this.online = false;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
    /** @type {boolean} */
    this._closed = false;
    /** @type {any} */
    this._adoptedWebSocket = options.websocket || null;
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
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._adoptedWebSocket) {
      this.socket = this._adoptedWebSocket;
      this._setupStreams(this.socket);
      this.online = true;
      this.dispatchEvent(
        new CustomEvent("connected", { detail: { url: this.url } }),
      );
      return;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.socket = ws;

      let opened = false;
      const fail = () => {
        if (opened) return;
        this.online = false;
        this.dispatchEvent(
          new CustomEvent("disconnected", { detail: { url: this.url } }),
        );
        reject(new Error(`WebSocket connection to ${this.url} failed`));
      };
      ws.addEventListener("open", () => {
        opened = true;
        this._setupStreams(ws);
        this.online = true;
        this.dispatchEvent(
          new CustomEvent("connected", { detail: { url: this.url } }),
        );
        resolve();
      });
      ws.addEventListener("error", () => {
        // Some implementations surface connection refusal only via `close`;
        // others fire `error` first. Either way, fail the connect promise if
        // the socket never opened. Post-open errors propagate via the stream.
        fail();
      });
      ws.addEventListener("close", () => {
        fail();
      });
    });
  }

  /**
   * Tears down the WebSocket and marks the interface offline.
   * @returns {Promise<void>}
   */
  async disconnect() {
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
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * Bridges a `WebSocket` into RNS streams: inbound binary messages are parsed
   * into packets, and outbound packets are serialized and sent as individual
   * binary messages.
   * @param {any} ws
   * @private
   */
  _setupStreams(ws) {
    ws.binaryType = "arraybuffer";

    // Inbound: WebSocket binary messages -> packets
    const incoming = new ReadableStream({
      start: (controller) => {
        ws.addEventListener("message", (/** @type {any} */ event) => {
          // Match the Python reference `_read_loop`: ignore non-binary
          // frames and drop anything no larger than the header minimum
          // (HEADER_MINSIZE). `binaryType` is "arraybuffer", so binary
          // frames arrive as ArrayBuffer and text frames as strings.
          if (!(event.data instanceof ArrayBuffer)) {
            log(
              "WebSocket",
              "Ignoring non-binary WebSocket message",
              LogLevel.DEBUG,
            );
            return;
          }
          try {
            const bytes = new Uint8Array(event.data);
            if (bytes.length <= HEADER_MINSIZE) {
              log(
                "WebSocket",
                `Dropping WebSocket message at or below header minimum (${HEADER_MINSIZE} bytes)`,
                LogLevel.DEBUG,
              );
              return;
            }
            const packet = packetFromMessage(bytes, this.ifacSize);
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
    this._readable = incoming;

    // Outbound: packets -> WebSocket binary messages
    const sink = new WritableStream({
      write: (/** @type {import("../core/packet.js").Packet} */ packet) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(packet.serialize());
        } else {
          throw new Error("WebSocket is not open");
        }
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
    try {
      while (true) {
        const { value: packet, done } = await reader.read();
        if (done) {
          if (!this._closed) {
            this._closed = true;
            this.dispatchEvent(new CustomEvent("closed"));
          }
          break;
        }
        this.dispatchEvent(new CustomEvent("packet", { detail: { packet } }));
      }
    } catch (e) {
      if (
        /** @type {any} */ (e).name === "AbortError" ||
        /** @type {any} */ (e).code === "ABORT_ERR"
      ) {
        if (!this._closed) {
          this._closed = true;
          this.dispatchEvent(new CustomEvent("closed"));
        }
      } else {
        this.dispatchEvent(
          new CustomEvent("error", { detail: /** @type {any} */ (e) }),
        );
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * @typedef {Object} WebSocketServerInterfaceOptions
 * @property {string} [listenIp] - Address to bind the server to.
 * @property {number} [listenPort] - Port to bind the server to.
 * @property {number} [ifacSize] - Optional IFAC field size for spawned clients.
 * @property {string} [name] - Interface name.
 */

/**
 * Reticulum interface that listens for inbound WebSocket connections.
 *
 * Each accepted connection would be exposed as a spawned
 * {@link WebSocketClientInterface} via the `connection` event, mirroring the
 * Python reference `WebSocketServerInterface`.
 *
 * @todo The server side is not yet implemented. This class reserves the
 *   intended API shape; `connect()` will throw until it is built.
 * @extends Interface
 */
export class WebSocketServerInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link WebSocketServerInterface} constructor.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "WebSocket Server Interface",
      description:
        "Listens for inbound WebSocket connections and spawns a client " +
        "interface per accepted connection. JS-specific; the server side is " +
        "not yet implemented.",
      properties: {
        ...base.properties,
        listenIp: {
          type: "string",
          default: "0.0.0.0",
          examples: ["0.0.0.0", "127.0.0.1"],
          description: "Address to bind the server to.",
        },
        listenPort: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          examples: [4242],
          description: "Port to bind the server to.",
        },
      },
      required: ["listenPort"],
      additionalProperties: false,
    };
  }

  /**
   * Creates a WebSocket server interface.
   * @param {WebSocketServerInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.name =
      options.name ||
      `ws-server-${options.listenIp || "0.0.0.0"}:${options.listenPort || 0}`;
    this.listenIp = options.listenIp || "0.0.0.0";
    this.listenPort = options.listenPort || 0;
    /** @type {number} */
    this.ifacSize = options.ifacSize || 0;
    /** @type {any} */
    this.server = null;
    /** @type {Set<WebSocketClientInterface>} */
    this.spawnedInterfaces = new Set();
    /** @type {boolean} */
    this.online = false;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.online;
  }

  /** Number of currently connected clients. */
  get clients() {
    return this.spawnedInterfaces.size;
  }

  /** @returns {any} */
  get readable() {
    throw new Error("WebSocketServerInterface.readable is not implemented");
  }
  /** @returns {any} */
  get writable() {
    throw new Error("WebSocketServerInterface.writable is not implemented");
  }

  /**
   * Starts listening for inbound WebSocket connections.
   * @returns {Promise<void>}
   * @todo Not yet implemented.
   */
  async connect() {
    throw new Error("WebSocketServerInterface.connect is not yet implemented");
  }

  /**
   * Closes the listening server and disconnects all spawned client interfaces.
   * @returns {Promise<void>}
   * @todo Not yet implemented.
   */
  async disconnect() {
    throw new Error(
      "WebSocketServerInterface.disconnect is not yet implemented",
    );
  }
}
