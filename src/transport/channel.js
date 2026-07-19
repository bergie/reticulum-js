/**
 * @file channel.js
 * @description Reliable, bi-directional, size-constrained message exchange
 *   over an active {@link import("./link.js").Link}.
 *
 * Ports `RNS/Channel.py` from the Python reference. A `Channel` lets two peers
 * exchange typed `MessageBase` messages for as long as the `Link` is open,
 * with automatic retries, send-window flow control, and in-order / dedup'd
 * delivery. Each message must fit in a single link DATA packet (≤ Channel MDU).
 *
 * The wire unit is an `Envelope`:
 *
 *   `msgtype(2, BE) || sequence(2, BE) || length(2, BE) || data`
 *
 * carried in a link DATA packet with `context = CHANNEL (0x0e)`, Token-encrypted
 * like all link traffic. The receiver re-proves every CHANNEL packet (so the
 * sender gets delivery confirmation) before handing the plaintext to the
 * channel for ordering and dispatch.
 *
 * `Channel` is not constructed directly; obtain one from `link.getChannel()`.
 *
 * Concurrency note: Python guards its rings with `threading.RLock` and serializes
 * sends with `threading.Lock`. JS is single-threaded, so ring mutations are kept
 * synchronous (no `await` inside a critical section) and sends are serialized
 * with a Promise chain (`_sendChain`).
 */

import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";

/**
 * System-reserved message types (>= 0xf000). Applications may not register
 * these; only the library (e.g. the Buffer stream layer) may.
 * @enum {number}
 */
export const SystemMessageTypes = {
  /** `StreamDataMessage` — byte-stream frames (RNS/Buffer.py). */
  SMT_STREAM_DATA: 0xff00,
};

/**
 * ChannelException type codes (`RNS/Channel.py` `CEType`).
 * @enum {number}
 */
export const CEType = {
  ME_NO_MSG_TYPE: 0,
  ME_INVALID_MSG_TYPE: 1,
  ME_NOT_REGISTERED: 2,
  ME_LINK_NOT_READY: 3,
  ME_ALREADY_SENT: 4,
  ME_TOO_BIG: 5,
};

/**
 * Thrown by `Channel` with a {@link CEType} code.
 */
export class ChannelException extends Error {
  /**
   * @param {CEType} ceType
   * @param {string} [message]
   */
  constructor(ceType, message) {
    super(message ?? `Channel error (type ${ceType})`);
    this.name = "ChannelException";
    /** @type {CEType} */
    this.type = ceType;
  }
}

/**
 * Possible states of a sent message (`RNS/Channel.py` `MessageState`).
 * @enum {number}
 */
export const MessageState = {
  MSGSTATE_NEW: 0,
  MSGSTATE_SENT: 1,
  MSGSTATE_DELIVERED: 2,
  MSGSTATE_FAILED: 3,
};

/**
 * Base type for any message sent or received on a Channel.
 *
 * Subclasses MUST set a unique `MSGTYPE` (< `0xf000`; values `>= 0xf000` are
 * system-reserved) and implement {@link pack} / {@link unpack}. The class must
 * also be constructable with no arguments (used to validate registration and to
 * instantiate on receive).
 */
export class MessageBase {
  /**
   * Unique identifier for this message class within a Channel. Must be `< 0xf000`.
   * @type {number|null}
   */
  static MSGTYPE = null;

  /**
   * @returns {Uint8Array} binary representation of the message body.
   */
  pack() {
    throw new Error("MessageBase subclass must implement pack()");
  }

  /**
   * Populate this message from its binary body.
   * @param {Uint8Array} _raw
   */
  unpack(_raw) {
    throw new Error("MessageBase subclass must implement unpack()");
  }
}

/** Envelope header size: msgtype(2) + sequence(2) + length(2). */
const ENVELOPE_HEADER_SIZE = 6;

/**
 * Internal wrapper that carries a message over a channel and tracks its state.
 *
 * On the wire: `msgtype(2) || sequence(2) || length(2) || data`. The `length`
 * field is written for protocol consistency; unpacking slices everything after
 * the 6-byte header (matching the Python reference).
 */
