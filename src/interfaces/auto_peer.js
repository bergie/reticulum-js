/**
 * @file auto_peer.js
 * @description Per-peer data interface spawned by {@link AutoInterface} for each
 *   discovered peer — the JS port of the Python reference
 *   `RNS/Interfaces/AutoInterface.AutoInterfacePeer`.
 *
 * One RNS packet per UDP datagram, **no KISS/HDLC framing** (unlike the
 * TCP/WebSocket interfaces). So this peer serializes/deserializes `Packet`
 * objects directly against the parent's per-interface data socket, bypassing
 * `framer.js` entirely. Outbound packets written to its `writable` are
 * serialized and sent to the peer's (scoped) link-local address on the data
 * port; inbound datagrams routed from the parent's data socket are
 * deserialized, de-duplicated against the parent's shared deque, and dispatched
 * as `"packet"` events.
 */
import { Identity } from "../core/identity.js";
import { Packet } from "../core/packet.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface } from "./base.js";

/**
 * @typedef {Object} AutoInterfacePeerOptions
 * @property {import("./auto.js").AutoInterface} parent - The owning
 *   AutoInterface; owns the shared data sockets and the dedup deque.
 * @property {string} address - The peer's descope'd (no `%scope`) link-local
 *   address. Used both as the peer identity and (re-scoped) as the send
 *   destination.
 * @property {string} ifname - The local interface the peer was discovered on.
 *   Outbound datagrams are sent from that interface's data socket and scoped
 *   with `%ifname`.
 * @property {string} [name] - Interface name (defaults from address/ifname).
 */

/**
 * One discovered peer's data interface.
 *
 * Lifecycle: created by {@link AutoInterface#addPeer} on first authenticated
 * discovery, `connect()`ed (which sets up the inbound/outbound streams), and
 * registered with the transport. `disconnect()` closes its inbound stream,
 * which ends the inbound loop and dispatches `"closed"` so an attached
 * transport removes it.
 * @extends Interface
 */
export class AutoInterfacePeer extends Interface {
  /**
   * Creates a peer data interface. Streams are opened by {@link connect}.
   * @param {AutoInterfacePeerOptions} options
   */
  constructor(options) {
    super();
    this.parentInterface = options.parent;
    this.address = options.address;
    this.ifname = options.ifname;
    this.name = options.name || `auto-peer-${this.ifname}/${this.address}`;
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {any} */
    this._inboundController = null;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
    this.online = false;
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
   * Sets up the inbound/outbound streams and marks the peer online. There is no
   * socket to dial here — the parent's data socket drives inbound, and outbound
   * rides the parent's data socket too.
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
      write: (/** @type {Packet} */ packet) => this._processOutgoing(packet),
    });
    this.online = true;
    this._loopPromise = this._startInboundLoop();
  }

  /**
   * Tears down the peer. Closing the inbound controller ends the inbound loop
   * and dispatches `"closed"`, so an attached transport removes the interface.
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
   * Handles an inbound datagram routed from the parent's data socket: computes
   * its hash, drops it if the parent's multi-interface dedup deque already saw
   * it recently, refreshes the peer, deserializes it, and enqueues the packet
   * for the inbound loop to dispatch.
   *
   * Mirrors Python's `AutoInterfacePeer.process_incoming`. The raw bytes are
   * hashed for dedup (matching `RNS.Identity.full_hash(data)`) and deserialized
   * directly — no KISS unframing.
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async processIncoming(data) {
    if (!this.online || !this.parentInterface.online) return;

    const hash = await Identity.fullHash(data);
    if (this.parentInterface._isDuplicate(hash)) return;

    this.parentInterface.refreshPeer(this.address);

    let packet;
    try {
      packet = Packet.deserialize(data);
    } catch (/** @type {any} */ e) {
      log(
        "AutoInterface",
        `${this} failed to parse incoming packet: ${e.message}`,
        LogLevel.WARN,
      );
      return;
    }

    if (this._inboundController) {
      this._inboundController.enqueue(packet);
    }
  }

  /**
   * Serializes an outbound packet and sends it to the peer over the parent's
   * data socket for this interface. No KISS framing — one raw RNS packet per
   * datagram, matching Python's `process_outgoing`.
   * @param {Packet} packet
   * @returns {void}
   * @private
   */
  _processOutgoing(packet) {
    if (!this.online) return;
    const data = packet.serialize();
    this.parentInterface._sendData(this.address, this.ifname, data);
  }

  /**
   * Reads packets from the inbound stream and dispatches them as `"packet"`
   * events. Ends with `"closed"` when the stream closes (i.e. on disconnect).
   * @returns {Promise<void>}
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
      try {
        reader.releaseLock();
      } catch (_e) {
        // already released
      }
    }
  }

  /** @returns {string} */
  toString() {
    return `AutoInterfacePeer[${this.ifname}/${this.address}]`;
  }
}
