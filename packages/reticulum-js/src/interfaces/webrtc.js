import { Packet } from "../core/packet.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface } from "./base.js";

/**
 * @file webrtc.js
 * @description Reticulum interface transport over a WebRTC `RTCDataChannel`.
 *
 * WebRTC gives two peers a direct, NAT-traversing, DTLS-encrypted data channel
 * with ~16 KiB message sizes — far above Reticulum's 500-byte MTU. This
 * interface is the "transport upgrade" half of work doc #19: once a signaling
 * orchestrator (a future `src/webrtc/signaling.js`) has exchanged SDP over a
 * Reticulum Link+Resource and opened an `RTCDataChannel`, that channel is
 * wrapped by this interface and registered with
 * {@link import("../transport/transport.js").TransportCore#addInterface}.
 *
 * Like the {@link WebSocketClientInterface} in raw framing, an
 * `RTCDataChannel` is message-oriented, so each binary message carries exactly
 * one RNS packet in its raw wire format — no HDLC (0x7E) byte-stuffing.
 *
 * The interface is written against the duck-typed `RTCDataChannel` shape
 * (`.send()`, `.binaryType`, `.readyState`, and `message`/`open`/`close`/
 * `error` events) so it runs in a browser **and** can be exercised in Node
 * tests with a mock channel pair (Node has no native WebRTC).
 */

/**
 * Minimum RNS header size in bytes (`RNS.Reticulum.HEADER_MINSIZE`):
 * `2 + 1 + (TRUNCATED_HASHLENGTH / 8)` = `2 + 1 + 16` = 19. Mirrors the
 * defensive floor every Python reference interface applies before handing a
 * frame to Transport; anything this small or smaller is silently dropped.
 */
const HEADER_MINSIZE = 19;

/**
 * `RTCDataChannel.readyState` is one of `"connecting" | "open" | "closing" |
 * "closed"`. Only `"open"` can carry packets.
 */
const STATE_OPEN = "open";

/**
 * @typedef {Object} WebRTCInterfaceOptions
 * @property {RTCDataChannel} channel - An already-created `RTCDataChannel`
 *   (from an `RTCPeerConnection`). It may still be `"connecting"`; `connect()`
 *   resolves once it reaches `"open"`.
 * @property {RTCPeerConnection} [peerConnection] - The owning peer
 *   connection, closed alongside the channel on `disconnect()`. Keeping it
 *   lets the interface tear down the whole WebRTC session, not just the data
 *   channel.
 * @property {number} [bitrate] - Nominal bitrate in bits/s. Defaults to
 *   50000000 (~50 Mbit/s, matching the work doc's high-bandwidth assumption).
 * @property {string} [name] - Interface name.
 * @property {number} [ifacSize] - Optional IFAC field size. The channel is
 *   already DTLS-encrypted end-to-end, so IFAC is rarely needed; reserved for
 *   parity with other interfaces.
 */

/**
 * Reticulum interface bridging an open WebRTC `RTCDataChannel`.
 *
 * Each inbound binary message is parsed into a {@link Packet} and dispatched
 * as a `"packet"` event; each outbound {@link Packet} is serialized and sent
 * as one binary message. The channel is **not** a reconnecting dialer —
 * re-establishing WebRTC requires re-running signaling, so a channel close is
 * terminal (the orchestrator may build a fresh interface on a new channel).
 *
 * @extends Interface
 */
