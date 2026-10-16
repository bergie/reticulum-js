import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeWorkspaceOrder } from "./npm-run-topo.mjs";

/**
 * Creates a fixture packages tree.
 * @param {string} root
 * @param {Record<string, { deps?: string[], name?: string }>} pkgs - dir →
 *   `@reticulum/*` dependency list (short names) and optional package name.
 */
function fixture(root, pkgs) {
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [dir, spec] of Object.entries(pkgs)) {
    const dirPath = join(root, "packages", dir);
    mkdirSync(dirPath, { recursive: true });
    const deps = Object.fromEntries(
      (spec.deps ?? []).map((d) => [`@reticulum/${d}`, "^0.9.0"]),
    );
    writeFileSync(
      join(dirPath, "package.json"),
      JSON.stringify({
        name: spec.name ?? `@reticulum/${dir}`,
        dependencies: deps,
      }),
    );
  }
}

/** @returns {string} */
function makeRoot() {
  return mkdtempSync(join(tmpdir(), "npm-run-topo-"));
}

test("dependencies come before dependents", () => {
  // node type-checks against rfed's generated declarations, so rfed's
  // `types` script must run first (this exact pair broke the site build).
  const root = makeRoot();
  try {
    fixture(root, {
      core: { deps: [] },
      lxmf: { deps: ["core"] },
      rfed: { deps: ["core", "lxmf"] },
      node: { deps: ["core", "lxmf", "rfed"] },
    });
    const order = computeWorkspaceOrder(root);
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
    assert.deepEqual(computeWorkspaceOrder(root), ["alpha", "core", "zebra"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directories without a package.json are skipped; external deps ignored", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "packages", "not-a-package"), { recursive: true });
    fixture(root, {
      core: { deps: [] },
      rngit: {
        deps: [
          "core",
          // External deps appear in package.json dependencies; they must not
          // be waited for.
          "@external/thing",
        ],
      },
    });
    assert.deepEqual(computeWorkspaceOrder(root), ["core", "rngit"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packages are matched by name, not directory name", () => {
  const root = makeRoot();
  try {
    fixture(root, {
      "some-dir": { name: "@reticulum/renamed", deps: [] },
      dependent: { deps: ["renamed"] },
    });
    const order = computeWorkspaceOrder(root);
    assert.ok(order.indexOf("some-dir") < order.indexOf("dependent"));
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
      () => computeWorkspaceOrder(root),
      /Cyclic @reticulum dependency/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real workspace order generates rfed types before node", () => {
  // The regression the site build hit twice: alphabetical workspace order
  // ran node's tsc before rfed regenerated its git-ignored declarations.
  const order = computeWorkspaceOrder(process.cwd());
  assert.ok(order.includes("rfed") && order.includes("node"));
  assert.ok(
    order.indexOf("rfed") < order.indexOf("node"),
    `expected rfed before node, got: ${order.join(", ")}`,
  );
});