export class Envelope {
  /** @type {MessageBase|null} */
  message = null;
  /** @type {Uint8Array|null} */
  raw = null;
  /** Outlet packet handle returned by {@link ChannelOutletBase#send}. Always `null` until assigned. */
  packet = null;
  /** @type {number} */
  sequence = 0;
  /** @type {ChannelOutletBase|null} */
  outlet = null;
  tries = 0;
  unpacked = false;
  packed = false;
  tracked = false;

  /**
   * @param {object} opts
   * @param {ChannelOutletBase} opts.outlet
   * @param {MessageBase|null} [opts.message]
   * @param {Uint8Array|null} [opts.raw] - received wire bytes (decode path)
   * @param {number} [opts.sequence]
   */
  constructor({ outlet, message = null, raw = null, sequence = 0 }) {
    this.ts = Date.now();
    this.id = Envelope._nextId++;
    this.message = message;
    this.raw = raw;
    this.sequence = sequence;
    this.outlet = outlet;
  }

  static _nextId = 1;

  /**
   * Decode the header + message body from {@link raw}.
   * @param {Map<number, typeof MessageBase>} messageFactories
   * @returns {MessageBase}
   */
  unpack(messageFactories) {
    const raw = /** @type {Uint8Array} */ (this.raw);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const msgtype = dv.getUint16(0, false); // big-endian
    this.sequence = dv.getUint16(2, false);
    // length (bytes 4..6) is informational; the body is everything past the header.
    const body = raw.subarray(ENVELOPE_HEADER_SIZE);
    const ctor = messageFactories.get(msgtype);
    if (!ctor) {
      throw new ChannelException(
        CEType.ME_NOT_REGISTERED,
        `Unable to find constructor for Channel MSGTYPE 0x${msgtype.toString(16)}`,
      );
    }
    const message = new ctor();
    message.unpack(body);
    this.unpacked = true;
    this.message = message;
    return message;
  }

  /**
   * Encode {@link message} into {@link raw} and return the wire bytes.
   * @returns {Uint8Array}
   */
  pack() {
    const message = /** @type {MessageBase} */ (this.message);
    const clazz = /** @type {typeof MessageBase} */ (message.constructor);
    if (clazz.MSGTYPE === null || clazz.MSGTYPE === undefined) {
      throw new ChannelException(
        CEType.ME_NO_MSG_TYPE,
        `${clazz.name} lacks MSGTYPE`,
      );
    }
    const data = message.pack();
    const buf = new Uint8Array(ENVELOPE_HEADER_SIZE + data.length);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, /** @type {number} */ (clazz.MSGTYPE), false);
    dv.setUint16(2, this.sequence, false);
    dv.setUint16(4, data.length, false);
    buf.set(data, ENVELOPE_HEADER_SIZE);
    this.raw = buf;
    this.packed = true;
    return buf;
  }
}

/**
 * Abstract transport adapter a {@link Channel} sends through. Mirrors
 * `RNS/Channel.py` `ChannelOutletBase`. The concrete link-backed implementation
 * is {@link LinkChannelOutlet}.
 *
 * "Packet" here is the opaque handle a concrete outlet returns from `send`;
 * the channel only ever passes it back to the outlet's other methods.
 */
export class ChannelOutletBase {
  /** @param {Uint8Array} _raw @returns {Promise<any>} */
  async send(_raw) {
    throw new Error("not implemented");
  }
  /** @param {any} _packet @returns {Promise<any>} */
  async resend(_packet) {
    throw new Error("not implemented");
  }
  /** @returns {number} */
  get mdu() {
    throw new Error("not implemented");
  }
  /** @returns {number} */
  get rtt() {
    throw new Error("not implemented");
  }
  /** @returns {boolean} */
  get isUsable() {
    throw new Error("not implemented");
  }
  /** @param {any} _packet @returns {MessageState} */
  getPacketState(_packet) {
    throw new Error("not implemented");
  }
  timedOut() {
    throw new Error("not implemented");
  }
  /**
   * @param {any} _packet
   * @param {((packet: any) => void)|null} _callback
   * @param {number} [_timeoutSeconds]
   */
  setPacketTimeoutCallback(_packet, _callback, _timeoutSeconds) {
    throw new Error("not implemented");
  }
  /** @param {any} _packet @param {((packet: any) => void)|null} _callback */
  setPacketDeliveredCallback(_packet, _callback) {
    throw new Error("not implemented");
  }
  /** @param {any} _packet @returns {any} */
  getPacketId(_packet) {
    throw new Error("not implemented");
  }
  /**
   * Only-if-larger timeout bump (used by `Channel._updatePacketTimeouts`).
   * Base no-op; outlets with timer state override it.
   * @param {any} _packet
   * @param {number} _timeoutSeconds
   */
  extendTimeout(_packet, _timeoutSeconds) {}
  /** Release listeners / timers. Base no-op; outlets override it. */
  _cleanup() {}
}

