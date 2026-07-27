import assert from "node:assert";
import { describe, it } from "node:test";
import msgpack from "@ably/msgpack-js";
import { MicroMsgPack } from "../../src/utils/msgpack.js";

function base64(arr) {
  return Buffer.from(arr).toString("base64");
}

describe("MicroMsgPack implementation", () => {
  it("Should serialize simple object the same as a real library", () => {
    const content = {
      foo: "bar",
      baz: 42,
      foobar: 42.7,
      barbaz: new Map(),
    };
    assert.equal(
      base64(MicroMsgPack.encode(content)),
      base64(msgpack.encode(content)),
    );
  });
  it("Should unserialize simple object the same as a real library", () => {
    const content = {
      foo: "bar",
      baz: 42,
      foobar: 42.7,
      barbaz: {
        15: true,
      },
    };
    const serialized = msgpack.encode(content);
    assert.deepEqual(MicroMsgPack.decode(serialized), content);
  });
});

describe("MicroMsgPack hardening (untrusted-input defenses)", () => {
  it("does not let a `__proto__` map key hijack the decoded object's prototype", () => {
    // A crafted map with a "__proto__" string key used to reassign the decoded
    // object's prototype chain via the Object.prototype __proto__ setter.
    // (Encode via a Map so the literal-string key survives encoding — an
    // object literal `{__proto__: ...}` would set the prototype instead.)
    const encoded = MicroMsgPack.encode(
      new Map([["__proto__", { polluted: true }]]),
    );
    const decoded = MicroMsgPack.decode(encoded);

    // The prototype chain must be intact.
    assert.strictEqual(
      Object.getPrototypeOf(decoded),
      Object.prototype,
      "decoded object keeps Object.prototype",
    );
    assert.strictEqual(
      // @ts-expect-error -- must not gain an attacker-supplied inherited prop
      decoded.polluted,
      undefined,
      "inherited method is not attacker-controlled",
    );
    // And the value is still retrievable as a normal own property.
    assert.ok(
      Object.hasOwn(decoded, "__proto__"),
      "__proto__ is stored as a plain own data property",
    );
    assert.deepStrictEqual(decoded["__proto__"], { polluted: true });
  });

  it("stores `constructor`/`prototype` keys as own props without touching the prototype chain", () => {
    const encoded = MicroMsgPack.encode({
      constructor: "evil",
      prototype: "also-evil",
    });
    const decoded = MicroMsgPack.decode(encoded);
    // Values are faithfully retrievable.
    assert.strictEqual(decoded["constructor"], "evil");
    assert.strictEqual(decoded["prototype"], "also-evil");
    // And the prototype chain is untouched (the real attack is __proto__).
    assert.strictEqual(Object.getPrototypeOf(decoded), Object.prototype);
    // @ts-expect-error -- must not gain an attacker-supplied inherited prop
    assert.strictEqual(decoded.polluted, undefined);
  });

  it("rejects deeply-nested structures instead of blowing the stack", () => {
    // A tiny payload of nested single-element fixarrays: ~0x91 per level.
    const depth = 5000;
    const bytes = new Uint8Array(depth);
    bytes.fill(0x91);
    assert.throws(
      () => MicroMsgPack.decode(bytes),
      /depth/,
      "deeply nested payload must throw, not stack-overflow",
    );
  });

  it("still decodes legitimately-nested structures", () => {
    // 10 levels of nesting is well within the limit and must still decode.
    let inner = 42;
    for (let i = 0; i < 10; i++) inner = [inner];
    const decoded = MicroMsgPack.decode(MicroMsgPack.encode(inner));
    assert.deepEqual(decoded, [[[[[[[[[[42]]]]]]]]]]);
  });

  it("throws on a bin length that exceeds the available bytes (no silent truncation)", () => {
    // bin 8 with a claimed length of 1_000_000 but only a few trailing bytes.
    // ArrayBuffer.slice() silently clamps this, so an explicit bounds check is
    // required to reject it instead of returning a short, corrupted buffer.
    const bytes = new Uint8Array([0xc6, 0x00, 0x0f, 0x42, 0x40, 0x01, 0x02]);
    assert.throws(
      () => MicroMsgPack.decode(bytes),
      /exceeds available data/i,
      "oversized bin length must throw",
    );
  });

  it("decodes a normal bin payload correctly", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const decoded = MicroMsgPack.decode(MicroMsgPack.encode(payload));
    assert.ok(decoded instanceof Uint8Array);
    assert.deepEqual(Array.from(decoded), [1, 2, 3, 4, 5]);
  });
});
