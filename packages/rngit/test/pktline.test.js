/**
 * Unit tests for pkt-line framing and byte-stream helpers.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  asyncIteratorFromBytes,
  chunkBytes,
  concat,
  decodePktLines,
  encodePktLine,
  FLUSH,
} from "../src/pktline.js";

describe("encodePktLine", () => {
  test("frames a string with the length header", () => {
    const framed = encodePktLine("NAK\n");
    // "NAK\n" is 4 bytes + 4 header bytes = 8 → "0008NAK\n"
    assert.equal(new TextDecoder("latin1").decode(framed), "0008NAK\n");
  });

  test("frames byte payloads", () => {
    const framed = encodePktLine(new Uint8Array([0x01, 0x02, 0x03]));
    assert.equal(
      Array.from(framed)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
      "30303037010203", // "0007" header + payload
    );
  });

  test("rejects oversized payloads", () => {
    assert.throws(() => encodePktLine(new Uint8Array(70000)));
  });
});

describe("decodePktLines", () => {
  test("round trips with flushes", () => {
    const stream = concat(
      encodePktLine("want 0123456789012345678901234567890123456789\n"),
      FLUSH,
      encodePktLine("done\n"),
    );
    const lines = decodePktLines(stream);
    assert.equal(lines.length, 3);
    assert.equal(
      text(lines[0]),
      "want 0123456789012345678901234567890123456789\n",
    );
    assert.equal(lines[1], null);
    assert.equal(text(lines[2]), "done\n");
  });

  test("rejects malformed streams", () => {
    assert.throws(() => decodePktLines(new Uint8Array([0x30, 0x30, 0x30])));
    assert.throws(() =>
      decodePktLines(new Uint8Array([0x7a, 0x7a, 0x7a, 0x7a])),
    );
  });
});

describe("byte helpers", () => {
  test("concat joins chunks", () => {
    const joined = concat(new Uint8Array([1, 2]), null, new Uint8Array([3]));
    assert.deepEqual(Array.from(joined), [1, 2, 3]);
    assert.deepEqual(Array.from(concat()), []);
  });

  test("chunkBytes splits evenly", () => {
    const chunks = chunkBytes(new Uint8Array(10).fill(7), 4);
    assert.deepEqual(
      chunks.map((c) => c.length),
      [4, 4, 2],
    );
    assert.deepEqual(
      chunks.flatMap((c) => Array.from(c)),
      Array(10).fill(7),
    );
  });

  test("asyncIteratorFromBytes yields chunks then ends", async () => {
    const iter = asyncIteratorFromBytes(new Uint8Array(5).fill(9), 2);
    const seen = [];
    for await (const chunk of iter) seen.push(chunk.length);
    assert.deepEqual(seen, [2, 2, 1]);
  });
});

/** @param {Uint8Array|null} line */
function text(line) {
  return new TextDecoder().decode(/** @type {Uint8Array} */ (line));
}
