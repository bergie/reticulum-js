import { randomBytes } from "node:crypto";
import http from "node:http";
import { Packet } from "../core/packet.js";
import { base64ToBytes, bytesToBase64 } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface } from "./base.js";

/**
 * @file http_server.js
 * @description HTTP POST exchange server (Node.js) — a drop-in replacement for
 *   the third-party Reticulum-post PHP router.
 *
 * This module is Node-only (`node:http` + `node:crypto`); it is kept separate
 * from `http.js` so the {@link HttpPostClientInterface} stays platform-neutral
 * and importable in non-Node runtimes.
 *
 * The server is the server-side half of the HTTP exchange protocol documented
 * in `http.js`. For each registered remote client it spawns an
 * {@link HttpPostPeerInterface} and emits it via the `connection` event, so a
 * `Reticulum`/`TransportCore` can attach it like any other interface. Per-peer
 * outbound queues hold packets the local Transport routes toward a peer until
 * its next `/exchange` poll drains them.
 */

/**
 * @typedef {Object} HttpPostPeerInterfaceOptions
 * @property {string} interfaceId - Opaque id minted by the server at register.
 * @property {string} sessionToken - Opaque token minted by the server.
 * @property {string} [name] - Interface name (defaults from interfaceId).
 * @property {number} [ifacSize] - Optional IFAC field size (reserved for the
 *   future IFAC name + passphrase enhancement; not yet applied).
 */

/**
 * The server-side half of an HTTP exchange virtual link.
 *
 * Spawned by {@link HttpPostServerInterface} for each registered remote client.
 * Its `readable` is fed from `/exchange` POST bodies (packets the remote client
 * uploaded) and its `writable` collects packets the local Transport routes
 * toward this peer; those are drained into the next `/exchange` response.
 *
 * This is an internal class — it is not registered in the interface registry.
 * @extends Interface
 */
export class HttpPostPeerInterface extends Interface {
  /**
   * Creates a server-side peer.
   * @param {HttpPostPeerInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.interfaceId = options.interfaceId;
    this.sessionToken = options.sessionToken;
    this.name = options.name || `http-peer-${options.interfaceId.slice(0, 8)}`;
    this.ifacSize = options.ifacSize || 0;
    /**
     * Nominal bitrate, overwritten by the parent
     * {@link HttpPostServerInterface} at spawn time. Defaults to 1 Mbit/s
     * matching the client default.
     * @type {number}
     */
    this.bitrate = 1000000;

    /** @type {Uint8Array[]} packets queued for delivery to the remote client */
    this._outboundQueue = [];
    /** @type {number} */
    this._deliverySeq = 0;
    /** @type {number} */
    this.lastSeen = Date.now();

    /** @type {boolean} */
    this.online = false;
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {any} */
    this._inboundController = null;
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
   * Sets up the inbound/outbound streams and marks the peer online. There is
   * no network to dial — the peer is driven by the server's `/exchange`
   * handler.
   * @returns {Promise<void>}
   */
  async connect() {
    this._readable = new ReadableStream({
      start: (controller) => {
        this._inboundController = controller;
      },
      cancel: () => {
        this._inboundController = null;
      },
    });
    this._writable = new WritableStream({
      write: (/** @type {import("../core/packet.js").Packet} */ packet) => {
        this._outboundQueue.push(packet.serialize());
      },
    });
    this.online = true;
    this._loopPromise = this._startInboundLoop();
  }

  /**
   * Tears down the peer. Closing the inbound controller ends the inbound loop
   * and dispatches `closed`, so an attached Transport removes the interface.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.online = false;
    if (this._inboundController) {
      try {
        this._inboundController.close();
      } catch (_e) {
        // already closed/errored
      }
      this._inboundController = null;
    }
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * Feeds packets uploaded by the remote client (base64 strings from a
   * `/exchange` request body) into the inbound stream.
   * @param {string[]} packetsBase64
   */
  ingest(packetsBase64) {
    this.touch();
    for (const entry of packetsBase64) {
      if (typeof entry !== "string" || entry === "") continue;
      try {
        const packet = Packet.deserialize(base64ToBytes(entry));
        if (this._inboundController) {
          this._inboundController.enqueue(packet);
        }
      } catch (/** @type {any} */ e) {
        log(
          "HttpExchange",
          `Peer failed to parse incoming packet: ${e.message}`,
          LogLevel.WARN,
        );
      }
    }
  }

