/**
 * @module pktline
 * @description pkt-line framing for the git smart protocol (protocol v1),
 * used to synthesize the HTTP responses isomorphic-git's fetch/clone parse.
 *
 * A pkt-line is `<4-hex lowercase length><payload>` where the length includes
 * the 4 header bytes. `0000` is a flush packet; payloads conventionally end
 * with `\n`.
 */

/** A flush packet (`0000`). */
export const FLUSH = new Uint8Array([0x30, 0x30, 0x30, 0x30]);

const HEX = "0123456789abcdef";
const encoder = new TextEncoder();

/**
 * Encodes one pkt-line from a string or byte payload. Strings are encoded
 * as UTF-8.
 *
 * @param {string|Uint8Array} payload
 * @returns {Uint8Array}
 */
export function encodePktLine(payload) {
  const body = typeof payload === "string" ? encoder.encode(payload) : payload;
  if (body.length + 4 > 0xffff) {
    throw new Error("pkt-line payload too long (max 65531 bytes)");
  }
  const length = body.length + 4;
  const out = new Uint8Array(length);
  out[0] = HEX.charCodeAt((length >> 12) & 0xf);
  out[1] = HEX.charCodeAt((length >> 8) & 0xf);
  out[2] = HEX.charCodeAt((length >> 4) & 0xf);
  out[3] = HEX.charCodeAt(length & 0xf);
  out.set(body, 4);
  return out;
}

/**
 * Decodes a full pkt-line stream into its payloads. Flush packets are
 * returned as `null` entries; a trailing partial pkt-line throws.
 *
 * @param {Uint8Array} data
 * @returns {(Uint8Array|null)[]}
 */
export function decodePktLines(data) {
  /** @type {(Uint8Array|null)[]} */
  const lines = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const header = new TextDecoder("ascii").decode(
      data.subarray(offset, offset + 4),
    );
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      throw new Error(`Invalid pkt-line length header at offset ${offset}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      lines.push(null);
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > data.length) {
      throw new Error(`Truncated pkt-line at offset ${offset}`);
    }
    lines.push(data.subarray(offset + 4, offset + length));
    offset += length;
  }
  if (offset !== data.length) {
    throw new Error("Trailing garbage after pkt-line stream");
  }
  return lines;
}

/**
 * Concatenates byte sequences into one `Uint8Array`.
 *
 * @param {...(Uint8Array|null|undefined)} chunks
 * @returns {Uint8Array}
 */
export function concat(...chunks) {
  let size = 0;
  for (const chunk of chunks) {
    if (chunk) size += chunk.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    if (chunk) {
      out.set(chunk, at);
      at += chunk.length;
    }
  }
  return out;
}

/**
 * Splits a byte stream into fixed-size chunks (used for side-band-64k
 * multiplexing and for yielding an async-iterator body in digestible
 * pieces).
 *
 * @param {Uint8Array} data
 * @param {number} size
 * @returns {Uint8Array[]}
 */
export function chunkBytes(data, size) {
  if (data.length === 0) return [new Uint8Array(0)];
  const chunks = [];
  for (let i = 0; i < data.length; i += size) {
    chunks.push(data.subarray(i, Math.min(i + size, data.length)));
  }
  return chunks;
}

/**
 * An async iterator over a byte array, yielding slices of at most `size`
 * bytes per iteration.
 *
 * @param {Uint8Array} data
 * @param {number} [size=65536]
 * @returns {AsyncIterableIterator<Uint8Array>}
 */
export function asyncIteratorFromBytes(data, size = 65536) {
  let index = 0;
  return {
    async next() {
      if (index >= data.length) return { done: true, value: undefined };
      const value = data.subarray(index, Math.min(index + size, data.length));
      index += size;
      return { done: false, value };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
