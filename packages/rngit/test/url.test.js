/**
 * Unit tests for `rns://` remote URL handling.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  fromPlaceholderHttpUrl,
  parseRemoteUrl,
  RemoteUrlError,
  stringifyRemoteUrl,
  toPlaceholderHttpUrl,
} from "../src/url.js";

const HASH = "3ea5aad068a337670f5bb8073226adb4";
const URL = `rns://${HASH}/public/reticulum-js`;

describe("parseRemoteUrl", () => {
  test("parses rns:// URLs", () => {
    const r = parseRemoteUrl(URL);
    assert.equal(r.hashHex, HASH);
    assert.equal(r.group, "public");
    assert.equal(r.repo, "reticulum-js");
    assert.equal(r.repoPath, "public/reticulum-js");
  });

  test("accepts the scheme-less form", () => {
    const r = parseRemoteUrl(`${HASH}/public/reticulum-js`);
    assert.equal(r.repoPath, "public/reticulum-js");
  });

  test("rejects bad input", () => {
    assert.throws(() => parseRemoteUrl(""), RemoteUrlError);
    assert.throws(() => parseRemoteUrl("rns://short/x/y"), RemoteUrlError);
    assert.throws(
      () => parseRemoteUrl(`rns://${"z".repeat(32)}/x/y`),
      RemoteUrlError,
    );
    assert.throws(
      () => parseRemoteUrl(`rns://${HASH}/only-two`),
      RemoteUrlError,
    );
    assert.throws(() => parseRemoteUrl(`rns://${HASH}/a/b/c`), RemoteUrlError);
    assert.throws(
      () => parseRemoteUrl("https://example.com/x/y"),
      RemoteUrlError,
    );
  });
});

describe("stringifyRemoteUrl", () => {
  test("renders canonical form", () => {
    assert.equal(
      stringifyRemoteUrl(parseRemoteUrl(URL)),
      `rns://${HASH}/public/reticulum-js`,
    );
  });
});

describe("placeholder URL mapping", () => {
  test("round trips through the isomorphic-git placeholder", () => {
    const placeholder = toPlaceholderHttpUrl(URL);
    assert.ok(placeholder.startsWith("http://rngit/"));
    const restored = fromPlaceholderHttpUrl(placeholder);
    assert.ok(restored);
    assert.equal(restored.repoPath, "public/reticulum-js");
    assert.equal(restored.hashHex, HASH);
  });

  test("extracts remote from full request URLs", () => {
    const remote = fromPlaceholderHttpUrl(
      `${toPlaceholderHttpUrl(URL)}/info/refs?service=git-upload-pack`,
    );
    assert.ok(remote);
    assert.equal(remote.repoPath, "public/reticulum-js");
  });

  test("rejects foreign URLs", () => {
    assert.equal(fromPlaceholderHttpUrl("http://example.com/a/b/c"), null);
    assert.equal(fromPlaceholderHttpUrl(`http://rngit/${HASH}/only-two`), null);
    assert.equal(fromPlaceholderHttpUrl("not a url"), null);
  });
});
