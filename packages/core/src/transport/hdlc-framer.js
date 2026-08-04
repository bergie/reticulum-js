/**
 * @file hdlc-framer.js
 * @description HDLC-based stream framing for RNS packets.
 *
 * Used by stream-oriented interfaces (TCP, local Unix socket). Mirrors the
 * `HDLC` class in the Python reference `RNS/Interfaces/TCPInterface.py`:
 * `FLAG` (0x7E) / `ESC` (0x7D) byte-stuffing with an `ESC_MASK` of 0x20.
 * See `PROTOCOL-SPEC.md` §8.2.
 */

/* @ts-self-types="../../types/src/transport/hdlc-framer.d.ts" */

import { LogLevel, log } from "../utils/log.js";

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
 *
 * When `sealRaw` is provided (an interface's
 * {@link import("../interfaces/base.js").Interface#_sealRaw}), the serialised
 * bytes are IFAC-sealed before framing — the byte-level chokepoint that
 * mirrors `RNS.Transport.transmit`.
 * @param {((raw: Uint8Array) => Promise<Uint8Array>) | null} [sealRaw] -
 *   Optional async IFAC seal hook.
 * @returns {TransformStream}
 */
export function createHdlcFramerStream(sealRaw = null) {
  return new TransformStream({
    /**
     * @param {import('../core/packet.js').Packet} packet
     * @param {TransformStreamDefaultController} controller
     */
    async transform(packet, controller) {
      let raw = packet.serialize();
      if (sealRaw) raw = await sealRaw(raw);
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
 *
 * The accumulated in-progress frame is bounded by `maxFrameSize`: if a peer
 * sends a continuous run of non-FLAG bytes (or opens a frame and never closes
 * it) the buffer is dropped once it exceeds the cap and the unframer resyncs
 * on the next FLAG, mirroring the Python TCP reader's `len(frame_buffer) >
 * HW_MTU*2` guard. Defaults to 2× the Python TCP `HW_MTU` (262144), which
 * comfortably admits any legitimate frame while preventing unbounded memory
 * growth on a stream-oriented interface.
 *
 * When `openRaw` is provided (an interface's
 * {@link import("../interfaces/base.js").Interface#_openRaw}), each unframed
 * frame is IFAC-verified/unsealed before deserialisation, and frames that
 * fail verification (or violate the flag-presence rules) are silently
 * dropped — the byte-level chokepoint that mirrors `RNS.Transport.inbound`.
 * @param {typeof import('../core/packet.js').Packet} packetClass
 * @param {((raw: Uint8Array) => Promise<Uint8Array | null>) | null} [openRaw]
 *   - Optional async IFAC open hook; return `null` to drop the frame.
 * @param {number} [maxFrameSize=524288] - Maximum bytes accumulated between
 *   flags before the in-progress frame is dropped and the unframer resyncs.
 * @returns {TransformStream}
 */
export function createHdlcUnframerStream(
  packetClass,
  openRaw = null,
  maxFrameSize = 524288,
) {
  // Byte-oriented state machine, mirroring createKissUnframerStream. A FLAG
  // both closes the in-progress frame (emitting it) and opens the next; bytes
  // outside any frame are line noise and ignored. The in-progress accumulator
  // is capped at maxFrameSize, so a peer that floods non-FLAG bytes or opens a
  // frame and never closes it (or pads one with megabytes of content) can only
  // ever hold maxFrameSize bytes per interface — the oversized frame is dropped
  // and the unframer resyncs on the next FLAG.
  let inFrame = false;
  /** @type {number[]} raw (still-HDLC-escaped) bytes of the current frame */
  let dataBuffer = [];

  return new TransformStream({
    /**
     * @param {Uint8Array} chunk
     * @param {TransformStreamDefaultController} controller
     */
    async transform(chunk, controller) {
      log("HDLC", `Received ${chunk.length} bytes`, LogLevel.DEBUG);
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i];

        if (byte === FLAG) {
          // A FLAG closes the in-progress frame (if any content) and opens
          // the next. Consecutive FLAGs just produce empty frames, which are
          // skipped by the `dataBuffer.length > 0` guard.
          if (inFrame && dataBuffer.length > 0) {
            try {
              const unescaped = hdlcUnescape(new Uint8Array(dataBuffer));
              /** @type {Uint8Array} */
              let dataToDeserialize = unescaped;
              if (openRaw) {
                const opened = await openRaw(unescaped);
                if (!opened) {
                  inFrame = true;
                  dataBuffer = [];
                  continue;
                }
                dataToDeserialize = opened;
              }
              controller.enqueue(packetClass.deserialize(dataToDeserialize));
            } catch (e) {
              log("HDLC", `Failed to process frame: ${e}`, LogLevel.ERROR);
            }
          }
          inFrame = true;
          dataBuffer = [];
          continue;
        }

        if (!inFrame) {
          // Bytes before the first FLAG (or after dropping an oversized frame)
          // are line noise; ignore until the next FLAG.
          continue;
        }

        if (dataBuffer.length >= maxFrameSize) {
          // Frame exceeds the cap; drop it and resync on the next FLAG.
          log(
            "HDLC",
            `Frame exceeded maxFrameSize (${maxFrameSize}); resyncing`,
            LogLevel.WARNING,
          );
          inFrame = false;
          dataBuffer = [];
          continue;
        }

        dataBuffer.push(byte);
      }
    },
  });
}
