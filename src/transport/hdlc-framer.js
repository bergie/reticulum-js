import { LogLevel, log } from "../utils/log.js";

/**
 * @file hdlc-framer.js
 * @description HDLC-based stream framing for RNS packets.
 *
 * Used by stream-oriented interfaces (TCP, local Unix socket). Mirrors the
 * `HDLC` class in the Python reference `RNS/Interfaces/TCPInterface.py`:
 * `FLAG` (0x7E) / `ESC` (0x7D) byte-stuffing with an `ESC_MASK` of 0x20.
 * See `PROTOCOL-SPEC.md` §8.2.
 */

const FLAG = 0x7e;
const ESC = 0x7d;
const ESC_MASK = 0x20;

/**
 * Escapes data using HDLC byte-stuffing.
 *
 * Matches the Python reference `HDLC.escape` precedence: `ESC` is escaped
 * first, then `FLAG`. Because `0x7D ^ 0x20 == 0x5D` and `0x7E ^ 0x20 ==
 * 0x5E`, escaping `ESC` first cannot introduce a stray `FLAG` (and vice
 * versa), so a single forward pass is order-safe.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function hdlcEscape(data) {
  const escaped = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === FLAG || b === ESC) {
      escaped.push(ESC);
      escaped.push(b ^ ESC_MASK);
    } else {
      escaped.push(b);
    }
  }
  return new Uint8Array(escaped);
}

/**
 * Decodes data using HDLC unescaping.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 * @throws {Error} on malformed escape sequence
 */
export function hdlcUnescape(data) {
  const unescaped = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === ESC) {
      if (i + 1 >= data.length) {
        throw new Error("Incomplete escape sequence at end of data");
      }
      const next = data[i + 1] ^ ESC_MASK;
      if (next !== FLAG && next !== ESC) {
        throw new Error(
          `Invalid escape sequence: 0x7D 0x${data[i + 1].toString(16)}`,
        );
      }
      unescaped.push(next);
      i++;
    } else {
      unescaped.push(data[i]);
    }
  }
  return new Uint8Array(unescaped);
}

/**
 * Creates a TransformStream for HDLC framing (Packets -> Bytes).
 * @returns {TransformStream}
 */
export function createHdlcFramerStream() {
  return new TransformStream({
    /**
     * @param {import('../core/packet.js').Packet} packet
     * @param {TransformStreamDefaultController} controller
     */
    transform(packet, controller) {
      const raw = packet.serialize();
      const escaped = hdlcEscape(raw);

      const frame = new Uint8Array(escaped.length + 2);
      frame[0] = FLAG;
      frame.set(escaped, 1);
      frame[frame.length - 1] = FLAG;

      log("HDLC", `Enqueuing frame: ${frame}`, LogLevel.EXTREME);
      controller.enqueue(frame);
    },
  });
}

/**
 * Creates a TransformStream for HDLC un-framing (Bytes -> Packets).
 * @param {typeof import('../core/packet.js').Packet} packetClass
 * @param {number} [ifacSize=0] - Optional size of the IFAC field if present
 * @returns {TransformStream}
 */
export function createHdlcUnframerStream(packetClass, ifacSize = 0) {
  let buffer = new Uint8Array(0);

  return new TransformStream({
    /**
     * @param {Uint8Array} chunk
     * @param {TransformStreamDefaultController} controller
     */
    transform(chunk, controller) {
      log("HDLC", `Received ${chunk.length} bytes`, LogLevel.DEBUG);
      const combined = new Uint8Array(buffer.length + chunk.length);
      combined.set(buffer);
      combined.set(chunk, buffer.length);
      buffer = combined;

      while (true) {
        const firstFlag = buffer.indexOf(FLAG);
        if (firstFlag === -1) {
          // No complete frames in buffer. Keep everything for next chunk.
          break;
        }

        // If the first flag is not at the start, the data before it is junk/malformed
        if (firstFlag > 0) {
          log(
            "HDLC",
            `Discarding ${firstFlag} bytes of junk/malformed data before first 0x7E`,
            LogLevel.WARNING,
          );
          // In a real stream, we might want to log this or handle it.
          // For now, we just discard it.
          buffer = buffer.slice(firstFlag);
          continue;
        }

        const secondFlag = buffer.indexOf(FLAG, 1);
        if (secondFlag === -1) {
          // Found start, but no end. Keep everything from start.
          break;
        }

        // Found a complete frame candidate
        const frameData = buffer.slice(1, secondFlag);

        try {
          const unescaped = hdlcUnescape(frameData);
          let dataToDeserialize = unescaped;
          if (ifacSize > 0) {
            dataToDeserialize = unescaped.slice(2 + ifacSize);
          }
          const packet = packetClass.deserialize(dataToDeserialize);
          controller.enqueue(packet);
        } catch (e) {
          log("HDLC", `Failed to process frame: ${e}`, LogLevel.ERROR);
        }

        // Advance buffer past the second flag
        buffer = buffer.slice(secondFlag + 1);
      }
    },
  });
}
