/**
 * @module @reticulum/websocket-server-node
 * @description Node.js WebSocket **server** interface for `@reticulum/core`.
 *
 * The browser-safe core (`@reticulum/core`) ships only the `WebSocketClientInterface`
 * — a server needs a WebSocket server, which browsers cannot run and Node does
 * not ship natively. This companion listens for inbound WebSocket connections
 * and spawns a `WebSocketClientInterface` per accepted connection (adopting the
 * socket), mirroring `TCPServerInterface`. Backed by
 * [ws](https://github.com/websockets/ws).
 *
 * ```js
 * import { WebSocketServerInterface } from "@reticulum/websocket-server-node";
 * const server = new WebSocketServerInterface({ listenPort: 4242 });
 * await server.connect();
 * ```
 */

/* @ts-self-types="../types/src/index.d.ts" */

import fs from "node:fs";
import https from "node:https";
import { Interface } from "@reticulum/core/src/interfaces/base.js";
import { WebSocketClientInterface } from "@reticulum/core/src/interfaces/websocket.js";
import { WebSocketServer } from "ws";

/**
 * Constructor options for {@link WebSocketServerInterface}.
 *
 * @typedef {Object} WebSocketServerInterfaceOptions
 * @property {string} [listenIp] - Address to bind the server to. Default `0.0.0.0`.
 * @property {number} [listenPort] - Port to bind the server to.
 * @property {number} [ifacSize] - Optional IFAC field size for spawned clients.
 * @property {string} [networkName] - Shared IFAC network name (`ifac_netname`).
 * @property {string} [passphrase] - Shared IFAC passphrase (`ifac_netkey`).
 * @property {"raw"|"kiss"} [framing] - Wire framing inherited by spawned client
 *   interfaces. Default `"raw"`.
 * @property {boolean} [ssl] - Terminate TLS so clients connect over `wss://`
 *   (mirrors the Python reference `ssl` config key). Requires both `certFile`
 *   and `keyFile`. Browsers in a secure context (HTTPS) cannot open `ws://`, so
 *   a browser-facing server needs this. Default `false`.
 * @property {string} [certFile] - Path to a PEM certificate chain, required when
 *   `ssl` is set (mirrors the Python reference `certfile` config key).
 * @property {string} [keyFile] - Path to a PEM private key, required when `ssl`
 *   is set (mirrors the Python reference `keyfile` config key).
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
        ssl: {
          type: "boolean",
          default: false,
          description:
            "Terminate TLS so clients connect over wss:// (Python config key: " +
            "ssl). Requires both certFile and keyFile. Browsers in a secure " +
            "context (HTTPS) cannot open ws://, so a browser-facing server " +
            "needs this.",
        },
        certFile: {
          type: "string",
          description:
            "Path to a PEM certificate chain, required when ssl is set " +
            "(Python config key: certfile).",
        },
        keyFile: {
          type: "string",
          description:
            "Path to a PEM private key, required when ssl is set (Python " +
            "config key: keyfile).",
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
    /** @type {string|null} */
    this.ifacNetname = options.networkName || null;
    /** @type {string|null} */
    this.ifacNetkey = options.passphrase || null;
    /** @type {"raw"|"kiss"} */
    this.framing = options.framing === "kiss" ? "kiss" : "raw";
    /** Terminate TLS (`wss://`). Mirrors the Python `use_ssl` flag. */
    this.ssl = options.ssl === true;
    /** Path to a PEM certificate chain. Mirrors the Python `certfile` key. */
    this.certFile = options.certFile || null;
    /** Path to a PEM private key. Mirrors the Python `keyfile` key. */
    this.keyFile = options.keyFile || null;

    // Validation mirrors the Python reference WebSocketServerInterface: SSL
    // requires both a certificate chain and a private key, and providing
    // either without SSL is also rejected (it would silently do nothing).
    if (this.ssl && (!this.certFile || !this.keyFile)) {
      throw new Error(
        `Both certFile and keyFile must be specified when ssl is enabled for ${this.name}`,
      );
    }
    if (!this.ssl && (this.certFile || this.keyFile)) {
      throw new Error(
        `SSL must be enabled when certFile or keyFile is specified for ${this.name}`,
      );
    }
    /**
     * Nominal bitrate, inherited by spawned client interfaces. JS-specific
     * (no Python equivalent); matches the WebSocket client's TCP-backed guess.
     * @type {number}
     */
    this.bitrate = 10000000;
    /** @type {WebSocketServer|null} */
    this.server = null;
    /**
     * The underlying HTTPS server we create when terminating TLS ourselves.
     * `null` in the plain `ws://` case (where `ws` owns the HTTP server).
     * @type {import("node:https").Server | null}
     */
    this.tlsServer = null;
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
      // When terminating TLS we wrap a Node `https.Server` and hand it to
      // `ws` via the `server` option. `ws` then forwards `listening` and
      // `error` from the underlying server but does NOT call `listen()` (nor
      // `close()` on shutdown), so we drive both ourselves.
      if (this.ssl) {
        this.tlsServer = https.createServer({
          cert: fs.readFileSync(/** @type {string} */ (this.certFile)),
          key: fs.readFileSync(/** @type {string} */ (this.keyFile)),
        });
        this.server = new WebSocketServer({ server: this.tlsServer });
        this.tlsServer.listen(this.listenPort, this.listenIp);
      } else {
        this.server = new WebSocketServer({
          host: this.listenIp,
          port: this.listenPort,
        });
      }
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
            networkName: this.ifacNetname ?? undefined,
            passphrase: this.ifacNetkey ?? undefined,
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
    // `ws` does not close an HTTPS server it did not create; close the one we
    // made for TLS termination ourselves.
    const tlsServer = this.tlsServer;
    if (tlsServer) {
      await new Promise((resolve) => tlsServer.close(resolve));
      this.tlsServer = null;
    }
    await Promise.all(
      Array.from(this.spawnedInterfaces).map((client) => client.disconnect()),
    );
    this.spawnedInterfaces.clear();
    this.online = false;
  }
}
