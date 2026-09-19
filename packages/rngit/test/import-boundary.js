import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * @file import-boundary.js
 * @description Enforces the dependency policy for `@reticulum/rngit`:
 *   the import graph reachable from `src/index.js` must stay free of
 *   Node.js dependencies (browser-safe), and third-party (bare) runtime
 *   specifiers are limited to the sanctioned ones — the workspace
 *   dependency on `@reticulum/core` plus this package's purpose-built
 *   dependencies (`isomorphic-git`, `@digitaldefiance/bzip2-wasm`).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "index.js");

/** @type {Set<string>} */
const ALLOWED_BARE = new Set([
  "@reticulum/core",
  "isomorphic-git",
  "@digitaldefiance/bzip2-wasm",
]);

/**
 * Extracts the module specifiers of all static ESM imports and `export … from`
 * declarations in a source file.
 * @param {string} filePath
 * @returns {string[]}
 */
function extractModuleSpecifiers(filePath) {
  const source = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  /** @type {string[]} */
  const specs = [];
  sf.forEachChild((node) => {
    /** @type {ts.StringLiteral | undefined} */
    let specifier;
    if (ts.isImportDeclaration(node)) {
      specifier = /** @type {ts.StringLiteral} */ (node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      specifier = /** @type {ts.StringLiteral} */ (node.moduleSpecifier);
    }
    if (specifier && ts.isStringLiteral(/** @type {any} */ (specifier))) {
      specs.push(/** @type {any} */ (specifier).text);
    }
  });
  return specs;
}

/**
 * Resolves a relative ESM specifier against `fromFile`, honouring explicit
 * `.js` extensions. Returns `null` if no candidate file exists.
 * @param {string} fromFile
 * @param {string} spec
 * @returns {string | null}
 */
function resolveModule(fromFile, spec) {
  const direct = path.resolve(path.dirname(fromFile), spec);
  const candidates = [direct, `${direct}.js`, path.join(direct, "index.js")];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Walks the static import graph from `entry`, classifying every module
 * specifier reached.
 * @param {string} entry
 */
function collectGraph(entry) {
  /** @type {Set<string>} */
  const visited = new Set();
  const violations = { node: [], bare: [], unresolved: [] };
  /** @type {string[]} */
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    let specs;
    try {
      specs = extractModuleSpecifiers(file);
    } catch (_e) {
      continue;
    }
    for (const spec of specs) {
      if (spec.startsWith("node:")) {
        violations.node.push({ file, spec });
      } else if (
        spec.startsWith("./") ||
        spec.startsWith("../") ||
        spec.startsWith("/")
      ) {
        const next = resolveModule(file, spec);
        if (next) {
          queue.push(next);
        } else {
          violations.unresolved.push({ file, spec });
        }
      } else if (!spec.startsWith("http://") && !spec.startsWith("https://")) {
        if (!isAllowedBare(spec)) violations.bare.push({ file, spec });
      }
    }
  }
  return { visited, ...violations };
}

/**
 * Whether a bare specifier is the package itself or a subpath of one of the
 * allowed dependencies.
 * @param {string} spec
 * @returns {boolean}
 */
const isAllowedBare = (spec) =>
  [...ALLOWED_BARE].some(
    (allowed) => spec === allowed || spec.startsWith(`${allowed}/`),
  );

/** @param {{ file: string; spec: string }} v */
const fmt = (v) => `  ${path.relative(ROOT, v.file)} imports "${v.spec}"`;

test("src/index.js import graph has no Node.js dependencies", () => {
  const { visited, node, bare, unresolved } = collectGraph(ENTRY);

  assert.ok(
    visited.size > 1,
    `expected to traverse more than just index.js (got ${visited.size}); entry path wrong`,
  );

  assert.equal(
    node.length,
    0,
    `The browser import path must not import node: specifiers:\n${node.map(fmt).join("\n")}`,
  );
  assert.equal(
    bare.length,
    0,
    "The import path must stay limited to the sanctioned dependencies " +
      "(@reticulum/core, isomorphic-git, @digitaldefiance/bzip2-wasm):\n" +
      bare.map(fmt).join("\n"),
  );
  assert.equal(
    unresolved.length,
    0,
    `Could not resolve relative imports (graph walk incomplete):\n${unresolved.map(fmt).join("\n")}`,
  );
});
