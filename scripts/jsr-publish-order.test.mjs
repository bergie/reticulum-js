import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computePublishOrder } from "./jsr-publish-order.mjs";

/**
 * Creates a fixture packages tree.
 * @param {string} root
 * @param {Record<string, { deps?: string[], jsr?: boolean }>} pkgs - dir →
 *   package.json `dependencies` map + whether it has a jsr.json.
 */
function fixture(root, pkgs) {
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [dir, spec] of Object.entries(pkgs)) {
    const dirPath = join(root, "packages", dir);
    mkdirSync(dirPath, { recursive: true });
    const deps = Object.fromEntries(
      (spec.deps ?? []).map((d) => [
        d.startsWith("@") ? d : `@reticulum/${d}`,
        "^0.9.0",
      ]),
    );
    writeFileSync(
      join(dirPath, "package.json"),
      JSON.stringify({
        name: `@reticulum/${dir}`,
        ...(spec.jsr === false ? {} : {}),
        dependencies: deps,
      }),
    );
    if (spec.jsr !== false) {
      writeFileSync(
        join(dirPath, "jsr.json"),
        JSON.stringify({ name: `@reticulum/${dir}`, version: "0.9.0" }),
      );
    }
  }
}

/** @returns {string} */
function makeRoot() {
  return mkdtempSync(join(tmpdir(), "jsr-order-"));
}

test("dependencies publish before dependents", () => {
  // node depends on rfed (which failed the 0.9.0 CI publish when the
  // alphabetical glob published node first).
  const root = makeRoot();
  try {
    fixture(root, {
      core: { deps: [] },
      lxmf: { deps: ["core"] },
      rfed: { deps: ["core", "lxmf"] },
      node: { deps: ["core", "lxmf", "rfed"] },
    });
    const order = computePublishOrder(root);
    assert.ok(order.indexOf("core") < order.indexOf("lxmf"));
    assert.ok(order.indexOf("lxmf") < order.indexOf("rfed"));
    assert.ok(order.indexOf("rfed") < order.indexOf("node"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent packages keep alphabetical order among ready peers", () => {
  const root = makeRoot();
  try {
    fixture(root, {
      core: { deps: [] },
      zebra: { deps: [] },
      alpha: { deps: [] },
    });
    assert.deepEqual(computePublishOrder(root), ["alpha", "core", "zebra"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directories without a jsr.json are skipped; external deps ignored", () => {
  const root = makeRoot();
  try {
    fixture(root, {
      core: { deps: [] },
      "not-a-jsr-package": { deps: [], jsr: false },
      rngit: {
        deps: [
          "core",
          // External deps appear in package.json dependencies; they must not
          // be waited for.
          "@external/thing",
        ],
      },
    });
    const order = computePublishOrder(root);
    assert.deepEqual(order, ["core", "rngit"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dependency cycle throws instead of looping forever", () => {
  const root = makeRoot();
  try {
    fixture(root, {
      a: { deps: ["b"] },
      b: { deps: ["a"] },
    });
    assert.throws(
      () => computePublishOrder(root),
      /Cyclic @reticulum dependency/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real packages tree publishes rfed before node", () => {
  // The regression the 0.9.0 release hit: `packages/*/` glob order published
  // node before rfed, and JSR resolves `jsr:` deps at publish time.
  const order = computePublishOrder(process.cwd());
  assert.ok(order.includes("node") && order.includes("rfed"));
  assert.ok(
    order.indexOf("rfed") < order.indexOf("node"),
    `expected rfed before node, got: ${order.join(", ")}`,
  );
});
