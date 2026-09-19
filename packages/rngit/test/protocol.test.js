/**
 * Unit tests for the rngit wire protocol helpers: msgpack framing with
 * integer map keys, status-byte responses and /git/list parsing.
 *
 * The msgpack byte vectors are cross-checked against fixtures generated
 * with the Python reference implementation, so the integer-key requirement
 * of rngit nodes is verified on the wire, not just structurally.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MsgPack } from "@reticulum/core";
import {
  buildRequest,
  IDX_REPOSITORY,
  parseListResponse,
  parseStatusResponse,
  RES_INVALID_REQ,
  RES_OK,
  RngitStatusError,
  resultCodeFromMetadata,
} from "../src/protocol.js";

const encoder = new TextEncoder();

describe("buildRequest", () => {
  test("keeps the repository key integral on the wire", () => {
    // Reference vector: msgpack.packb({0: "public/repo"})
    const packed = MsgPack.encode(buildRequest("public/repo"));
    const hex = Buffer.from(packed).toString("hex");
    assert.equal(hex, "8100ab7075626c69632f7265706f");
  });

  test("merges string-keyed fields", () => {
    const request = buildRequest("public/repo", { for_push: true });
    const decoded = MsgPack.decode(MsgPack.encode(request));
    assert.equal(decoded[IDX_REPOSITORY], "public/repo");
    assert.equal(decoded.for_push, true);
  });

  test("drops undefined fields", () => {
    const request = buildRequest("public/repo", { have: undefined });
    const decoded = MsgPack.decode(MsgPack.encode(request));
    assert.equal("have" in decoded, false);
  });
});

describe("parseStatusResponse", () => {
  test("splits status byte and message", () => {
    const response = concat(
      new Uint8Array([RES_INVALID_REQ]),
      encoder.encode("Invalid request"),
    );
    const { status, message } = parseStatusResponse(response);
    assert.equal(status, RES_INVALID_REQ);
    assert.equal(message, "Invalid request");
  });

  test("rejects empty responses", () => {
    assert.throws(() => parseStatusResponse(new Uint8Array(0)));
    // @ts-expect-error wrong type on purpose
    assert.throws(() => parseStatusResponse("nope"));
  });
});

describe("parseListResponse", () => {
  test("parses refs and the @HEAD marker", () => {
    const body = concat(
      new Uint8Array([RES_OK]),
      encoder.encode(
        "4b825dc642cb6eb9a060e54bf899d69f82cf7167 refs/heads/main\n" +
          "f7d1b8b3a2c4e5f60718293a4b5c6d7e8f9a0b1c refs/tags/v1.0\n" +
          "@refs/heads/main HEAD\n",
      ),
    );
    const { head, refs } = parseListResponse(body);
    assert.equal(head, "refs/heads/main");
    assert.equal(refs.size, 2);
    assert.equal(
      refs.get("refs/heads/main"),
      "4b825dc642cb6eb9a060e54bf899d69f82cf7167",
    );
    assert.equal(
      refs.get("refs/tags/v1.0"),
      "f7d1b8b3a2c4e5f60718293a4b5c6d7e8f9a0b1c",
    );
  });

  test("handles a repo with only HEAD advertised", () => {
    const body = concat(
      new Uint8Array([RES_OK]),
      encoder.encode("@refs/heads/master HEAD\n"),
    );
    const { head, refs } = parseListResponse(body);
    assert.equal(head, "refs/heads/master");
    assert.equal(refs.size, 0);
  });

  test("throws on non-zero status", () => {
    const body = concat(new Uint8Array([0x03]), encoder.encode("Not found"));
    assert.throws(() => parseListResponse(body), RngitStatusError);
  });
});

describe("resultCodeFromMetadata", () => {
  test("reads integer keys from objects and maps", () => {
    assert.equal(resultCodeFromMetadata({ 1: 0 }), 0);
    assert.equal(resultCodeFromMetadata(new Map([[1, 0]])), 0);
    assert.equal(resultCodeFromMetadata(new Map([[1, 0xff]])), 0xff);
    assert.equal(resultCodeFromMetadata({}), undefined);
    assert.equal(resultCodeFromMetadata(null), undefined);
    assert.equal(resultCodeFromMetadata(undefined), undefined);
  });
});

/** @param {...Uint8Array} chunks */
function concat(...chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
