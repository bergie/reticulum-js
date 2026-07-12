import net from "node:net";
import { Readable, Writable } from "node:stream";
import { Packet } from "../core/packet.js";
import {
  createRNSFramerStream,
  createRNSUnframerStream,
} from "../transport/framer.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface } from "./base.js";

/**
 * @typedef {Object} TCPClientInterfaceOptions
 * @property {string} [host]
 * @property {number} [port]
 * @property {any} [socket]
 * @property {number} [ifacSize]
 * @property {string} [name]
 */

/**
 * @typedef {Object} TCPServerInterfaceOptions
 * @property {number} port
 * @property {number} [ifacSize]
 * @property {string} [name]
 */

/**
 * @extends Interface
 */
export class TCPClientInterface extends Interface {
  /**
   * The underlying socket (if any).
   * @type {import('node:net').Socket | null}
   */
  socket = null;

  /**
   * @param {TCPClientInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.name =
      options.name || `tcp-client-${options.host || ""}:${options.port || ""}`;
    this.host = options.host || "";
    this.port = options.port || 0;
    /** @type {any} */
    this.socket = options.socket || null;
    this.ifacSize = options.ifacSize || 0;
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    this.online = false;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
    /** @type {boolean} */
    this._closed = false;
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
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.socket) {
      this._setupStreams(this.socket);
      this.online = true;
      return;
    }
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(
        { host: this.host, port: this.port },
        () => {
          this._setupStreams(this.socket);
          this.online = true;
          this.dispatchEvent(
            new CustomEvent("connected", {
              detail: { host: this.host, port: this.port },
            }),
          );
          resolve();
        },
      );
      this.socket.on("error", (/** @type {any} */ err) => {
        this.online = false;
        this.dispatchEvent(
          new CustomEvent("disconnected", {
            detail: { host: this.host, port: this.port },
          }),
        );
        reject(err);
      });
    });
  }

  /**
   * @returns {Promise<void>}
   */
  async disconnect() {
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
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * @param {any} socket
   * @private
   */
  _setupStreams(socket) {
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
      createRNSUnframerStream(Packet, this.ifacSize),
    );

    const framer = createRNSFramerStream();

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
 * @extends Interface
 */
export class TCPServerInterface extends Interface {
  /**
   * @param {TCPServerInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.name = options.name || `tcp-server-${options.port}`;
    this.port = options.port;
    this.ifacSize = options.ifacSize || 0;
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
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(async (/** @type {any} */ socket) => {
        const client = new TCPClientInterface({
          socket,
          ifacSize: this.ifacSize,
          name: `tcp-client-from-server-${socket.remoteAddress}:${socket.remotePort}`,
        });
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
