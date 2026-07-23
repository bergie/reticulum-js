import assert from "node:assert/strict";
import { test } from "node:test";
import { applyVersionBump } from "./release.mjs";

test("applyVersionBump bumps version and rewrites internal dep refs", () => {
  const before = {
    name: "@reticulum/node",
    version: "0.3.0",
    dependencies: { "@reticulum/core": "^0.3.0", werift: "^0.23.0" },
  };
  const after = applyVersionBump(before, "0.4.0");
  assert.equal(after.version, "0.4.0");
  assert.equal(after.dependencies["@reticulum/core"], "^0.4.0");
  // external dep untouched
  assert.equal(after.dependencies.werift, "^0.23.0");
  // input not mutated
  assert.equal(before.version, "0.3.0");
  assert.equal(before.dependencies["@reticulum/core"], "^0.3.0");
  assert.notEqual(after.dependencies, before.dependencies);
});

test("applyVersionBump leaves packages without the internal dep alone", () => {
  const core = { name: "@reticulum/core", version: "0.3.0" };
  const after = applyVersionBump(core, "0.4.0");
  assert.equal(after.version, "0.4.0");
  assert.equal(after.dependencies, undefined);
  assert.equal(core.version, "0.3.0");
});
