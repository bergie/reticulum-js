import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * @file import-boundary.js
 * @description Enforces SPEC.md §1.1: the browser import path (`src/index.js`
 *   and its static import graph) must be free of Node.js dependencies — both
 *   `node:` core libraries and any third-party (bare) runtime specifiers — so
 *   a browser bundler (webpack, tsdown/rolldown, vite, esbuild, rollup) can
 *   never pull Node-only code into a browser build, with zero per-tool config.
 *
 * Statically walks every module reachable from `src/index.js` via ESM
 * `import`/`export … from` (parsed with the TypeScript compiler — already a
 * devDependency — so comments and string literals don't cause false positives)
 * and asserts none import a `node:` or bare specifier.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "index.js");

/**
 * Bare specifiers allowed in the browser graph despite not being relative.
 * Intentionally empty: the core must stay WinterTC-pure. Add an entry here
 * only after a deliberate SPEC.md §1.1 review — and prefer dependency
 * injection (like `compressionProvider`) over importing the dependency.
 * @type {Set<string>}
 */
const ALLOWED_BARE = new Set([]);

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
    if (specifier && ts.isStringLiteral(/** @type {ts.Node} */ (specifier))) {
      specs.push(/** @type {any} */ (specifier).text);
    }
  });
  return specs;
}

/**
 * Resolves a relative ESM specifier against `fromFile`, honouring explicit
 * `.js` extensions and falling back to `.js` / `index.js` for safety. Returns
 * `null` if no candidate file exists (surfaced as an "unresolved" violation).
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
 * @returns {{
 *   visited: Set<string>,
 *   node: { file: string; spec: string }[],
 *   bare: { file: string; spec: string }[],
 *   unresolved: { file: string; spec: string }[],
 * }}
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
      continue; // unreadable source — nothing to analyse here
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
        // Bare specifier (a third-party package).
        if (!ALLOWED_BARE.has(spec)) violations.bare.push({ file, spec });
      }
    }
  }
  return { visited, ...violations };
}

/** @param {{ file: string; spec: string }} v */
const fmt = (v) => `  ${path.relative(ROOT, v.file)} imports "${v.spec}"`;

test("src/index.js import graph has no Node.js dependencies (SPEC.md §1.1)", () => {
  const { visited, node, bare, unresolved } = collectGraph(ENTRY);

  // Sanity: the entry must actually resolve and reach other modules, otherwise
  // the assertions below would pass vacuously.
  assert.ok(
    visited.size > 1,
    `expected to traverse more than just index.js (got ${visited.size}); entry path wrong?`,
  );

  assert.equal(
    node.length,
    0,
    `The browser import path must not import node: specifiers:\n${node.map(fmt).join("\n")}`,
  );
  assert.equal(
    bare.length,
    0,
    "The browser import path must not import third-party (bare) specifiers — " +
      "use dependency injection or a separate package (SPEC.md §1.1):\n" +
      bare.map(fmt).join("\n"),
  );
  assert.equal(
    unresolved.length,
    0,
    `Could not resolve relative imports (graph walk incomplete):\n${unresolved.map(fmt).join("\n")}`,
  );
});

test("a known node: importer (an interface) is not reachable from src/index.js", () => {
  // Regression guard: if an interface module (which legitimately uses node:
  // libs) were ever imported by core, the §1.1 boundary would silently break.
  const { visited } = collectGraph(ENTRY);
  const normalized = new Set([...visited].map((f) => path.resolve(f)));
  for (const iface of ["tcp.js", "local_client.js", "auto.js"]) {
    const p = path.resolve(ROOT, "src", "interfaces", iface);
    assert.ok(
      !normalized.has(p),
      `src/interfaces/${iface} must not be reachable from src/index.js`,
    );
  }
});