// Adaptive-window constants — must match `RNS/Channel.py` exactly (affects
// throughput, pacing, and retry behavior a peer may be sensitive to).
const WINDOW = 2;
const WINDOW_MIN = 2;
const WINDOW_MIN_LIMIT_SLOW = 2;
const WINDOW_MIN_LIMIT_MEDIUM = 5;
const WINDOW_MIN_LIMIT_FAST = 16;
const WINDOW_MAX_SLOW = 5;
const WINDOW_MAX_MEDIUM = 12;
const WINDOW_MAX_FAST = 48;
const WINDOW_MAX = WINDOW_MAX_FAST;
const FAST_RATE_THRESHOLD = 10;
const RTT_FAST = 0.18;
const RTT_MEDIUM = 0.75;
const RTT_SLOW = 1.45;
const WINDOW_FLEXIBILITY = 4;
const SEQ_MAX = 0xffff;
const SEQ_MODULUS = 0x10000;

/**
 * Reliable message channel over a {@link ChannelOutletBase}.
 *
 * Obtained via `link.getChannel()`; not constructed directly.
 */
export class Channel {
  /** @param {ChannelOutletBase} outlet */
  constructor(outlet) {
    this._outlet = outlet;
    /** @type {Envelope[]} sorted by sequence */
    this._txRing = [];
    /** @type {Envelope[]} sorted by sequence */
    this._rxRing = [];
    /** @type {((message: MessageBase) => boolean)[]} */
    this._messageCallbacks = [];
    this._nextSequence = 0;
    this._nextRxSequence = 0;
    /** @type {Map<number, typeof MessageBase>} */
    this._messageFactories = new Map();
    this._maxTries = 5;
    this.fastRateRounds = 0;
    this.mediumRateRounds = 0;
    this._shutDown = false;
    /** Serializes the async send path (the JS analog of Python's `_send_lock`). */
    this._sendChain = Promise.resolve();

    if (this._outlet.rtt > RTT_SLOW) {
      this.window = 1;
      this.windowMax = 1;
      this.windowMin = 1;
      this.windowFlexibility = 1;
    } else {
      this.window = WINDOW;
      this.windowMax = WINDOW_MAX_SLOW;
      this.windowMin = WINDOW_MIN;
      this.windowFlexibility = WINDOW_FLEXIBILITY;
    }

    // Bound delivery / timeout callbacks (handed to the outlet by reference).
    this._packetDelivered = this._packetDelivered.bind(this);
    this._packetTimeout = this._packetTimeout.bind(this);
  }

  /** Largest sequence number (16-bit). */
  static get SEQ_MAX() {
    return SEQ_MAX;
  }
  /** Sequence-number modulus (0x10000). */
  static get SEQ_MODULUS() {
    return SEQ_MODULUS;
  }

  /**
   * Register a message class for reception. It must extend {@link MessageBase},
   * declare a valid `MSGTYPE` (< `0xf000`), and be constructable with no args.
   * @param {typeof MessageBase} messageClass
   */
  registerMessageType(messageClass) {
    this._registerMessageType(messageClass, false);
  }

  /**
   * @param {typeof MessageBase} messageClass
   * @param {boolean} isSystemType
   * @private
   */
  _registerMessageType(messageClass, isSystemType) {
    if (!(messageClass.prototype instanceof MessageBase)) {
      throw new ChannelException(
        CEType.ME_INVALID_MSG_TYPE,
        `${messageClass.name} is not a subclass of MessageBase.`,
      );
    }
    const msgtype = messageClass.MSGTYPE;
    if (msgtype === null || msgtype === undefined) {
      throw new ChannelException(
        CEType.ME_INVALID_MSG_TYPE,
        `${messageClass.name} has invalid MSGTYPE class attribute.`,
      );
    }
    if (msgtype >= 0xf000 && !isSystemType) {
      throw new ChannelException(
        CEType.ME_INVALID_MSG_TYPE,
        `${messageClass.name} has system-reserved message type.`,
      );
    }
    try {
      new messageClass();
    } catch (err) {
      throw new ChannelException(
        CEType.ME_INVALID_MSG_TYPE,
        `${messageClass.name} raised when constructed with no arguments: ${err}`,
      );
    }
    this._messageFactories.set(msgtype, messageClass);
  }

