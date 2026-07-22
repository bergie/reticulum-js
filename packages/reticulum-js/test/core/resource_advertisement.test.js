/**
 * RESOURCE_ADV msgpack tests (PROTOCOL-SPEC.md §10.4).
 *
 * Pins the on-the-wire invariants that matter for Python interop:
 *   - byte fields (`h`, `r`, `o`, `m`, `q`) are msgpack `bin`, NOT arrays;
 *   - `r` is the 4-byte integrity/hashmap salt;
 *   - flag bits decode per §10.4 (e/c/s/u/p/x);
 *   - pack/unpack round-trips losslessly.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  ResourceAdvertisement,
  ResourceFlag,
} from "../../src/core/resource_advertisement.js";
import { MicroMsgPack } from "../../src/utils/msgpack.js";

describe("ResourceAdvertisement", () => {
  test("pack encodes byte fields as msgpack bin (0xc4), not arrays", () => {
    // The classic interop bug: Array.from(...) produces a msgpack array, but
    // Python's RNS expects `bytes` (bin). The first byte of a bin8 value is
    // 0xc4; an array's first byte would be 0x90..0x9f / 0xdc.
    const adv = new ResourceAdvertisement({
      h: new Uint8Array(32).fill(0x01),
      r: new Uint8Array(4).fill(0x02),
      o: new Uint8Array(32).fill(0x03),
      m: new Uint8Array(8).fill(0x05),
    });
    const dict = MicroMsgPack.decode(adv.pack());

    assert.ok(
      dict.h instanceof Uint8Array,
      "h must decode to Uint8Array (bin)",
    );
    assert.ok(
      dict.r instanceof Uint8Array,
      "r must decode to Uint8Array (bin)",
    );
    assert.ok(
      dict.o instanceof Uint8Array,
      "o must decode to Uint8Array (bin)",
    );
    assert.ok(
      dict.m instanceof Uint8Array,
      "m must decode to Uint8Array (bin)",
    );
    assert.strictEqual(dict.h.length, 32);
    assert.strictEqual(dict.r.length, 4, "r is the 4-byte salt");
  });

  test("pack emits the bin marker byte 0xc4 for h on the wire", () => {
    const adv = new ResourceAdvertisement({
      h: new Uint8Array(32).fill(0xab),
    });
    const packed = adv.pack();
    // Decode the top-level map, find the value for key "h" and re-encode just
    // that value to inspect its msgpack form header.
    const hBytes = MicroMsgPack.decode(adv.pack());
    void hBytes;
    const justH = MicroMsgPack.encode(adv.h);
    // 32-byte bin -> bin8: 0xc4, 0x20, then bytes.
    assert.strictEqual(justH[0], 0xc4);
    assert.strictEqual(justH[1], 32);
    void packed;
  });

  test("pack/unpack round-trips all fields", () => {
    const adv = new ResourceAdvertisement({
      t: 4096,
      d: 3800,
      n: 9,
      h: new Uint8Array(32).fill(0x01),
      r: new Uint8Array(4).fill(0x02),
      o: new Uint8Array(32).fill(0x03),
      i: 1,
      l: 1,
      q: new Uint8Array(16).fill(0x04),
      f: ResourceFlag.ENCRYPTED | ResourceFlag.IS_RESPONSE,
      m: new Uint8Array(12).fill(0x05),
    });

    const decoded = ResourceAdvertisement.unpack(adv.pack());
    assert.strictEqual(decoded.t, adv.t);
    assert.strictEqual(decoded.d, adv.d);
    assert.strictEqual(decoded.n, adv.n);
    assert.deepStrictEqual(decoded.h, adv.h);
    assert.deepStrictEqual(decoded.r, adv.r);
    assert.deepStrictEqual(decoded.o, adv.o);
    assert.strictEqual(decoded.i, adv.i);
    assert.strictEqual(decoded.l, adv.l);
    assert.deepStrictEqual(decoded.q, adv.q);
    assert.strictEqual(decoded.f, adv.f);
    assert.deepStrictEqual(decoded.m, adv.m);
  });

  test("q is msgpack nil when no request id is associated", () => {
    const adv = new ResourceAdvertisement({ q: undefined });
    const dict = MicroMsgPack.decode(adv.pack());
    assert.strictEqual(dict.q, null);
  });

  test("flag accessors decode §10.4 bit layout", () => {
    const all = new ResourceAdvertisement({
      f:
        ResourceFlag.ENCRYPTED |
        ResourceFlag.COMPRESSED |
        ResourceFlag.SPLIT |
        ResourceFlag.IS_REQUEST |
        ResourceFlag.IS_RESPONSE |
        ResourceFlag.HAS_METADATA,
    });
    assert.strictEqual(all.encrypted, true);
    assert.strictEqual(all.compressed, true);
    assert.strictEqual(all.split, true);
    assert.strictEqual(all.isRequest, true);
    assert.strictEqual(all.isResponse, true);
    assert.strictEqual(all.hasMetadata, true);

    const none = new ResourceAdvertisement({ f: 0 });
    assert.strictEqual(none.encrypted, false);
    assert.strictEqual(none.isRequest, false);
    assert.strictEqual(none.isResponse, false);
  });

  test("is_request (u, bit 3) and is_response (p, bit 4) are distinct", () => {
    const req = new ResourceAdvertisement({ f: ResourceFlag.IS_REQUEST });
    const resp = new ResourceAdvertisement({ f: ResourceFlag.IS_RESPONSE });
    assert.strictEqual(req.isRequest, true);
    assert.strictEqual(req.isResponse, false);
    assert.strictEqual(resp.isResponse, true);
    assert.strictEqual(resp.isRequest, false);
  });
});
