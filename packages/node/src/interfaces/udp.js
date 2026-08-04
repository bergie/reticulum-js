/**
 * @file udp.js
 * @description UDPInterface — IPv4 broadcast-bus transport (Node.js), porting
 *   the Python reference `RNS/Interfaces/UDPInterface.py`.
 *
 * A single interface that both **receives** (a UDP socket bound to
 * `(listenIp, listenPort)`) and **forwards** (sends raw datagrams to
 * `(forwardIp, forwardPort)`, typically a subnet broadcast address). One raw
 * RNS packet per datagram, **no KISS/HDLC framing** — like the
 * {@link AutoInterfacePeer} data path, so this module serializes/deserializes
 * `Packet` objects directly and bypasses `framer.js`.
 *
 * Every node on the same L2 segment that binds the same port hears every
 * datagram, giving a shared bus without any per-peer spawning (contrast
 * {@link AutoInterface}, which discovers peers individually over IPv6
 * multicast). `port` is shorthand for both `listenPort` and `forwardPort`;
 * `device` (e.g. `eth0`) resolves the IPv4 broadcast address via
 * {@link getBroadcastForInterface} for both halves when they aren't given
 * explicitly.
 */

/* @ts-self-types="../../../node/types/src/interfaces/udp.d.ts" */

import dgram from "node:dgram";
import { Packet } from "@reticulum/core/src/core/packet.js";
import { Interface } from "@reticulum/core/src/interfaces/base.js";
import { LogLevel, log } from "@reticulum/core/src/utils/log.js";
import { getBroadcastForInterface } from "../utils/netinfo.js";

/**
 * Nominal bitrate guess, mirroring `UDPInterface.BITRATE_GUESS`
 * (10 Mbit/s) in the Python reference.
 */
const BITRATE_GUESS = 10 * 1000 * 1000;

/**
 * Hardware MTU, mirroring `self.HW_MTU = 1064` in the Python reference. The
 * current JS transport does not yet read it (it mirrors the Python reference's
 * own MTU-optimization knobs, which are themselves not yet ported); it is kept
 * here for parity and to document the medium's maximum packet size.
 */
const HW_MTU = 1064;

/**
 * @typedef {Object} UDPInterfaceOptions
 * @property {string} [name] - Human-readable interface name.
 * @property {string} [device] - Network device name (e.g. `eth0`). When set,
 *   the IPv4 broadcast address for that device is used as the default for both
 *   `listenIp` and `forwardIp` (Python config key: device).
 * @property {number} [port] - Shorthand port. When set, seeds `listenPort` and
 *   `forwardPort` if those aren't given explicitly (Python config key: port).
 * @property {string} [listenIp] - Address to bind the receiving socket to. May
 *   be a subnet broadcast address (resolved from `device`) or `0.0.0.0`
 *   (Python config key: listen_ip).
 * @property {number} [listenPort] - Port to bind the receiving socket to
 *   (Python config key: listen_port).
 * @property {string} [forwardIp] - Destination address for outbound datagrams,
 *   typically a subnet broadcast address (Python config key: forward_ip).
 * @property {number} [forwardPort] - Destination port for outbound datagrams
 *   (Python config key: forward_port).
 * @property {number} [ifacSize] - IFAC size in bytes (0 disables; v1 runs with
 *   IFAC disabled, matching the common case).
 * @property {string} [networkName] - Shared IFAC network name (`ifac_netname`).
 * @property {string} [passphrase] - Shared IFAC passphrase (`ifac_netkey`).
 * @property {number} [configuredBitrate] - Override the default bitrate guess.
 */

/**
 * IPv4 broadcast-bus UDP interface.
 *
 * Lifecycle: constructed with the listen/forward configuration (with `device`/
 * `port` shorthand resolution), then `connect()` binds the receive socket
 * (when listening) and the send socket (when forwarding), sets up the
 * inbound/outbound streams, marks the interface online, and dispatches
 * `"connected"`. `disconnect()` closes both sockets and dispatches `"closed"`.
 *
 * An instance may be receive-only (only `listenIp`/`listenPort`), forward-only
 * (only `forwardIp`/`forwardPort`), or both (the common broadcast case).
 * `writable` is `null` when not forwarding, so the transport simply won't
 * transmit out of a receive-only instance.
 * @extends Interface
 */
