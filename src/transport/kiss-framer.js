import { TransformStream } from "node:stream/web";
import { LogLevel, log } from "../utils/log.js";

/**
 * @file kiss-framer.js
 * @description KISS (Keep It Simple, Stupid) stream framing for RNS packets.
 *
 * Used by serial-style interfaces (RNode, AX.25/TTY modems) and, optionally,
 * by stream interfaces that want KISS framing instead of HDLC (e.g.
 * KISS-over-TCP for Python-reference parity). Mirrors the `KISS` class in the
 * Python reference `RNS/Interfaces/TCPInterface.py` and the read loop in
 * `RNS/Interfaces/KISSInterface.py`. See `PROTOCOL-SPEC.md` §8.1.
 *
 * A KISS data frame is `FEND | CMD_DATA(port) | escaped(payload) | FEND`. The
 * command byte's high nibble is the port; we strip it (`byte & 0x0F`) so any
 * port's data frame is treated as `CMD_DATA`, exactly like the Python
 * reference ("we only support one HDLC port for now"). Non-data command frames
 * (radio config, flow control, etc.) are collected but never emitted, so the
 * same unframer can sit on an RNode serial link later without special-casing.
 */

const FEND = 0xc0;
const FESC = 0xdb;
const TFEND = 0xdc;
const TFESC = 0xdd;
const CMD_DATA = 0x00;
const CMD_UNKNOWN = 0xfe;

/**
 * Escapes data using KISS byte-stuffing.
 *
 * Matches the Python reference `KISS.escape` precedence: `0xDB` is escaped
 * first (`0xDB 0xDD`), then `0xC0` (`0xDB 0xDC`). Escaping `FESC` first is
 * essential — the `FEND` escape sequence `0xDB 0xDC` contains a `0xDB`, so a
 * naive `FEND`-first pass would double-escape it.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function kissEscape(data) {
  const escaped = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === FESC) {
      escaped.push(FESC, TFESC);
    } else if (b === FEND) {
      escaped.push(FESC, TFEND);
    } else {
      escaped.push(b);
    }
  }
  return new Uint8Array(escaped);
}

/**
 * Decodes data using KISS unescaping.
 *
 * Inverse of {@link kissEscape}: `FESC TFEND → FEND`, `FESC TFESC → FESC`.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 * @throws {Error} on a dangling/trailing `FESC` or an invalid escape pair
 */
export function kissUnescape(data) {
  const unescaped = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === FESC) {
      if (i + 1 >= data.length) {
        throw new Error("Incomplete escape sequence at end of data");
      }
      const next = data[i + 1];
      if (next === TFEND) {
        unescaped.push(FEND);
      } else if (next === TFESC) {
        unescaped.push(FESC);
      } else {
        throw new Error(`Invalid escape sequence: 0xDB 0x${next.toString(16)}`);
      }
      i++;
    } else {
      unescaped.push(data[i]);
    }
  }
  return new Uint8Array(unescaped);
}

/**
 * Builds a single KISS data frame for a raw (serialized) packet.
 *
 * Produces `FEND | CMD_DATA | escaped(payload) | FEND`. Used by the
 * streaming framer and by message-oriented interfaces (e.g. KISS-over-
 * WebSocket) that wrap one packet per message.
 * @param {Uint8Array} rawPacket
 * @returns {Uint8Array}
 */
export function kissFrame(rawPacket) {
  const escaped = kissEscape(rawPacket);
  const frame = new Uint8Array(escaped.length + 3);
  frame[0] = FEND;
  frame[1] = CMD_DATA;
  frame.set(escaped, 2);
  frame[frame.length - 1] = FEND;
  return frame;
}

/**
 * Creates a TransformStream for KISS framing (Packets -> Bytes).
 *
 * Each packet is wrapped as `FEND | CMD_DATA | escaped(payload) | FEND`.
 * @returns {TransformStream}
 */