  /**
   * Register a system message type (MSGTYPE `>= 0xf000`). Library use only
   * (e.g. the Buffer stream layer's `StreamDataMessage`).
   * @param {typeof MessageBase} messageClass
   */
  _registerSystemMessageType(messageClass) {
    this._registerMessageType(messageClass, true);
  }

  /**
   * Add a handler for incoming messages. Handlers are invoked in insertion
   * order; if one returns `true`, processing stops (later handlers are skipped).
   * @param {(message: MessageBase) => boolean} callback
   */
  addMessageHandler(callback) {
    if (!this._messageCallbacks.includes(callback)) {
      this._messageCallbacks.push(callback);
    }
  }

  /**
   * Remove a handler added with {@link addMessageHandler}.
   * @param {(message: MessageBase) => boolean} callback
   */
  removeMessageHandler(callback) {
    const idx = this._messageCallbacks.indexOf(callback);
    if (idx !== -1) this._messageCallbacks.splice(idx, 1);
  }

  /**
   * Tear the channel down: clear handlers, rings, and outlet timers/callbacks.
   * Called on link teardown and on retry-count exhaustion.
   */
  _shutdown() {
    if (this._shutDown) return;
    this._shutDown = true;
    this._messageCallbacks.length = 0;
    this._clearRings();
    this._outlet._cleanup();
  }

  /** @private */
  _clearRings() {
    for (const envelope of this._txRing) {
      if (envelope.packet != null) {
        this._outlet.setPacketTimeoutCallback(envelope.packet, null);
        this._outlet.setPacketDeliveredCallback(envelope.packet, null);
      }
      envelope.tracked = false;
    }
    for (const envelope of this._rxRing) envelope.tracked = false;
    this._txRing.length = 0;
    this._rxRing.length = 0;
  }

  /**
   * Insert `envelope` into `ring` in sequence order (wraparound-aware), deduping
   * by sequence. Returns false on duplicate. Ports `_emplace_envelope` verbatim
   * (including its use of `_nextRxSequence` for the wrap guard, which is a
   * no-op for the naturally-ordered tx ring).
   * @param {Envelope} envelope
   * @param {Envelope[]} ring
   * @returns {boolean}
   * @private
   */
  _emplaceEnvelope(envelope, ring) {
    for (let i = 0; i < ring.length; i++) {
      const existing = ring[i];
      if (envelope.sequence === existing.sequence) {
        log(
          "Channel",
          `Emplacement of duplicate envelope with sequence ${envelope.sequence}`,
          LogLevel.EXTREME,
        );
        return false;
      }
      if (
        envelope.sequence < existing.sequence &&
        !(this._nextRxSequence - envelope.sequence > SEQ_MAX / 2)
      ) {
        ring.splice(i, 0, envelope);
        envelope.tracked = true;
        return true;
      }
    }
    envelope.tracked = true;
    ring.push(envelope);
    return true;
  }

  /**
   * @param {MessageBase} message
   * @private
   */
  _runCallbacks(message) {
    const cbs = this._messageCallbacks.slice();
    for (const cb of cbs) {
      try {
        if (cb(message)) return;
      } catch (err) {
        log(
          "Channel",
          `Error while running a message callback: ${err}`,
          LogLevel.ERROR,
        );
      }
    }
  }

