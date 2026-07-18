import { Packet } from "../core/packet.js";
import { base64ToBytes, bytesToBase64 } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface } from "./base.js";

/**
 * @file http.js
 * @description HTTP POST exchange interface (client + Node.js server)
 *
 * A non-canonical transport: the Python reference RNS has no HTTP interface.
 * This implements the HTTP exchange protocol used by the third-party
 * "Reticulum-post" project, where a client and a router exchange batches of
 * raw RNS packets over plain HTTP POST requests. Packets are carried as
 * base64-encoded strings inside JSON; no HDLC (0x7E) framing or byte-stuffing
 * is applied, exactly like the {@link WebSocketClientInterface}.
 *
 * The protocol has two endpoints:
 *   - `POST /v1/interfaces/register`  → obtain `interface_id` + `session_token`
 *   - `POST /v1/interfaces/exchange`  → upload queued packets, receive delivery
 *
 * The client side is platform-neutral (WinterTC `fetch`); the server side is
 * Node.js (`node:http`) and is a drop-in replacement for the PHP router.
 */

/**
 * @typedef {Object} HttpPostClientInterfaceOptions
 * @property {string} baseUrl - Base URL of the HTTP exchange server, e.g.
 *   `https://node.example.com/reticulum`. A trailing slash is stripped.
 * @property {string} [name] - Interface name. A descriptive name is generated
 *   from `baseUrl` if omitted.
 * @property {number} [pollIntervalMs] - Initial poll interval in milliseconds.
 *   The server may adapt this via `idle_exchange_interval_ms`. Defaults to
 *   1000.
 * @property {number} [bitrate] - Interface bitrate reported at registration.
 *   Defaults to 1000000.
 * @property {number} [mtu] - Interface MTU reported at registration. Defaults
 *   to 500 (the Reticulum default).
 * @property {number} [maxBatchPackets] - Maximum packets sent per exchange.
 *   Defaults to 64; the server may lower it.
 * @property {number} [ifacSize] - Optional IFAC field size. Reserved for the
 *   future IFAC name + passphrase enhancement; not yet applied.
 */

/**
 * Reticulum interface that connects to a remote node over an HTTP POST
 * exchange.
 *
 * Operates in **pull-poll** mode: the client initiates every exchange, POSTing
 * queued outbound packets and receiving any queued inbound packets in the HTTP
 * response. This works through NAT, firewalls and proxies and needs no open
 * ports on the client.
 *
 * The poll model is bridged into RNS Web Streams: outbound `Packet`s written to
 * {@link HttpPostClientInterface#writable} are serialized and queued; an
 * adaptive poll loop drains the queue over `POST /exchange`, and delivery
 * packets from the response are deserialized and pushed onto
 * {@link HttpPostClientInterface#readable}.
 * @extends Interface
 */