export class UDPInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link UDPInterface} constructor, for dynamically-generated setup UIs.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "UDP Interface",
      description:
        "IPv4 broadcast-bus transport. Binds a UDP socket to receive and " +
        "sends raw datagrams (one RNS packet each, no framing) to a " +
        "broadcast or unicast destination. Mirrors the Python reference " +
        "UDPInterface.",
      properties: {
        ...base.properties,
        device: {
          type: "string",
          examples: ["eth0", "wlan0"],
          description:
            "Network device name. When set, its IPv4 broadcast address is " +
            "used as the default for both listenIp and forwardIp (Python " +
            "config key: device).",
        },
        port: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description:
            "Shorthand port. When set, seeds listenPort and forwardPort " +
            "when those aren't given explicitly (Python config key: port).",
        },
        listenIp: {
          type: "string",
          examples: ["0.0.0.0", "192.168.1.255"],
          description:
            "Address to bind the receiving socket to. May be a subnet " +
            "broadcast address (resolved from device) or 0.0.0.0 for all " +
            "interfaces (Python config key: listen_ip).",
        },
        listenPort: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description:
            "Port to bind the receiving socket to (Python config key: " +
            "listen_port).",
        },
        forwardIp: {
          type: "string",
          examples: ["192.168.1.255", "127.0.0.1"],
          description:
            "Destination address for outbound datagrams, typically a " +
            "subnet broadcast address (Python config key: forward_ip).",
        },
        forwardPort: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description:
            "Destination port for outbound datagrams (Python config key: " +
            "forward_port).",
        },
        configuredBitrate: {
          type: "integer",
          minimum: 0,
          description: "Override the default 10 Mbit/s bitrate guess.",
        },
      },
      required: [],
      additionalProperties: false,
    };
  }

  /**
   * Creates a UDP interface. Sockets are opened by {@link connect}.
   * @param {UDPInterfaceOptions} [options]
   */
  constructor(options = {}) {
    super();
    const port = options.port ?? null;

    // Resolve listen half.
    /** @type {string | null} */
    this.listenIp = options.listenIp ?? null;
    /** @type {number | null} */
    this.listenPort = options.listenPort ?? (port !== null ? port : null);

    // Resolve forward half.
    /** @type {string | null} */
    this.forwardIp = options.forwardIp ?? null;
    /** @type {number | null} */
    this.forwardPort = options.forwardPort ?? (port !== null ? port : null);

    // device → broadcast address for whichever half isn't given explicitly,
    // mirroring Python's `get_broadcast_for_if` fallback.
    if (options.device) {
      const broadcast = getBroadcastForInterface(options.device);
      if (broadcast) {
        if (this.listenIp === null) this.listenIp = broadcast;
        if (this.forwardIp === null) this.forwardIp = broadcast;
      } else {
        log(
          "UDPInterface",
          `${this} could not resolve a broadcast address for device "${options.device}"`,
          LogLevel.WARNING,
        );
      }
    }

    this.name =
      options.name ||
      `udp-${this.listenIp || this.forwardIp || "?"}:${
        this.listenPort || this.forwardPort || "?"
      }`;

    /**
     * Whether this interface receives (a bind was configured).
     * @type {boolean}
     */
    this.receives = this.listenIp !== null && this.listenPort !== null;
    /**
     * Whether this interface forwards (a destination was configured).
     * @type {boolean}
     */
    this.forwards = this.forwardIp !== null && this.forwardPort !== null;

    /**
     * Nominal bitrate. Matches `UDPInterface.BITRATE_GUESS` (10 Mbit/s) in the
     * Python reference.
     * @type {number}
     */
    this.bitrate = options.configuredBitrate ?? BITRATE_GUESS;

    this.ifacSize = options.ifacSize ?? 0;
    /** @type {string|null} */
    this.ifacNetname = options.networkName || null;
    /** @type {string|null} */
    this.ifacNetkey = options.passphrase || null;

    this.online = false;

    // Socket + stream state, opened in connect().
    /** @type {import("node:dgram").Socket | null} */
    this._receiveSocket = null;
    /** @type {import("node:dgram").Socket | null} */
    this._sendSocket = null;
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {any} */
    this._inboundController = null;
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
   * Binds the receive socket (when listening) and the send socket (when
   * forwarding), wires the inbound/outbound streams, marks the interface
   * online, and dispatches `"connected"`.
   *
   * A forward-only interface (no `listenIp`/`listenPort`) has a `null`
   * `readable`; a receive-only interface (no `forwardIp`/`forwardPort`) has a
   * `null` `writable`. Both halves bound when both are configured.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.receives) {
      this._readable = new ReadableStream({
        start: (controller) => {
          this._inboundController = controller;
        },
        cancel: () => {
          this._inboundController = null;
        },
      });

      /** @type {import("node:dgram").Socket} */
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock.on("message", (data) => {
        this._onMessage(data);
      });
      sock.on("error", (/** @type {any} */ err) =>
        this.dispatchEvent(new CustomEvent("error", { detail: err })),
      );
      await this._bind(
        sock,
        /** @type {number} */ (this.listenPort),
        /** @type {string} */ (this.listenIp),
      );
      this._receiveSocket = sock;
      this._loopPromise = this._startInboundLoop();
      log(
        "UDPInterface",
        `${this} receiving on ${this.listenIp}:${this.listenPort}`,
        LogLevel.DEBUG,
      );
    }

    if (this.forwards) {
      // One persistent ephemeral-port socket with SO_BROADCAST set, reused for
      // every send. Functionally identical to Python's per-send fresh socket
      // (same ephemeral source, broadcast enabled) and far fewer sockets.
      // Bound first because Node requires a bound socket for setBroadcast().
      /** @type {import("node:dgram").Socket} */
      const sock = dgram.createSocket({ type: "udp4" });
      sock.on("error", (/** @type {any} */ err) =>
        this.dispatchEvent(new CustomEvent("error", { detail: err })),
      );
      await this._bind(sock);
      sock.setBroadcast(true);
      this._sendSocket = sock;

      this._writable = new WritableStream({
        write: (/** @type {Packet} */ packet) => this._processOutgoing(packet),
        // ^ `_processOutgoing` is async (IFAC seal); the returned promise
        //   signals WritableStream backpressure.
      });
      log(
        "UDPInterface",
        `${this} forwarding to ${this.forwardIp}:${this.forwardPort}`,
        LogLevel.DEBUG,
      );
    }

    this.online = true;
    this.dispatchEvent(
      new CustomEvent("connected", {
        detail: {
          listenIp: this.listenIp,
          listenPort: this.listenPort,
          forwardIp: this.forwardIp,
          forwardPort: this.forwardPort,
        },
      }),
    );
  }

  /**
   * Deserializes an inbound datagram and enqueues it for the inbound loop.
   * Mirrors Python's `process_incoming` (raw bytes, no unframing); the byte
   * counting and `"packet"` dispatch happen in the inbound loop via
   * {@link Interface._dispatchPacket}.
   * @param {Uint8Array} data
   * @private
   */
  async _onMessage(data) {
    if (!this.online) return;
    let packet;
    try {
      const opened = await this._openRaw(data);
      if (!opened) return;
      packet = Packet.deserialize(opened);
    } catch (/** @type {any} */ e) {
      log(
        "UDPInterface",
        `${this} failed to parse incoming packet: ${e.message}`,
        LogLevel.WARNING,
      );
      return;
    }
    if (this._inboundController) {
      this._inboundController.enqueue(packet);
    }
  }

  /**
   * Serializes an outbound packet and sends it to the forward destination.
   * Mirrors Python's `process_outgoing` (raw bytes, one datagram, broadcast
   * socket); byte counting happens in {@link Interface._recordOutbound}.
   * @param {Packet} packet
   * @private
   */
  async _processOutgoing(packet) {
    if (!this.online || !this._sendSocket) return;
    this._recordOutbound(packet);
    let data = packet.serialize();
    data = await this._sealRaw(data);
    this._sendSocket.send(
      data,
      /** @type {number} */ (this.forwardPort),
      /** @type {string} */ (this.forwardIp),
      (/** @type {any} */ err) => {
        if (err) {
          log(
            "UDPInterface",
            `${this} could not transmit to ${this.forwardIp}:${this.forwardPort}: ${err.message}`,
            LogLevel.ERROR,
          );
        }
      },
    );
  }

  /**
   * Reads packets from the inbound stream and dispatches them as `"packet"`
   * events. Ends when the stream closes (i.e. on disconnect).
   * @returns {Promise<void>}
   * @private
   */
  async _startInboundLoop() {
    if (!this._readable) return;
    const reader = this._readable.getReader();
    try {
      while (true) {
        const { value: packet, done } = await reader.read();
        if (done) break;
        this._dispatchPacket(packet);
      }
    } catch (e) {
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
    }
  }

  /**
   * Closes the receive and send sockets, closes the inbound stream, and
   * dispatches `"closed"`.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.online = false;
    const closers = [];
    if (this._receiveSocket) {
      closers.push(this._close(this._receiveSocket));
      this._receiveSocket = null;
    }
    if (this._sendSocket) {
      closers.push(this._close(this._sendSocket));
      this._sendSocket = null;
    }
    if (this._inboundController) {
      try {
        this._inboundController.close();
      } catch (_e) {
        // already closed/errored
      }
      this._inboundController = null;
    }
    await Promise.all(closers);
    if (this._loopPromise) {
      await this._loopPromise;
    }
    this._readable = null;
    this._writable = null;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  /**
   * Binds a socket and resolves on `listening`, rejecting on `error`. With no
   * arguments binds to an ephemeral port on `0.0.0.0` (used for the send
   * socket, mirroring Python's unbound send socket).
   * @param {import("node:dgram").Socket} sock
   * @param {number} [port]
   * @param {string} [address]
   * @returns {Promise<void>}
   * @private
   */
  _bind(sock, port, address) {
    return new Promise((resolve, reject) => {
      const onError = (/** @type {any} */ err) => {
        sock.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        sock.off("error", onError);
        resolve();
      };
      sock.once("error", onError);
      sock.once("listening", onListening);
      if (address !== undefined) sock.bind(port, address);
      else sock.bind();
    });
  }

  /**
   * Closes a socket, resolving once closed (or immediately if already closed).
   * @param {import("node:dgram").Socket} sock
   * @returns {Promise<void>}
   * @private
   */
  _close(sock) {
    return new Promise((resolve) => {
      try {
        sock.once("close", resolve);
        sock.close(() => resolve());
      } catch (_e) {
        resolve();
      }
    });
  }

  /** @returns {string} */
  toString() {
    const where =
      this.listenIp && this.listenPort
        ? `${this.listenIp}:${this.listenPort}`
        : `${this.forwardIp}:${this.forwardPort}`;
    return `UDPInterface[${this.name}/${where}]`;
  }
}

export { HW_MTU };