export class WebRTCInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link WebRTCInterface} constructor.
   *
   * WebRTC interfaces are created **programmatically** by the signaling
   * orchestrator once a data channel is open — they are not instantiated from
   * static node config — so the schema is informational only.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "WebRTC Interface",
      description:
        "Bridges an open WebRTC RTCDataChannel into RNS streams. Created " +
        "programmatically by the WebRTC signaling orchestrator (work doc " +
        "#19) once SDP has been exchanged over a Reticulum Link+Resource; " +
        "not instantiated from static node config. JS/browser-specific; " +
        "there is no direct Python reference equivalent.",
      properties: {
        ...base.properties,
        bitrate: {
          type: "integer",
          default: 50000000,
          description:
            "Nominal bitrate in bits/s. Defaults to ~50 Mbit/s; the channel " +
            "is a direct high-bandwidth peer link.",
        },
      },
      required: [],
      additionalProperties: false,
    };
  }

  /**
   * Creates a WebRTC interface over an already-created data channel.
   * @param {WebRTCInterfaceOptions} options
   */
  constructor(options) {
    super();
    if (!options?.channel) {
      throw new Error("WebRTCInterface requires an RTCDataChannel");
    }
    /** @type {any} */
    this.channel = options.channel;
    /** @type {any} */
    this.peerConnection = options.peerConnection || null;
    this.name =
      options.name ||
      `webrtc-${options.channel.label || "channel"}-${options.channel.id ?? ""}`;
    /** @type {number} */
    this.ifacSize = options.ifacSize || 0;
    /**
     * Nominal bitrate in bits/s. Matches the work doc's ~50 Mbit/s
     * high-bandwidth assumption; the channel is a direct peer link.
     * @type {number}
     */
    this.bitrate = options.bitrate ?? 50000000;
    /** @type {any} */
    this._readable = null;
    /** @type {any} */
    this._writable = null;
    /** @type {boolean} */
    this.online = false;
    /** @type {Promise<void> | null} */
    this._loopPromise = null;
    // WebRTC is symmetric and not a reconnecting dialer: re-establishing a
    // channel requires re-running signaling, so adopted channels never
    // auto-reconnect (mirrors a server-spawned socket).
    this.initiator = false;
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
   * Waits for the data channel to reach `"open"` (or resolves immediately if
   * already open), bridges it into RNS streams, and dispatches `"connected"`.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.channel.readyState === STATE_OPEN) {
      this._setupStreams();
      this._markOnline();
      return;
    }
    /** @type {Promise<void>} */
    const opened = new Promise((resolve, reject) => {
      const cleanup = () => {
        this.channel.removeEventListener("open", onOpen);
        this.channel.removeEventListener("error", onError);
        this.channel.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        this._setupStreams();
        this._markOnline();
        resolve();
      };
      const onError = (/** @type {any} */ event) => {
        cleanup();
        this.online = false;
        reject(
          new Error(
            `RTCDataChannel failed to open: ${event?.message ?? "unknown error"}`,
          ),
        );
      };
      const onClose = () => {
        cleanup();
        this.online = false;
        reject(new Error("RTCDataChannel closed before opening"));
      };
      this.channel.addEventListener("open", onOpen);
      this.channel.addEventListener("error", onError);
      this.channel.addEventListener("close", onClose);
    });
    await opened;
  }

  /**
   * Marks the interface online and dispatches `"connected"` exactly once per
   * connection episode.
   * @private
   */
  _markOnline() {
    this.online = true;
    this._closed = false;
    this.dispatchEvent(new CustomEvent("connected"));
  }

  /**
   * Bridges the `RTCDataChannel` into RNS streams. Each inbound binary message
   * is one RNS packet (raw framing); each outbound packet is serialized and
   * sent as one binary message.
   * @private
   */
  _setupStreams() {
    const channel = this.channel;
    channel.binaryType = "arraybuffer";
    // Streams are replaced on every (re)connect; drop any stale writer so the
    // next `send()` re-acquires one bound to the fresh writable.
    this._packetWriter = null;

    // Inbound: RTCDataChannel binary messages -> Packets.
    const incoming = new ReadableStream({
      start: (controller) => {
        channel.addEventListener("message", (/** @type {any} */ event) => {
          // `binaryType` is "arraybuffer", so binary frames arrive as
          // ArrayBuffer. Text frames (strings) are ignored.
          if (!(event.data instanceof ArrayBuffer)) {
            log(
              "WebRTC",
              "Ignoring non-binary RTCDataChannel message",
              LogLevel.DEBUG,
            );
            return;
          }
          const bytes = new Uint8Array(event.data);
          try {
            // Match the Python reference read loop and the WebSocket
            // interface: drop anything no larger than the header minimum.
            if (bytes.length <= HEADER_MINSIZE) {
              log(
                "WebRTC",
                `Dropping RTCDataChannel message at or below header minimum (${HEADER_MINSIZE} bytes)`,
                LogLevel.DEBUG,
              );
              return;
            }
            controller.enqueue(Packet.deserialize(bytes));
          } catch (e) {
            log(
              "WebRTC",
              `Failed to parse incoming message: ${e}`,
              LogLevel.ERROR,
            );
          }
        });
        channel.addEventListener("close", () => {
          try {
            controller.close();
          } catch (_e) {
            // already closed/errored
          }
        });
        channel.addEventListener("error", (/** @type {any} */ event) => {
          try {
            controller.error(
              new Error(`RTCDataChannel error: ${event?.message ?? ""}`),
            );
          } catch (_e) {
            // already closed/errored
          }
        });
      },
      cancel: () => {
        try {
          channel.close();
        } catch (_e) {
          // ignore
        }
      },
    });
    this._readable = incoming;

    // Outbound: packets -> RTCDataChannel binary messages.
    this._writable = new WritableStream({
      write: (/** @type {import("../core/packet.js").Packet} */ packet) => {
        if (channel.readyState !== STATE_OPEN) {
          throw new Error("RTCDataChannel is not open");
        }
        channel.send(packet.serialize());
      },
      close: () => {
        try {
          channel.close();
        } catch (_e) {
          // ignore
        }
      },
      abort: () => {
        try {
          channel.close();
        } catch (_e) {
          // ignore
        }
      },
    });

    this._loopPromise = this._startInboundLoop();
  }

  /**
   * Reads packets from the inbound stream and dispatches them; on stream end
   * treats it as a connection loss (terminal, since WebRTC doesn't reconnect).
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
        // Not a reconnecting dialer: a closed channel is terminal.
        this.online = false;
        this._dispatchClosed();
      }
    }
  }

  /**
   * Closes the data channel (and owning peer connection, if any) and dispatches
   * a terminal `disconnected` followed by `closed`.
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      this.channel.close();
    } catch (_e) {
      // ignore
    }
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch (_e) {
        // ignore
      }
    }
    this.online = false;
    this.dispatchEvent(new CustomEvent("disconnected"));
    this._dispatchClosed();
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }
}
