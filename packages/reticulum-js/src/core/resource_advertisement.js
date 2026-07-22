/**
 * @file resource_advertisement.js
 * @description RESOURCE_ADV msgpack encoding/decoding (PROTOCOL-SPEC.md §10.4).
 */

import { MicroMsgPack } from "../utils/msgpack.js";

/**
 * Bit layout of the RESOURCE_ADV `f` flags byte (PROTOCOL-SPEC.md §10.4):
 *
 * ```
 * bit 0 : e — encrypted
 * bit 1 : c — compressed
 * bit 2 : s — split (multi-segment)
 * bit 3 : u — is_request  (Resource carries a Link REQUEST body)
 * bit 4 : p — is_response (Resource carries a Link RESPONSE body)
 * bit 5 : x — has_metadata
 * ```
 *
 * @enum {number}
 */
export const ResourceFlag = {
  ENCRYPTED: 1 << 0,
  COMPRESSED: 1 << 1,
  SPLIT: 1 << 2,
  IS_REQUEST: 1 << 3,
  IS_RESPONSE: 1 << 4,
  HAS_METADATA: 1 << 5,
};

/**
 * Represents a RESOURCE_ADV — the advertisement that opens a Resource transfer.
 *
 * The wire form is a single msgpack map (PROTOCOL-SPEC.md §10.4). The byte
 * fields (`h`, `r`, `o`, `m`, `q`) MUST be msgpack `bin` (Python `bytes`), not
 * arrays — encoding them via `Array.from(...)` produces a msgpack array and
 * silently breaks Python interop. Keys are emitted in upstream's order so the
 * packed bytes match Python `umsgpack.packb` output for vector testing.
 *
 * Note that `r` is the 4-byte integrity/hashmap salt (`get_random_hash()[:4]`),
 * NOT the leading wire prefix that the receiver strips (§10.2 step 3 / §10.8).
 */
export class ResourceAdvertisement {
  /**
   * @param {Object} options
   * @param {number} [options.t] - Transfer size (encrypted byte length on wire).
   * @param {number} [options.d] - Total logical size (original uncompressed).
   * @param {number} [options.n] - Number of parts in this segment.
   * @param {Uint8Array} [options.h] - Resource hash `SHA-256(plaintext ‖ r)` (32B).
   * @param {Uint8Array} [options.r] - Random hash salt (4B).
   * @param {Uint8Array} [options.o] - Original hash of first segment (32B).
   * @param {number} [options.i] - Segment index (1-based).
   * @param {number} [options.l] - Total segments.
   * @param {Uint8Array} [options.q] - Associated REQUEST id, or undefined/None.
   * @param {number} [options.f] - Flags byte.
   * @param {Uint8Array} [options.m] - Hashmap fragment (concatenated 4B map_hashes).
   */
  constructor(options = {}) {
    this.t = options.t || 0;
    this.d = options.d || 0;
    this.n = options.n || 0;
    this.h = options.h || new Uint8Array(0);
    this.r = options.r || new Uint8Array(0);
    this.o = options.o || new Uint8Array(0);
    this.i = options.i || 0;
    this.l = options.l || 0;
    this.q = options.q || undefined;
    this.f = options.f || 0;
    this.m = options.m || new Uint8Array(0);
  }

  // --- Flag accessors (decoded from `f`) ---

  /** @returns {boolean} */
  get encrypted() {
    return !!((this.f >> 0) & 0x01);
  }
  /** @returns {boolean} */
  get compressed() {
    return !!((this.f >> 1) & 0x01);
  }
  /** @returns {boolean} */
  get split() {
    return !!((this.f >> 2) & 0x01);
  }
  /** @returns {boolean} */
  get isRequest() {
    return !!((this.f >> 3) & 0x01);
  }
  /** @returns {boolean} */
  get isResponse() {
    return !!((this.f >> 4) & 0x01);
  }
  /** @returns {boolean} */
  get hasMetadata() {
    return !!((this.f >> 5) & 0x01);
  }

  /**
   * Packs the advertisement into a msgpack `bin`-correct Uint8Array.
   * @returns {Uint8Array}
   */
  pack() {
    // Key order matches `RNS/Resource.py` ResourceAdvertisement so packed
    // bytes are comparable against Python vectors. Byte fields are passed as
    // Uint8Array directly so MicroMsgPack emits `bin` (not an array).
    /** @type {Record<string, any>} */
    const dict = {
      t: this.t,
      d: this.d,
      n: this.n,
      h: this.h,
      r: this.r,
      o: this.o,
      i: this.i,
      l: this.l,
      q: this.q ?? null,
      f: this.f,
      m: this.m,
    };
    return MicroMsgPack.encode(dict);
  }

  /**
   * Unpacks an advertisement from its msgpack wire form.
   * @param {Uint8Array} data
   * @returns {ResourceAdvertisement}
   */
  static unpack(data) {
    /** @type {any} */
    const dict = MicroMsgPack.decode(data);
    return new ResourceAdvertisement({
      t: dict.t,
      d: dict.d,
      n: dict.n,
      // MicroMsgPack decodes `bin` to Uint8Array; copy to detach the buffer.
      h: new Uint8Array(dict.h),
      r: new Uint8Array(dict.r),
      o: new Uint8Array(dict.o),
      i: dict.i,
      l: dict.l,
      q: dict.q ? new Uint8Array(dict.q) : undefined,
      f: dict.f,
      m: new Uint8Array(dict.m),
    });
  }
}