  /**
   * Decode an inbound envelope, validate its sequence, accept it into the rx
   * ring, and deliver any newly-contiguous messages to handlers in order.
   * @param {Uint8Array} raw
   */
  _receive(raw) {
    try {
      const envelope = new Envelope({ outlet: this._outlet, raw });
      envelope.unpack(this._messageFactories);

      if (envelope.sequence < this._nextRxSequence) {
        const windowOverflow =
          (this._nextRxSequence + WINDOW_MAX) % SEQ_MODULUS;
        if (windowOverflow < this._nextRxSequence) {
          if (envelope.sequence > windowOverflow) {
            log(
              "Channel",
              `Invalid packet sequence (${envelope.sequence}) received`,
              LogLevel.EXTREME,
            );
            return;
          }
        } else {
          log(
            "Channel",
            `Invalid packet sequence (${envelope.sequence}) received`,
            LogLevel.EXTREME,
          );
          return;
        }
      }

      const isNew = this._emplaceEnvelope(envelope, this._rxRing);
      if (!isNew) {
        log("Channel", "Duplicate message received", LogLevel.EXTREME);
        return;
      }

      // Drain everything that is now contiguous from the next expected rx seq.
      const contiguous = [];
      for (;;) {
        const idx = this._rxRing.findIndex(
          (e) => e.sequence === this._nextRxSequence,
        );
        if (idx === -1) break;
        const e = this._rxRing[idx];
        contiguous.push(e);
        this._rxRing.splice(idx, 1);
        this._nextRxSequence = (this._nextRxSequence + 1) % SEQ_MODULUS;
      }
      for (const e of contiguous) {
        const m = /** @type {MessageBase} */ (
          e.unpacked ? e.message : e.unpack(this._messageFactories)
        );
        this._runCallbacks(m);
      }
    } catch (err) {
      log(
        "Channel",
        `An error occurred while receiving data: ${err}`,
        LogLevel.ERROR,
      );
    }
  }

  /**
   * Whether the channel can accept another `send`. Mirrors `is_ready_to_send`.
   * @returns {boolean}
   */
  isReadyToSend() {
    if (!this._outlet.isUsable) return false;
    let outstanding = 0;
    for (const envelope of this._txRing) {
      if (envelope.outlet !== this._outlet) continue;
      if (
        !envelope.packet ||
        this._outlet.getPacketState(envelope.packet) !==
          MessageState.MSGSTATE_DELIVERED
      ) {
        outstanding += 1;
      }
    }
    return outstanding < this.window;
  }

  /**
   * Delivery confirmed for a packet: remove its envelope from the tx ring and
   * grow / promote the window. Ports `_packet_tx_op`.
   * @param {any} packet
   * @param {(envelope: Envelope) => boolean} op
   * @private
   */
  _packetTxOp(packet, op) {
    const targetId = this._outlet.getPacketId(packet);
    const envelope = this._txRing.find(
      (e) =>
        e.packet != null && this._outlet.getPacketId(e.packet) === targetId,
    );
    if (envelope && op(envelope)) {
      envelope.tracked = false;
      const idx = this._txRing.indexOf(envelope);
      if (idx !== -1) {
        this._txRing.splice(idx, 1);

        if (this.window < this.windowMax) this.window += 1;

        const rtt = this._outlet.rtt;
        if (rtt !== 0) {
          if (rtt > RTT_FAST) {
            this.fastRateRounds = 0;
            if (rtt > RTT_MEDIUM) {
              this.mediumRateRounds = 0;
            } else {
              this.mediumRateRounds += 1;
              if (
                this.windowMax < WINDOW_MAX_MEDIUM &&
                this.mediumRateRounds === FAST_RATE_THRESHOLD
              ) {
                this.windowMax = WINDOW_MAX_MEDIUM;
                this.windowMin = WINDOW_MIN_LIMIT_MEDIUM;
              }
            }
          } else {
            this.fastRateRounds += 1;
            if (
              this.windowMax < WINDOW_MAX_FAST &&
              this.fastRateRounds === FAST_RATE_THRESHOLD
            ) {
              this.windowMax = WINDOW_MAX_FAST;
              this.windowMin = WINDOW_MIN_LIMIT_FAST;
            }
          }
        }
      } else {
        log("Channel", "Envelope not found in TX ring", LogLevel.EXTREME);
      }
    }
    if (!envelope) {
      log("Channel", "Spurious message received", LogLevel.EXTREME);
    }
  }

  /** @param {any} packet @private */
  _packetDelivered(packet) {
    this._packetTxOp(packet, () => true);
  }

  /**
   * Per-packet timeout based on retry count, RTT, and tx-ring depth. Ports
   * `_get_packet_timeout_time`.
   * @param {number} tries
   * @returns {number} seconds
   * @private
   */
  _getPacketTimeoutTime(tries) {
    return (
      1.5 ** (tries - 1) *
      Math.max(this._outlet.rtt * 2.5, 0.025) *
      (this._txRing.length + 1.5)
    );
  }

