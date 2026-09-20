/**
 * @module pack
 * @description Packfile thin-base resolution ("fattening").
 *
 * rngit fetch bundles exclude objects reachable from the client's `have`
 * list, so the embedded packfile can be thin: its REF_DELTA entries may
 * base their deltas on objects that are not part of the pack. Canonical
 * git refuses to keep thin packs in `objects/pack` (the reference
 * `git bundle unbundle` resolves them with `index-pack --fix-thin`), so
 * before the pack is handed to isomorphic-git the missing bases are
 * resolved from the local object store and the pack is re-emitted
 * self-contained (undeltified).
 *
 * The module contains a minimal RFC 1950/1951 decoder so entry
 * boundaries can be tracked exactly without platform zlib APIs.
 */

/**
 * Pack object types (git pack format).
 * @enum {number}
 */
export const PackObjectType = {
  COMMIT: 1,
  TREE: 2,
  BLOB: 3,
  TAG: 4,
  OFS_DELTA: 6,
  REF_DELTA: 7,
};

/** Numeric pack type ↔ git object type name. @type {Record<number, string>} */
const TYPE_NAMES = {
  [PackObjectType.COMMIT]: "commit",
  [PackObjectType.TREE]: "tree",
  [PackObjectType.BLOB]: "blob",
  [PackObjectType.TAG]: "tag",
};

/** Max Huffman code length (DEFLATE). */
const MAXBITS = 15;

/**
 * A raw (inflated) packfile entry.
 * @typedef {object} RawPackObject
 * @property {number} offset - Entry start offset in the source pack.
 * @property {string} [oid] - Object id once computed (`sha1("type len\0" + raw)`).
 * @property {string} type - `commit` | `tree` | `blob` | `tag`.
 * @property {Uint8Array} raw - Resolved object bytes.
 */

/**
 * A minimal zlib/DEFLATE decoder that reports the exact consumed byte
 * count (RFC 1950 header + DEFLATE blocks + adler32 trailer).
 *
 * @param {Uint8Array} data - Buffer whose head holds one zlib stream.
 * @returns {{ bytes: Uint8Array, consumed: number }}
 */
