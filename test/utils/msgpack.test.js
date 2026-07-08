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
        '15': true,
      },
    };
    const serialized = msgpack.encode(content);
    assert.deepEqual(MicroMsgPack.decode(serialized), content);
  });
});