export function createKissFramerStream() {
  return new TransformStream({
    /**
     * @param {import('../core/packet.js').Packet} packet
     * @param {TransformStreamDefaultController} controller
     */
    transform(packet, controller) {
      const frame = kissFrame(packet.serialize());
      log("KISS", `Enqueuing frame: ${frame}`, LogLevel.EXTREME);
      controller.enqueue(frame);
    },
  });
}

/**
 * Creates a TransformStream for KISS un-framing (Bytes -> Packets).
 *
 * Implements the Python reference `KISSInterface.readLoop` state machine byte
 * for byte: it scans for `FEND` boundaries, reads the command byte (port
 * nibble stripped), and accumulates unescaped data only for `CMD_DATA`
 * frames. Non-data frames are silently consumed. Frames exceeding `maxMtu`
 * are discarded (defence against a malicious/malformed peer), matching the
 * Python `len(data_buffer) < self.HW_MTU` guard.
 * @param {typeof import('../core/packet.js').Packet} packetClass
 * @param {number} [ifacSize=0] - Optional size of the IFAC field if present
 * @param {number} [maxMtu=2048] - Maximum bytes accumulated per frame before
 *   the in-progress frame is dropped. Defaults to a generous cap; serial
 *   interfaces should pass their real `HW_MTU`.
 * @returns {TransformStream}
 */
export function createKissUnframerStream(
  packetClass,
  ifacSize = 0,
  maxMtu = 2048,
) {
  let inFrame = false;
  let inEscape = false;
  let command = CMD_UNKNOWN;
  /** @type {number[]} */
  let dataBuffer = [];

  return new TransformStream({
    /**
     * @param {Uint8Array} chunk
     * @param {TransformStreamDefaultController} controller
     */
    transform(chunk, controller) {
      log("KISS", `Received ${chunk.length} bytes`, LogLevel.DEBUG);
      for (let idx = 0; idx < chunk.length; idx++) {
        const byte = chunk[idx];

        if (byte === FEND) {
          if (inFrame && command === CMD_DATA) {
            const unescaped = new Uint8Array(dataBuffer);
            try {
              let dataToDeserialize = unescaped;
              if (ifacSize > 0) {
                dataToDeserialize = unescaped.slice(2 + ifacSize);
              }
              controller.enqueue(packetClass.deserialize(dataToDeserialize));
            } catch (e) {
              log("KISS", `Failed to process frame: ${e}`, LogLevel.ERROR);
            }
          }
          inFrame = true;
          inEscape = false;
          command = CMD_UNKNOWN;
          dataBuffer = [];
          continue;
        }

        if (!inFrame) {
          // Bytes outside any frame are line noise; ignore until the next FEND.
          continue;
        }

        if (dataBuffer.length === 0 && command === CMD_UNKNOWN) {
          // First byte after FEND is the command byte; strip the port nibble
          // so any port's data frame maps to CMD_DATA.
          command = byte & 0x0f;
          continue;
        }

        if (command !== CMD_DATA) {
          // Non-data frame (radio config etc.): consume but do not emit.
          continue;
        }

        if (dataBuffer.length >= maxMtu) {
          // Frame exceeds the negotiated MTU; drop it and resync on next FEND.
          log(
            "KISS",
            `Frame exceeded maxMtu (${maxMtu}); discarding`,
            LogLevel.WARN,
          );
          inFrame = false;
          inEscape = false;
          command = CMD_UNKNOWN;
          dataBuffer = [];
          continue;
        }

        if (byte === FESC) {
          inEscape = true;
          continue;
        }

        let out = byte;
        if (inEscape) {
          if (byte === TFEND) {
            out = FEND;
          } else if (byte === TFESC) {
            out = FESC;
          } else {
            // Invalid transposed byte: drop the frame and resync.
            log(
              "KISS",
              `Invalid escape sequence: 0xDB 0x${byte.toString(16)}`,
              LogLevel.WARN,
            );
            inFrame = false;
            inEscape = false;
            command = CMD_UNKNOWN;
            dataBuffer = [];
            continue;
          }
          inEscape = false;
        }
        dataBuffer.push(out);
      }
    },
  });
}