  /**
   * Only-ever-increase the scheduled timeout of in-flight envelopes (a new send
   * grows the tx ring, which raises every envelope's fair timeout). Ports
   * `_update_packet_timeouts`.
   * @private
   */
  _updatePacketTimeouts() {
    for (const envelope of this._txRing) {
      if (!envelope.packet) continue;
      const updated = this._getPacketTimeoutTime(envelope.tries);
      this._outlet.extendTimeout(envelope.packet, updated);
    }
  }

  /**
   * A sent packet's delivery proof did not arrive in time: retransmit (up to
   * {@link _maxTries}) or tear the link down. Ports `_packet_timeout`.
   * @param {any} packet
   * @private
   */
  _packetTimeout(packet) {
    if (
      this._outlet.getPacketState(packet) === MessageState.MSGSTATE_DELIVERED
    ) {
      return;
    }
    const targetId = this._outlet.getPacketId(packet);
    const envelope = this._txRing.find(
      (e) =>
        e.packet != null && this._outlet.getPacketId(e.packet) === targetId,
    );
    if (!envelope) return;

    let envelopeToResend = null;
    let shouldTeardown = false;
    if (envelope.tries >= this._maxTries) {
      shouldTeardown = true;
    } else {
      envelope.tries += 1;
      envelopeToResend = envelope;
      if (this.window > this.windowMin) {
        this.window -= 1;
        if (this.windowMax > this.windowMin + this.windowFlexibility) {
          this.windowMax -= 1;
        }
      }
    }

    if (shouldTeardown) {
      log(
        "Channel",
        "Retry count exceeded, tearing down Link.",
        LogLevel.ERROR,
      );
      this._shutdown();
      this._outlet.timedOut();
      return;
    }

    if (envelopeToResend) {
      // Retransmit identical bytes (same hash → same proof), then re-arm.
      Promise.resolve(this._outlet.resend(envelopeToResend.packet)).catch(
        (err) => log("Channel", `Resend failed: ${err}`, LogLevel.ERROR),
      );
      this._outlet.setPacketDeliveredCallback(
        envelopeToResend.packet,
        this._packetDelivered,
      );
      this._outlet.setPacketTimeoutCallback(
        envelopeToResend.packet,
        this._packetTimeout,
        this._getPacketTimeoutTime(envelopeToResend.tries),
      );
      this._updatePacketTimeouts();
      const alreadyDelivered =
        this._outlet.getPacketState(envelopeToResend.packet) ===
        MessageState.MSGSTATE_DELIVERED;
      if (alreadyDelivered) this._packetDelivered(envelopeToResend.packet);
    }
  }

  /**
   * Send a message reliably. Rejects if the channel is not ready
   * ({@link CEType.ME_LINK_NOT_READY}) or the packed message exceeds the MDU
   * ({@link CEType.ME_TOO_BIG}). Resolves with the outbound {@link Envelope}.
   *
   * @param {MessageBase} message
   * @returns {Promise<Envelope>}
   */
  send(message) {
    const p = this._sendChain.then(() => this._sendImpl(message));
    // Keep the internal chain alive across rejections so a failed send does
    // not poison subsequent ones; the returned promise still surfaces errors.
    this._sendChain = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  /**
   * @param {MessageBase} message
   * @returns {Promise<Envelope>}
   * @private
   */
  async _sendImpl(message) {
    if (this._shutDown || !this.isReadyToSend()) {
      throw new ChannelException(CEType.ME_LINK_NOT_READY, "Link is not ready");
    }

    const reservedSequence = this._nextSequence;
    const envelope = new Envelope({
      outlet: this._outlet,
      message,
      sequence: reservedSequence,
    });
    const packed = envelope.pack();
    if (packed.length > this._outlet.mdu) {
      throw new ChannelException(
        CEType.ME_TOO_BIG,
        `Packed message too big for packet: ${packed.length} > ${this._outlet.mdu}`,
      );
    }
    this._nextSequence = (reservedSequence + 1) % SEQ_MODULUS;

    let packet;
    try {
      packet = await this._outlet.send(packed);
    } catch (err) {
      // Outlet declined to transmit: roll the reserved sequence back.
      this._nextSequence = reservedSequence;
      throw err;
    }
    envelope.packet = packet;

    this._emplaceEnvelope(envelope, this._txRing);
    envelope.tries += 1;
    this._outlet.setPacketDeliveredCallback(packet, this._packetDelivered);
    this._outlet.setPacketTimeoutCallback(
      packet,
      this._packetTimeout,
      this._getPacketTimeoutTime(envelope.tries),
    );
    this._updatePacketTimeouts();
    const alreadyDelivered =
      this._outlet.getPacketState(packet) === MessageState.MSGSTATE_DELIVERED;
    if (alreadyDelivered) this._packetDelivered(packet);
    return envelope;
  }

  /**
   * Maximum body bytes available to a single message: the outlet MDU minus the
   * 6-byte envelope header, capped at 16 bits.
   * @returns {number}
   */
  get mdu() {
    const mdu = this._outlet.mdu - ENVELOPE_HEADER_SIZE;
    return mdu > 0xffff ? 0xffff : mdu;
  }
}

/**
 * Per-sent-packet handle for {@link LinkChannelOutlet}. Wraps the wire
 * `Packet`, its hex hash (the proof-correlation id), and the delivery / timeout
 * callbacks the channel arms.
 */
class LinkOutletPacket {
  /** @type {Packet} */
  packet;
  /** @type {string} */
  hashHex;
  delivered = false;
  /** Last armed timeout value (seconds). @type {number|null} */
  timeout = null;
  /** @type {((packet: LinkOutletPacket) => void)|null} */
  timeoutCallback = null;
  /** @type {((packet: LinkOutletPacket) => void)|null} */
  deliveredCallback = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  timeoutTimer = null;