export class HttpPostClientInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link HttpPostClientInterface} constructor.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "HTTP POST Client Interface",
      description:
        "Connects to a remote Reticulum node over an HTTP POST exchange " +
        "(pull-poll). Non-canonical: there is no Python reference " +
        "equivalent. Compatible with the third-party Reticulum-post router.",
      properties: {
        ...base.properties,
        baseUrl: {
          type: "string",
          format: "uri",
          description:
            "Base URL of the HTTP exchange server, e.g. " +
            "https://node.example.com/reticulum.",
          examples: ["https://node.example.com/reticulum"],
        },
        pollIntervalMs: {
          type: "integer",
          minimum: 100,
          default: 1000,
          description:
            "Initial poll interval in milliseconds. The server may adapt it " +
            "via idle_exchange_interval_ms.",
        },
        bitrate: {
          type: "integer",
          default: 1000000,
          description: "Interface bitrate reported at registration.",
        },
        mtu: {
          type: "integer",
          default: 500,
          description: "Interface MTU reported at registration.",
        },
        maxBatchPackets: {
          type: "integer",
          minimum: 1,
          default: 64,
          description: "Maximum packets sent per exchange.",
        },
      },
      required: ["baseUrl"],
      additionalProperties: false,
    };
  }

  /**
   * Creates an HTTP POST client interface.
   * @param {HttpPostClientInterfaceOptions} options
   */
  constructor(options) {
    super();
    this.baseUrl = (options.baseUrl || "").replace(/\/$/, "");
    this.name =
      options.name || `http-client-${this.baseUrl.replace(/^https?:\/\//, "")}`;
    this.bitrate = options.bitrate ?? 1000000;
    this.mtu = options.mtu ?? 500;
    this.ifacSize = options.ifacSize || 0;
    this._maxBatchPackets = options.maxBatchPackets ?? 64;
    this._pollIntervalMs = options.pollIntervalMs ?? 1000;

    /** @type {string | null} */
    this._interfaceId = null;
    /** @type {string | null} */
    this._sessionToken = null;

    /** @type {Uint8Array[]} queued raw outbound packets */
    this._outboundQueue = [];
    /** @type {string[]} delivery batch ids awaiting acknowledgement */
    this._pendingAckIds = [];
    /** @type {number} */
    this._batchSeq = 0;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._pollTimer = null;
    /** @type {boolean} */
    this._polling = false;
    /** @type {boolean} */
    this._running = false;
    /** @type {boolean} */
    this.online = false;

    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {import("node:stream/web").ReadableStreamDefaultController | null} */
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

  /** Whether the interface holds valid registration credentials. */
  get isRegistered() {
    return this._interfaceId !== null && this._sessionToken !== null;
  }

  /**
   * Registers with the server and starts the exchange poll loop.
   * @returns {Promise<void>}
   */
  async connect() {
    this._running = true;
    this._setupStreams();
    try {
      await this._register();
    } catch (/** @type {any} */ e) {
      this._running = false;
      throw e;
    }
    this.online = true;
    this.dispatchEvent(
      new CustomEvent("connected", { detail: { baseUrl: this.baseUrl } }),
    );
    log(
      "HttpExchange",
      `Registered with ${this.baseUrl}; polling every ${this._pollIntervalMs}ms`,
      LogLevel.LOG,
    );
    // Kick off the poll loop (fire-and-forget; errors are handled inside).
    this._poll();
  }

  /**
   * Stops the poll loop and tears down the interface.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._running = false;
    this.online = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    // Closing the inbound controller ends the inbound loop → `closed` event.
    if (this._inboundController) {
      try {
        this._inboundController.close();
      } catch (_e) {
        // already closed/errored
      }
      this._inboundController = null;
    }
    this._interfaceId = null;
    this._sessionToken = null;
    this.dispatchEvent(
      new CustomEvent("disconnected", { detail: { baseUrl: this.baseUrl } }),
    );
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  // ---- Registration ----

  /**
   * Registers the interface with the server, storing the returned credentials
   * and limits.
   * @private
   */
  async _register() {
    log(
      "HttpExchange",
      `Registering "${this.name}" with ${this.baseUrl}...`,
      LogLevel.LOG,
    );
    const resp = await this._post("/v1/interfaces/register", {
      name: this.name,
      bitrate: this.bitrate,
      mtu: this.mtu,
      metadata: {
        client: "reticulum-js",
        transport: "http-exchange",
        implementation: "HttpPostClientInterface",
      },
    });
    this._interfaceId = resp.interface_id;
    this._sessionToken = resp.session_token;
    if (typeof resp.max_batch_packets === "number") {
      this._maxBatchPackets = resp.max_batch_packets;
    }
    if (typeof resp.idle_exchange_interval_ms === "number") {
      this._pollIntervalMs = resp.idle_exchange_interval_ms;
    }
  }

  // ---- Streams ----

  /**
   * Creates the inbound/outbound Web Streams and starts the inbound loop.
   * @private
   */
  _setupStreams() {
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
        this._pushOutbound(packet);
      },
    });

    this._loopPromise = this._startInboundLoop();
  }

  /**
   * Serializes a packet and queues it for the next exchange, then triggers an
   * immediate exchange when idle so latency stays low.
   * @param {import("../core/packet.js").Packet} packet
   * @private
   */
  _pushOutbound(packet) {
    this._outboundQueue.push(packet.serialize());
    this._triggerSend();
  }

  /**
   * If idle, cancels the pending poll timer and exchanges immediately so a
   * just-queued packet leaves without waiting for the next tick.
   * @private
   */
  _triggerSend() {
    if (!this._running || this._polling) return;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._poll();
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

  // ---- Exchange loop ----

  /**
   * Performs one exchange cycle, then reschedules itself. Handles transient
   * failures and re-registers on auth errors.
   * @private
   */
  async _poll() {
    if (!this._running) return;
    this._polling = true;
    try {
      await this._doExchange();
    } catch (/** @type {any} */ err) {
      log("HttpExchange", `Exchange failed: ${err.message}`, LogLevel.WARN);
      if (
        err.status === 401 ||
        /Invalid interface credentials/i.test(err.message)
      ) {
        log("HttpExchange", "Re-registering after auth failure", LogLevel.LOG);
        this._interfaceId = null;
        this._sessionToken = null;
        try {
          await this._register();
        } catch (/** @type {any} */ regErr) {
          log(
            "HttpExchange",
            `Re-registration failed: ${regErr.message}`,
            LogLevel.ERROR,
          );
        }
      }
    }
    this._polling = false;
    if (!this._running) return;
    // If packets arrived during the exchange, poll again immediately instead
    // of waiting the full idle interval.
    const delay = this._outboundQueue.length > 0 ? 0 : this._pollIntervalMs;
    this._pollTimer = setTimeout(() => this._poll(), delay);
  }

  /**
   * Drains the outbound queue into one POST and feeds any delivery packets
   * into the inbound stream.
   * @private
   */
  async _doExchange() {
    if (!this.isRegistered) return;

    const packets = this._outboundQueue.splice(0, this._maxBatchPackets);
    const ackIds = this._pendingAckIds.splice(0);

    /** @type {Record<string, any>} */
    const body = {
      interface_id: this._interfaceId,
      session_token: this._sessionToken,
      ack_batch_ids: ackIds,
      max_packets: this._maxBatchPackets,
      packets: packets.map((p) => bytesToBase64(p)),
    };
    if (packets.length > 0) {
      body.batch_id = `js-${Date.now()}-${++this._batchSeq}`;
    }

    const resp = await this._post("/v1/interfaces/exchange", body);

    const delivery = resp.delivery_packets || [];
    const deliveryBatchId = resp.delivery_batch_id || null;
    for (const entry of delivery) {
      if (typeof entry !== "string" || entry === "") continue;
      try {
        const packet = Packet.deserialize(base64ToBytes(entry));
        if (this._inboundController) {
          this._inboundController.enqueue(packet);
        }
      } catch (/** @type {any} */ e) {
        log(
          "HttpExchange",
          `Failed to parse incoming packet: ${e.message}`,
          LogLevel.WARN,
        );
      }
    }
    if (delivery.length > 0 && deliveryBatchId) {
      this._pendingAckIds.push(deliveryBatchId);
    }

    // Honor an adaptive poll interval from the server.
    if (
      typeof resp.idle_exchange_interval_ms === "number" &&
      resp.idle_exchange_interval_ms !== this._pollIntervalMs
    ) {
      this._pollIntervalMs = resp.idle_exchange_interval_ms;
      log(
        "HttpExchange",
        `Adaptive poll interval now ${this._pollIntervalMs}ms`,
        LogLevel.DEBUG,
      );
    }
  }

  // ---- HTTP helper ----

  /**
   * POSTs a JSON body to `path` under `baseUrl` and returns the parsed JSON
   * response. Non-2xx responses are thrown with a `.status` property.
   * @param {string} path
   * @param {Record<string, any>} body
   * @returns {Promise<any>}
   * @private
   */
  async _post(path, body) {
    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      /** @type {any} */
      (err).status = resp.status;
      throw err;
    }
    return resp.json();
  }
}