export function inflateWithBounds(data) {
  // --- zlib header (RFC 1950) ---
  if (data.length < 6) throw new Error("zlib stream too short");
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) {
    throw new Error("bad zlib header");
  }
  if (flg & 0x20) throw new Error("zlib preset dictionary unsupported");

  let bitPos = 16; // bits, past the 2-byte header
  /** @type {number[]} */
  const out = [];

  const bit = () => (data[bitPos >> 3] >> (bitPos & 7)) & 1;
  /** @param {number} n */
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v |= bit() << i;
      bitPos++;
    }
    return v;
  };

  /**
   * Canonical Huffman decode (the classic puff.c algorithm).
   * @param {number[]} lengths - Code length per symbol (0 = unused).
   * @returns {() => number} A symbol decoder.
   */
  const makeDecoder = (lengths) => {
    /** @type {number[]} */
    const count = new Array(MAXBITS + 1).fill(0);
    for (const l of lengths) count[l]++;
    count[0] = 0;
    /** @type {number[]} */
    const symbol = new Array(lengths.length);
    /** @type {number[]} */
    const offsets = new Array(MAXBITS + 2).fill(0);
    for (let l = 1; l <= MAXBITS; l++) {
      offsets[l + 1] = offsets[l] + count[l];
    }
    for (let sym = 0; sym < lengths.length; sym++) {
      if (lengths[sym] !== 0) symbol[offsets[lengths[sym]]++] = sym;
    }
    return () => {
      let code = 0;
      let first = 0;
      let index = 0;
      for (let len = 1; len <= MAXBITS; len++) {
        code |= bits(1);
        const cnt = count[len];
        if (code - first < cnt) return symbol[index + code - first];
        index += cnt;
        first = (first + cnt) << 1;
        code <<= 1;
      }
      throw new Error("invalid Huffman code");
    };
  };

  const lengthBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
    83, 99, 115, 131, 163, 195, 227, 258,
  ];
  const lengthExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
    5, 5, 5, 0,
  ];
  const distBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const distExtra = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
    11, 11, 12, 12, 13, 13,
  ];

  for (;;) {
    const bfinal = bits(1);
    const btype = bits(2);
    if (btype === 0) {
      // Stored block: align to a byte boundary, LEN/NLEN, raw copy.
      bitPos = (bitPos + 7) & ~7;
      const bytePos = bitPos >> 3;
      const len = data[bytePos] | (data[bytePos + 1] << 8);
      const nlen = data[bytePos + 2] | (data[bytePos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error("stored block LEN mismatch");
      for (let i = 0; i < len; i++) out.push(data[bytePos + 4 + i]);
      bitPos = (bytePos + 4 + len) * 8;
    } else {
      let litDecoder;
      let distDecoder;
      if (btype === 1) {
        // Fixed Huffman tables.
        const litLengths = [
          ...Array(144).fill(8),
          ...Array(112).fill(9),
          ...Array(24).fill(7),
          ...Array(8).fill(8),
        ];
        litDecoder = makeDecoder(litLengths);
        distDecoder = makeDecoder(Array(30).fill(5));
      } else if (btype === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const order = [
          16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
        ];
        const clLengths = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLengths[order[i]] = bits(3);
        const clDecoder = makeDecoder(clLengths);
        /** @type {number[]} */
        const lengths = [];
        while (lengths.length < hlit + hdist) {
          const sym = clDecoder();
          if (sym < 16) {
            lengths.push(sym);
          } else if (sym === 16) {
            // Repeat counts must be read ONCE — the bit reader is consumed by
            // the read itself, so it cannot live in the loop condition.
            const repeat = 3 + bits(2);
            const prev = lengths[lengths.length - 1];
            for (let i = 0; i < repeat; i++) lengths.push(prev);
          } else if (sym === 17) {
            const repeat = 3 + bits(3);
            for (let i = 0; i < repeat; i++) lengths.push(0);
          } else {
            const repeat = 11 + bits(7);
            for (let i = 0; i < repeat; i++) lengths.push(0);
          }
        }
        litDecoder = makeDecoder(lengths.slice(0, hlit));
        distDecoder = makeDecoder(lengths.slice(hlit));
      } else {
        throw new Error("invalid deflate block type");
      }

      for (;;) {
        const sym = litDecoder();
        if (sym === 256) break;
        if (sym < 256) {
          out.push(sym);
        } else {
          const li = sym - 257;
          const length =
            lengthBase[li] + (lengthExtra[li] ? bits(lengthExtra[li]) : 0);
          const dsym = distDecoder();
          const distance =
            distBase[dsym] + (distExtra[dsym] ? bits(distExtra[dsym]) : 0);
          const from = out.length - distance;
          if (from < 0) throw new Error("deflate distance before start");
          for (let i = 0; i < length; i++) out.push(out[from + i]);
        }
      }
    }
    if (bfinal) break;
  }

  const consumed = ((bitPos + 7) >> 3) + 4; // round to byte + adler32
  return { bytes: Uint8Array.from(out), consumed };
}

/**
 * Reads a pack entry header: type, inflated size and delta-base reference.
 *
 * @param {Uint8Array} pack
 * @param {number} offset
 * @returns {{ type: number, size: number, baseOid?: string, baseOffset?: number, payloadOffset: number }}
 */
function readEntryHeader(pack, offset) {
  let cursor = offset;
  let byte = pack[cursor++];
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = pack[cursor++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  /** @type {{ type: number, size: number, baseOid?: string, baseOffset?: number, payloadOffset: number }} */
  const header = { type, size, payloadOffset: cursor };
  if (type === PackObjectType.OFS_DELTA) {
    let b = pack[cursor++];
    let distance = b & 0x7f;
    while (b & 0x80) {
      b = pack[cursor++];
      distance = ((distance + 1) << 7) | (b & 0x7f);
    }
    header.baseOffset = offset - distance;
    header.payloadOffset = cursor;
  } else if (type === PackObjectType.REF_DELTA) {
    header.baseOid = toHex(pack.subarray(cursor, cursor + 20));
    header.payloadOffset = cursor + 20;
  }
  return header;
}

/**
 * Parses a packfile into per-entry payloads (delta instructions for delta
 * entries, raw object bytes for others). Entries are returned in pack order
 * with their offsets and headers.
 *
 * @param {Uint8Array} pack
 * @returns {{ entries: any[], count: number }}
 */
export function parsePack(pack) {
  if (pack.length < 32) throw new Error("packfile too short");
  if (
    pack[0] !== 0x50 ||
    pack[1] !== 0x41 ||
    pack[2] !== 0x43 ||
    pack[3] !== 0x4b
  ) {
    throw new Error("bad packfile magic");
  }
  const version = readUint32(pack, 4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = readUint32(pack, 8);

  /** @type {any[]} */
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const header = readEntryHeader(pack, offset);
    const { bytes, consumed } = inflateWithBounds(
      pack.subarray(header.payloadOffset),
    );
    if (bytes.length !== header.size) {
      throw new Error(
        `pack entry at ${offset}: inflated ${bytes.length} bytes, header says ${header.size}`,
      );
    }
    entries.push({
      offset,
      type: header.type,
      size: header.size,
      baseOid: header.baseOid,
      baseOffset: header.baseOffset,
      data: bytes,
    });
    offset = header.payloadOffset + consumed;
  }
  return { entries, count };
}

/**
 * Applies a git binary delta to a base buffer.
 *
 * @param {Uint8Array} base
 * @param {Uint8Array} delta
 * @returns {Uint8Array}
 */
export function applyDelta(base, delta) {
  let cursor = 0;
  /** Reads a little-endian base-128 varint. @returns {number} */
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = delta[cursor++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value >>> 0;
  };

  const baseSize = varint();
  if (baseSize !== base.length) {
    throw new Error(
      `applyDelta base size mismatch (${baseSize} vs ${base.length})`,
    );
  }
  const targetSize = varint();
  const target = new Uint8Array(targetSize);
  let at = 0;

  while (cursor < delta.length) {
    const op = delta[cursor++];
    if (op & 0x80) {
      // Copy from base: build offset and size from the present operand bytes.
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[cursor++] << 0;
      if (op & 0x02) copyOffset |= delta[cursor++] << 8;
      if (op & 0x04) copyOffset |= delta[cursor++] << 16;
      if (op & 0x08) copyOffset |= delta[cursor++] << 24;
      if (op & 0x10) copySize |= delta[cursor++] << 0;
      if (op & 0x20) copySize |= delta[cursor++] << 8;
      if (op & 0x40) copySize |= delta[cursor++] << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) {
        throw new Error("delta copy outside base");
      }
      target.set(base.subarray(copyOffset, copyOffset + copySize), at);
      at += copySize;
    } else if (op > 0) {
      // Insert literal bytes.
      target.set(delta.subarray(cursor, cursor + op), at);
      cursor += op;
      at += op;
    } else {
      throw new Error("invalid delta opcode 0");
    }
  }
  if (at !== targetSize) {
    throw new Error(`delta produced ${at} bytes, expected ${targetSize}`);
  }
  return target;
}

/**
 * Computes a git object id: `SHA-1("<type> <size>\0" + raw)`.
 *
 * @param {string} type
 * @param {Uint8Array} raw
 * @returns {Promise<string>}
 */
export async function objectId(type, raw) {
  const header = new TextEncoder().encode(`${type} ${raw.length}\0`);
  const buf = new Uint8Array(header.length + raw.length);
  buf.set(header, 0);
  buf.set(raw, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return toHex(new Uint8Array(digest));
}

/**
 * Resolves a parsed pack into raw objects, following delta chains.
 * External REF_DELTA bases (objects not in the pack) are read from the
 * local object store via isomorphic-git.
 *
 * @param {object} options
 * @param {Uint8Array} options.pack
 * @param {any} [options.fs] - isomorphic-git filesystem client, for
 *   external delta-base lookup.
 * @param {string} [options.gitdir] - Local git directory.
 * @returns {Promise<{ objects: RawPackObject[], thin: boolean }>} `thin`
 *   is true when at least one delta base was resolved outside the pack.
 */
export async function resolvePack({ pack, fs, gitdir }) {
  const { entries } = parsePack(pack);

  /** @type {Map<number, RawPackObject>} */
  const byOffset = new Map();
  /** @type {Map<string, RawPackObject>} */
  const byOid = new Map();
  /** @type {RawPackObject[]} */
  const objects = [];

  /**
   * Resolves one entry to raw bytes, or `null` while its base is still
   * unresolved.
   * @param {any} entry
   * @returns {Promise<RawPackObject|null>}
   */
  const resolveEntry = async (entry) => {
    if (
      entry.type !== PackObjectType.OFS_DELTA &&
      entry.type !== PackObjectType.REF_DELTA
    ) {
      const type = TYPE_NAMES[entry.type];
      if (!type) throw new Error(`unknown pack type ${entry.type}`);
      return {
        offset: entry.offset,
        type,
        raw: entry.data,
        oid: await objectId(type, entry.data),
      };
    }
    /** @type {Uint8Array|null} */
    let base = null;
    if (entry.type === PackObjectType.OFS_DELTA) {
      const baseObj = byOffset.get(/** @type {number} */ (entry.baseOffset));
      base = baseObj ? baseObj.raw : null;
    } else {
      const oid = /** @type {string} */ (entry.baseOid);
      const inPack = byOid.get(oid);
      if (inPack) {
        base = inPack.raw;
      } else if (fs && gitdir) {
        const git = await import("isomorphic-git");
        const result = await git.readObject({
          fs,
          gitdir,
          oid,
          format: "content",
        });
        base = new Uint8Array(/** @type {Uint8Array} */ (result.object));
        entry.externalType = result.type;
        entry.externalBase = true;
      }
    }
    if (!base) return null;
    const raw = applyDelta(base, entry.data);
    // The delta target type is the base's type.
    const baseObj =
      entry.type === PackObjectType.OFS_DELTA
        ? byOffset.get(/** @type {number} */ (entry.baseOffset))
        : byOid.get(/** @type {string} */ (entry.baseOid));
    const type = baseObj ? baseObj.type : entry.externalType;
    return {
      offset: entry.offset,
      type,
      raw,
      oid: await objectId(type, raw),
    };
  };

  let thin = false;
  // Iterate to a fixpoint: OFS bases always precede their deltas, but
  // REF_DELTA bases may appear later in the pack.
  let pending = entries;
  for (;;) {
    let progress = false;
    /** @type {any[]} */
    const still = [];
    for (const entry of pending) {
      const resolved = await resolveEntry(entry);
      if (resolved) {
        byOffset.set(entry.offset, resolved);
        byOid.set(/** @type {string} */ (resolved.oid), resolved);
        objects.push(resolved);
        if (entry.externalBase) thin = true;
        progress = true;
      } else {
        still.push(entry);
      }
    }
    if (still.length === 0) break;
    if (!progress) {
      throw new Error(
        `pack has ${still.length} unresolved delta(s) with unavailable bases`,
      );
    }
    pending = still;
  }

  // Preserve the original pack order.
  objects.sort((a, b) => a.offset - b.offset);
  return { objects, thin };
}

/**
 * Builds a self-contained undeltified packfile from raw objects.
 *
 * @param {RawPackObject[]} objects
 * @returns {Promise<Uint8Array>}
 */
export async function buildPack(objects) {
  const typeCodes = {
    commit: PackObjectType.COMMIT,
    tree: PackObjectType.TREE,
    blob: PackObjectType.BLOB,
    tag: PackObjectType.TAG,
  };

  /** @type {Uint8Array[]} */
  const parts = [
    new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]),
    uint32(objects.length),
  ];

  for (const object of objects) {
    const code = typeCodes[/** @type {keyof typeof typeCodes} */ (object.type)];
    if (!code) throw new Error(`cannot pack object type ${object.type}`);
    // Entry header: (type << 4) | low 4 size bits, then little-endian 7-bit
    // groups with the continuation bit set while more groups follow.
    const size = object.raw.length;
    let value = size >>> 4;
    const first = (code << 4) | (size & 0x0f) | (value > 0 ? 0x80 : 0);
    /** @type {number[]} */
    const rest = [];
    while (value > 0) {
      rest.push(value & 0x7f);
      value >>>= 7;
      if (value > 0) rest[rest.length - 1] |= 0x80;
    }
    parts.push(new Uint8Array([first, ...rest]));
    parts.push(await deflate(object.raw));
  }

  const body = concat(parts);
  const digest = await crypto.subtle.digest("SHA-1", body);
  const out = new Uint8Array(body.length + 20);
  out.set(body, 0);
  out.set(new Uint8Array(digest), body.length);
  return out;
}

/**
 * Fattens a possibly-thin bundle pack into a self-contained one, resolving
 * external delta bases from the local object store. A pack that is already
 * self-contained is returned as-is.
 *
 * @param {object} options
 * @param {Uint8Array} options.pack
 * @param {any} [options.fs]
 * @param {string} [options.gitdir]
 * @returns {Promise<Uint8Array>}
 */
export async function fattenPack({ pack, fs, gitdir }) {
  const { objects, thin } = await resolvePack({ pack, fs, gitdir });
  if (!thin) return pack;
  return await buildPack(objects);
}

// ---------------------------------------------------------------------
// Small byte helpers
// ---------------------------------------------------------------------

/** @param {Uint8Array} b @param {number} off */
function readUint32(b, off) {
  return (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
}

/** @param {number} v */
function uint32(v) {
  return new Uint8Array([
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ]);
}

/** @param {Uint8Array[]} chunks */
function concat(chunks) {
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Deflates data with zlib wrapping via the web-platform CompressionStream.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
async function deflate(data) {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  writer.write(/** @type {BufferSource} */ (/** @type {unknown} */ (data)));
  writer.close();
  const reader = stream.readable.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** @param {Uint8Array} bytes */
function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