  /**
   * @param {Packet} packet
   * @param {string} hashHex
   */
  constructor(packet, hashHex) {
    this.packet = packet;
    this.hashHex = hashHex;
  }
}

/**
 * {@link ChannelOutletBase} backed by a {@link import("./link.js").Link}.
 *
 * Adapts the channel to our link's proof model: the link fires a `proof` event
 * for every validated link-DATA proof (regardless of context). We match proofs
 * to in-flight envelopes by packet hash and arm timeouts with `setTimeout`.
 *
 * Retransmission re-sends the *identical* encrypted packet bytes (same hash,
 * same proof) rather than re-encrypting, so the receiver's re-proof resolves
 * the original envelope.
 */
export class LinkChannelOutlet extends ChannelOutletBase {
  /** @type {Map<string, LinkOutletPacket>} keyed by hex packet hash */
  _sent = new Map();
  /**
   * Hashes whose proof arrived before `send()` registered the handle. With a
   * zero-latency (mock) transport the proof round-trip completes inside
   * `outlet.send`'s await — before the handle is stored — so we stash those
   * hashes and reconcile when `send()` lands.
   * @type {Set<string>}
   */
  _earlyDelivered = new Set();

  /**
   * @param {import("./link.js").Link} link
   */
  constructor(link) {
    super();
    this.link = link;
    /** @param {CustomEvent} event */
    this._proofListener = (event) => {
      const detail = /** @type {{packetHash: Uint8Array}} */ (event.detail);
      this._markDelivered(toHex(detail.packetHash));
    };
    this.link.addEventListener(
      "proof",
      /** @type {any} */ (this._proofListener),
    );
  }

