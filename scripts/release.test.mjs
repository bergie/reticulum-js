import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyVersionBump, packageMetas } from "./release.mjs";

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

test("applyVersionBump bumps a jsr.json-shaped manifest (version only)", () => {
  const jsr = {
    name: "@reticulum/core",
    version: "0.3.0",
    exports: { ".": "./src/index.js" },
    publish: { include: ["src/"] },
  };
  const after = applyVersionBump(jsr, "0.4.0");
  assert.equal(after.version, "0.4.0");
  // non-version fields preserved
  assert.deepEqual(after.exports, { ".": "./src/index.js" });
  assert.deepEqual(after.publish, { include: ["src/"] });
  // input not mutated
  assert.equal(jsr.version, "0.3.0");
});

test("packageMetas picks up jsr.json next to package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "release-jsr-"));
  try {
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    mkdirSync(join(root, "packages", "bare"), { recursive: true });

    writeFileSync(
      join(root, "packages", "core", "package.json"),
      JSON.stringify({ name: "@reticulum/core", version: "0.3.0" }),
    );
    writeFileSync(
      join(root, "packages", "core", "jsr.json"),
      JSON.stringify({
        name: "@reticulum/core",
        version: "0.3.0",
        exports: { ".": "./src/index.js" },
      }),
    );
    writeFileSync(
      join(root, "packages", "bare", "package.json"),
      JSON.stringify({ name: "@reticulum/bare", version: "0.3.0" }),
    );

    const metas = packageMetas(root);
    const core = metas.find((m) => m.name === "core");
    assert.ok(core.jsrPath);
    assert.ok(existsSync(core.jsrPath));
    assert.equal(core.jsrJson.version, "0.3.0");

    const bare = metas.find((m) => m.name === "bare");
    assert.equal(bare.jsrPath, null);
    assert.equal(bare.jsrJson, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
