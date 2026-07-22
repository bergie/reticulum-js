/**
 * @module reticulum-js-websocket-server-node
 * @description Node.js WebSocket **server** interface for `reticulum-js`.
 *
 * The browser-safe core (`reticulum-js`) ships only the `WebSocketClientInterface`
 * — a server needs a WebSocket server, which browsers cannot run and Node does
 * not ship natively. This companion listens for inbound WebSocket connections
 * and spawns a `WebSocketClientInterface` per accepted connection (adopting the
 * socket), mirroring `TCPServerInterface`. Backed by
 * [ws](https://github.com/websockets/ws).
 *
 * ```js
 * import { WebSocketServerInterface } from "reticulum-js-websocket-server-node";
 * const server = new WebSocketServerInterface({ listenPort: 4242 });
 * await server.connect();
 * ```
 */

import { Interface } from "reticulum-js/src/interfaces/base.js";
import { WebSocketClientInterface } from "reticulum-js/src/interfaces/websocket.js";
import { WebSocketServer } from "ws";

/**
 * @typedef {Object} WebSocketServerInterfaceOptions
 * @property {string} [listenIp] - Address to bind the server to. Default `0.0.0.0`.
 * @property {number} [listenPort] - Port to bind the server to.
 * @property {number} [ifacSize] - Optional IFAC field size for spawned clients.
 * @property {"raw"|"kiss"} [framing] - Wire framing inherited by spawned client
 *   interfaces. Default `"raw"`.
 * @property {string} [name] - Interface name.
 */

/**
 * Reticulum interface that listens for inbound WebSocket connections.
 *
 * Each accepted connection spawns a {@link WebSocketClientInterface} (adopting
 * the accepted socket), announced via a `connection` event so the transport can
 * register it. Like `TCPServerInterface`, the server itself never carries
 * packets — its `readable`/`writable` accessors throw.
 * @extends Interface
 */
export class WebSocketServerInterface extends Interface {
  /**
   * Returns the JSON Schema describing the constructor options.
   * @returns {Record<string, any>}
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "WebSocket Server Interface",
      description:
        "Listens for inbound WebSocket connections and spawns a client " +
        "interface per accepted connection. JS-specific; backed by ws.",
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
        framing: {
          type: "string",
          enum: ["raw", "kiss"],
          default: "raw",
          description:
            "Wire framing inherited by spawned client interfaces. " +
            "Defaults to raw; set to kiss for RNode-style KISS-over-WebSocket " +
            "peers.",
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
    /** @type {"raw"|"kiss"} */
    this.framing = options.framing === "kiss" ? "kiss" : "raw";
    /**
     * Nominal bitrate, inherited by spawned client interfaces. JS-specific
     * (no Python equivalent); matches the WebSocket client's TCP-backed guess.
     * @type {number}
     */
    this.bitrate = 10000000;
    /** @type {WebSocketServer|null} */
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
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({
        host: this.listenIp,
        port: this.listenPort,
      });
      this.server.on("listening", () => {
        this.online = true;
        resolve();
      });
      this.server.on("error", (/** @type {Error} */ err) => {
        this.online = false;
        reject(err);
      });
      this.server.on(
        "connection",
        async (
          /** @type {import("ws").WebSocket} */ ws,
          /** @type {import("http").IncomingMessage} */ req,
        ) => {
          const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
          const client = new WebSocketClientInterface({
            websocket: /** @type {any} */ (ws),
            ifacSize: this.ifacSize,
            framing: this.framing,
            name: `ws-client-from-server-${remote}`,
          });
          client.bitrate = this.bitrate;
          await client.connect();
          this.spawnedInterfaces.add(client);
          this.dispatchEvent(new CustomEvent("connection", { detail: client }));
        },
      );
    });
  }

  /**
   * Closes the listening server and disconnects all spawned client interfaces.
   * @returns {Promise<void>}
   */
  async disconnect() {
    const server = this.server;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      this.server = null;
    }
    await Promise.all(
      Array.from(this.spawnedInterfaces).map((client) => client.disconnect()),
    );
    this.spawnedInterfaces.clear();
    this.online = false;
  }
}