  /**
   * Token-encrypt and send a CHANNEL DATA packet. Returns a handle whose hash is
   * the proof-correlation id.
   * @param {Uint8Array} raw
   * @returns {Promise<LinkOutletPacket>}
   */
  async send(raw) {
    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.LINK,
      destinationHash: this.link.linkId,
      contextByte: ContextType.CHANNEL,
      payload: raw,
    });
    const outbound = await this.link.send(packet);
    const hash = await outbound.getHash();
    const hashHex = toHex(hash);
    const op = new LinkOutletPacket(outbound, hashHex);
    // Reconcile any proof that beat us here (zero-latency transports).
    if (this._earlyDelivered.has(hashHex)) {
      op.delivered = true;
      this._earlyDelivered.delete(hashHex);
    }
    this._sent.set(hashHex, op);
    return op;
  }

  /**
   * Re-send the exact wire bytes of a previously-sent packet (identical hash →
   * identical proof). Returns the same handle.
   * @param {LinkOutletPacket} op
   * @returns {Promise<LinkOutletPacket>}
   */
  async resend(op) {
    if (this.link.transport) {
      await this.link.transport.sendPacket(op.packet);
    }
    return op;
  }

  get mdu() {
    return this.link.mdu;
  }

  get rtt() {
    return this.link.rtt;
  }

  // Matches Python's `LinkChannelOutlet.is_usable` (hardcoded true; the link's
  // own CLOSED transition + the channel's `_shutDown` flag stop new sends).
  get isUsable() {
    return true;
  }

  /**
   * @param {LinkOutletPacket} op
   * @returns {MessageState}
   */
  getPacketState(op) {
    if (!op) return MessageState.MSGSTATE_FAILED;
    if (op.delivered) return MessageState.MSGSTATE_DELIVERED;
    return MessageState.MSGSTATE_SENT;
  }

  /** @param {LinkOutletPacket} op @returns {string|null} */
  getPacketId(op) {
    return op ? op.hashHex : null;
  }

  /** Tear the underlying link down (retry-count exhaustion). */
  timedOut() {
    this.link
      .teardown()
      .catch((err) =>
        log(
          "Channel",
          `teardown after channel timeout failed: ${err}`,
          LogLevel.ERROR,
        ),
      );
  }

  /**
   * (Re)arm the timeout for a packet. Each call replaces the prior callback and
   * restarts the countdown at `timeoutSeconds`.
   * @param {LinkOutletPacket} op
   * @param {((packet: LinkOutletPacket) => void)|null} callback
   * @param {number} [timeoutSeconds]
   */
  setPacketTimeoutCallback(op, callback, timeoutSeconds) {
    if (!op) return;
    if (op.timeoutTimer !== null) {
      clearTimeout(op.timeoutTimer);
      op.timeoutTimer = null;
    }
    // A delivered packet needs no timeout; just record a null callback if asked.
    if (callback === null) {
      op.timeoutCallback = null;
      return;
    }
    if (op.delivered) {
      op.timeoutCallback = callback;
      return;
    }
    op.timeoutCallback = callback;
    if (timeoutSeconds !== undefined && timeoutSeconds !== null) {
      op.timeout = timeoutSeconds;
      op.timeoutTimer = setTimeout(() => {
        op.timeoutTimer = null;
        if (op.delivered) return;
        const cb = op.timeoutCallback;
        if (cb) {
          try {
            cb(op);
          } catch (err) {
            log("Channel", `Timeout callback threw: ${err}`, LogLevel.ERROR);
          }
        }
      }, timeoutSeconds * 1000);
    }
  }

  /**
   * @param {LinkOutletPacket} op
   * @param {((packet: LinkOutletPacket) => void)|null} callback
   */
  setPacketDeliveredCallback(op, callback) {
    if (!op) return;
    op.deliveredCallback = callback;
  }

  /**
   * Only-if-larger timeout bump used by `Channel._updatePacketTimeouts`.
   * @param {LinkOutletPacket} op
   * @param {number} timeoutSeconds
   */
  extendTimeout(op, timeoutSeconds) {
    if (!op || op.delivered || op.timeout === null) return;
    if (timeoutSeconds > op.timeout) {
      this.setPacketTimeoutCallback(op, op.timeoutCallback, timeoutSeconds);
    }
  }

  /**
   * Mark the packet for `hashHex` delivered (idempotent) and fire its callback.
   * @param {string} hashHex
   * @private
   */
  _markDelivered(hashHex) {
    const op = this._sent.get(hashHex);
    if (!op) {
      // Proof arrived before send() registered the handle (zero-latency mock).
      // Stash it so send() can mark the handle delivered when it lands.
      this._earlyDelivered.add(hashHex);
      return;
    }
    if (op.delivered) return;
    op.delivered = true;
    if (op.timeoutTimer !== null) {
      clearTimeout(op.timeoutTimer);
      op.timeoutTimer = null;
    }
    this._sent.delete(hashHex);
    const cb = op.deliveredCallback;
    if (cb) {
      try {
        cb(op);
      } catch (err) {
        log("Channel", `Delivered callback threw: ${err}`, LogLevel.ERROR);
      }
    }
  }

  /** Detach the proof listener and clear armed timers (on channel shutdown). */
  _cleanup() {
    this.link.removeEventListener(
      "proof",
      /** @type {any} */ (this._proofListener),
    );
    for (const op of this._sent.values()) {
      if (op.timeoutTimer !== null) {
        clearTimeout(op.timeoutTimer);
        op.timeoutTimer = null;
      }
    }
    this._sent.clear();
    this._earlyDelivered.clear();
  }
}