  /**
   * Drains up to `maxPackets` queued outbound packets and returns them as
   * base64, with a delivery batch id when non-empty.
   *
   * Delivery is **once**: the queue is spliced, never redelivered (per the v1
   * reliability decision). The batch id is generated so wire-compatible
   * clients that ack batches keep working, but unacked batches are not resent.
   * @param {number} maxPackets
   * @returns {{ packets: string[], batchId: string | null }}
   */
  drainOutbound(maxPackets) {
    this.touch();
    const count = Math.max(0, Math.min(maxPackets, this._outboundQueue.length));
    if (count === 0) return { packets: [], batchId: null };
    const drained = this._outboundQueue.splice(0, count);
    const batchId = `srv-${this.interfaceId.slice(0, 8)}-${++this
      ._deliverySeq}`;
    return { packets: drained.map((b) => bytesToBase64(b)), batchId };
  }

  /** Updates the last-seen timestamp; called on every `/exchange`. */
  touch() {
    this.lastSeen = Date.now();
  }

  /**
   * Reads packets from the inbound stream and dispatches them.
   * @private
   */
  async _startInboundLoop() {
    if (!this._readable) return;
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
 * @typedef {Object} HttpPostServerInterfaceOptions
 * @property {number} listenPort - TCP port to listen on.
 * @property {string} [listenIp="0.0.0.0"] - Address to bind the listener to.
 * @property {string} [name] - Interface name.
 * @property {number} [idleExchangeIntervalMs=1000] - Poll interval advertised
 *   to clients via `idle_exchange_interval_ms`.
 * @property {number} [peerIdleTimeoutMs=60000] - Registered peers idle longer
 *   than this (no `/exchange` within the window) are reaped.
 * @property {number} [maxBatchPackets=64] - Maximum packets delivered per
 *   exchange response.
 * @property {number} [maxPacketBytes=500] - Maximum packet size advertised to
 *   clients.
 * @property {number} [ifacSize=0] - Optional IFAC field size (reserved).
 */

/**
 * Reticulum interface that listens for inbound HTTP POST exchange clients.
 *
 * A Node.js replacement for the third-party Reticulum-post PHP router: a full
 * backbone whose HTTP adapter lets polling clients attach as interfaces. For
 * each registered client it spawns an {@link HttpPostPeerInterface} and emits
 * it via the `connection` event (the same mechanism
 * `Reticulum.addInterface()` consumes), mirroring {@link TCPServerInterface}.
 *
 * Because we are a long-lived process with an in-memory Transport, we shed the
 * PHP router's SQLite complexity: path state lives in `TransportCore` and
 * per-peer queues live in memory on each spawned peer.
 * @extends Interface
 */
export class HttpPostServerInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link HttpPostServerInterface} constructor.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "HTTP POST Server Interface",
      description:
        "Node.js replacement for the third-party Reticulum-post PHP router. " +
        "Listens for inbound HTTP exchange clients and spawns a peer " +
        "interface per registered client. Non-canonical: no Python " +
        "reference equivalent.",
      properties: {
        ...base.properties,
        listenIp: {
          type: "string",
          default: "0.0.0.0",
          examples: ["0.0.0.0", "127.0.0.1"],
          description: "Address to bind the HTTP listener to.",
        },
        listenPort: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          examples: [8080],
          description: "TCP port to listen on.",
        },
        idleExchangeIntervalMs: {
          type: "integer",
          minimum: 100,
          default: 1000,
          description: "Poll interval advertised to clients.",
        },
        peerIdleTimeoutMs: {
          type: "integer",
          minimum: 100,
          default: 60000,
          description:
            "Registered peers idle longer than this are reaped (ms).",
        },
        maxBatchPackets: {
          type: "integer",
          minimum: 1,
          default: 64,
          description: "Maximum packets delivered per exchange.",
        },
      },
      required: ["listenPort"],
      additionalProperties: false,
    };
  }

  /**
   * Creates an HTTP POST server interface.
   * @param {HttpPostServerInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.listenIp = options.listenIp || "0.0.0.0";
    this.listenPort = options.listenPort;
    this.name =
      options.name || `http-server-${this.listenIp}:${this.listenPort}`;
    this.ifacSize = options.ifacSize || 0;
    /**
     * Nominal bitrate, inherited by spawned peer interfaces. JS-specific (no
     * Python equivalent); HTTP exchange is request/response with base64/JSON
     * framing, so we assume a conservative 1 Mbit/s matching the client
     * default.
     * @type {number}
     */
    this.bitrate = 1000000;
    this.idleExchangeIntervalMs = options.idleExchangeIntervalMs ?? 1000;
    this.peerIdleTimeoutMs = options.peerIdleTimeoutMs ?? 60000;
    this.maxBatchPackets = options.maxBatchPackets ?? 64;
    this.maxPacketBytes = options.maxPacketBytes ?? 500;

    /** @type {import("node:http").Server | null} */
    this.server = null;
    /** @type {Map<string, HttpPostPeerInterface>} interface_id → peer */
    this.peersById = new Map();
    /** @type {Set<HttpPostPeerInterface>} spawned peers (TCPServer parity) */
    this.spawnedInterfaces = new Set();
    /** @type {Set<import("node:net").Socket>} */
    this._sockets = new Set();
    /** @type {ReturnType<typeof setInterval> | null} */
    this._reaperTimer = null;
    /** @type {boolean} */
    this.online = false;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.online;
  }

  /** Number of currently registered clients. */
  get clients() {
    return this.peersById.size;
  }

  /** @returns {any} */
  get readable() {
    throw new Error("HttpPostServerInterface.readable is not implemented");
  }

  /** @returns {any} */
  get writable() {
    throw new Error("HttpPostServerInterface.writable is not implemented");
  }

  /**
   * Starts the HTTP listener and the idle-peer reaper.
   * @returns {Promise<void>}
   */
  async connect() {
    const server = http.createServer((req, res) => {
      this._handleRequest(req, res);
    });
    this.server = server;
    server.on("connection", (/** @type {any} */ socket) => {
      this._sockets.add(socket);
      socket.on("close", () => this._sockets.delete(socket));
    });
    server.on("error", (/** @type {any} */ err) => {
      this.dispatchEvent(new CustomEvent("error", { detail: err }));
    });

    await /** @type {Promise<void>} */ (
      new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(this.listenPort, this.listenIp, () => {
          this.online = true;
          this.dispatchEvent(
            new CustomEvent("connected", {
              detail: {
                listenIp: this.listenIp,
                listenPort: this.listenPort,
              },
            }),
          );
          resolve();
        });
      })
    );

    // Reap idle peers roughly every timeout/2 (floored so short timeouts still
    // poll reasonably often).
    const interval = Math.max(500, Math.floor(this.peerIdleTimeoutMs / 2));
    this._reaperTimer = setInterval(() => this._reap(), interval);
    log(
      "HttpExchange",
      `HTTP server listening on ${this.listenIp}:${this.listenPort}`,
      LogLevel.LOG,
    );
  }

  /**
   * Closes the HTTP server, disconnects all spawned peers, and stops the
   * reaper.
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this._reaperTimer) {
      clearInterval(this._reaperTimer);
      this._reaperTimer = null;
    }
    const peers = Array.from(this.peersById.values());
    this.peersById.clear();
    this.spawnedInterfaces.clear();
    await Promise.all(peers.map((peer) => peer.disconnect()));
    if (this.server) {
      const server = this.server;
      for (const socket of this._sockets) {
        try {
          socket.destroy();
        } catch (_e) {
          // ignore
        }
      }
      this._sockets.clear();
      await /** @type {Promise<void>} */ (
        new Promise((resolve) => server.close(() => resolve()))
      );
      this.server = null;
    }
    this.online = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  // ---- Request handling ----

  /**
   * Routes an inbound HTTP request to the register/exchange handlers.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @private
   */
  async _handleRequest(req, res) {
    let body = "";
    try {
      for await (const chunk of req) body += chunk;
    } catch (_e) {
      // client disconnected mid-body; nothing to respond to
      return;
    }
    /** @type {Record<string, any>} */
    let json = {};
    try {
      json = body ? JSON.parse(body) : {};
    } catch (_e) {
      // malformed JSON → treat as empty body
    }

    try {
      if (req.method === "POST" && req.url === "/v1/interfaces/register") {
        await this._handleRegister(json, res);
        return;
      }
      if (req.method === "POST" && req.url === "/v1/interfaces/exchange") {
        this._handleExchange(json, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (/** @type {any} */ err) {
      log(
        "HttpExchange",
        `Server request error: ${err.message}`,
        LogLevel.ERROR,
      );
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  }

  /**
   * Handles `POST /v1/interfaces/register`: mints credentials, spawns a peer,
   * emits `connection`, and responds with the credentials + limits.
   * @param {Record<string, any>} json
   * @param {import("node:http").ServerResponse} res
   * @private
   */
  async _handleRegister(json, res) {
    const interfaceId = `iface-${randomBytes(8).toString("hex")}`;
    const sessionToken = `sess-${randomBytes(16).toString("hex")}`;
    const peer = new HttpPostPeerInterface({
      interfaceId,
      sessionToken,
      name: typeof json.name === "string" && json.name ? json.name : undefined,
      ifacSize: this.ifacSize,
    });
    // Inherit the server's nominal bitrate.
    peer.bitrate = this.bitrate;
    // connect() is synchronous through stream setup, so writable is ready
    // before the `connection` event fires.
    await peer.connect();
    this.peersById.set(interfaceId, peer);
    this.spawnedInterfaces.add(peer);
    log(
      "HttpExchange",
      `Registered peer ${interfaceId.slice(0, 8)}... ("${peer.name}")`,
      LogLevel.LOG,
    );
    this.dispatchEvent(new CustomEvent("connection", { detail: peer }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        interface_id: interfaceId,
        session_token: sessionToken,
        max_batch_packets: this.maxBatchPackets,
        max_packet_bytes: this.maxPacketBytes,
        idle_exchange_interval_ms: this.idleExchangeIntervalMs,
      }),
    );
  }

  /**
   * Handles `POST /v1/interfaces/exchange`: authenticates the peer, ingests
   * uploaded packets, and drains queued outbound packets into the response.
   *
   * `ack_batch_ids` are accepted but, in v1 deliver-once mode, not acted upon.
   * @param {Record<string, any>} json
   * @param {import("node:http").ServerResponse} res
   * @private
   */
  _handleExchange(json, res) {
    const peer = this.peersById.get(json.interface_id);
    if (!peer || peer.sessionToken !== json.session_token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid interface credentials" }));
      return;
    }
    peer.touch();

    const posted = Array.isArray(json.packets) ? json.packets : [];
    peer.ingest(posted);

    const requestCap =
      typeof json.max_packets === "number"
        ? json.max_packets
        : this.maxBatchPackets;
    const limit = Math.min(requestCap, this.maxBatchPackets);
    const { packets, batchId } = peer.drainOutbound(limit);

    /** @type {Record<string, any>} */
    const resp = {
      delivery_packets: packets,
      idle_exchange_interval_ms: this.idleExchangeIntervalMs,
    };
    if (batchId) resp.delivery_batch_id = batchId;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(resp));
  }

  /**
   * Removes peers that have not exchanged within `peerIdleTimeoutMs`.
   * Disconnecting a peer closes its inbound controller → `closed` event → an
   * attached Transport removes it.
   * @private
   */
  _reap() {
    const now = Date.now();
    for (const peer of Array.from(this.peersById.values())) {
      if (now - peer.lastSeen > this.peerIdleTimeoutMs) {
        log(
          "HttpExchange",
          `Reaping idle peer ${peer.interfaceId.slice(0, 8)}...`,
          LogLevel.LOG,
        );
        this.peersById.delete(peer.interfaceId);
        this.spawnedInterfaces.delete(peer);
        peer.disconnect();
      }
    }
  }
}
