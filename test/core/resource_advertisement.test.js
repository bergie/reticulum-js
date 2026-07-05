import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ResourceAdvertisement } from "../../src/core/resource_advertisement.js";

describe("ResourceAdvertisement", () => {
  test("pack and unpack should be inverses", () => {
    const adv = new ResourceAdvertisement({
      t: 1000,
      d: 1000,
      n: 5,
      h: new Uint8Array(32).fill(0x01),
      r: new Uint8Array(16).fill(0x02),
      o: new Uint8Array(32).fill(0x03),
      i: 1,
      l: 5,
      q: new Uint8Array(16).fill(0x04),
      f: 0b00001111, // flags: e=1, c=1, s=1, u=1
      m: new Uint8Array(10).fill(0x05),
    });

    const encoded = adv.pack();
    const decoded = ResourceAdvertisement.unpack(encoded);

    assert.equal(decoded.t, adv.t);
    assert.equal(decoded.d, adv.d);
    assert.equal(decoded.n, adv.n);
    assert.deepEqual(decoded.h, adv.h);
    assert.deepEqual(decoded.r, adv.r);
    assert.deepEqual(decoded.o, adv.o);
    assert.equal(decoded.i, adv.i);
    assert.equal(decoded.l, adv.l);
    assert.deepEqual(decoded.q, adv.q);
    assert.equal(decoded.f, adv.f);
    assert.deepEqual(decoded.m, adv.m);

    // Test flag decoding
    assert.equal(decoded.e, true);
    assert.equal(decoded.c, true);
    assert.equal(decoded.s, true);
    assert.equal(decoded.u, true);
  });

  test("isRequest and isResponse helpers", () => {
    const reqAdv = new ResourceAdvertisement({ f: 0b00001000 }); // u=1
    const respAdv = new ResourceAdvertisement({ f: 0b00010000 }); // p=1
    const noneAdv = new ResourceAdvertisement({ f: 0 });

    assert.strictEqual(ResourceAdvertisement.isRequest(reqAdv), true);
    assert.strictEqual(ResourceAdvertisement.isRequest(respAdv), false);
    assert.strictEqual(ResourceAdvertisement.isRequest(noneAdv), false);

    assert.strictEqual(ResourceAdvertisement.isResponse(respAdv), true);
    assert.strictEqual(ResourceAdvertisement.isResponse(reqAdv), false);
    assert.strictEqual(ResourceAdvertisement.isResponse(noneAdv), false);
  });
});
