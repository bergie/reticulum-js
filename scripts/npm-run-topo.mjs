#!/usr/bin/env node
/**
 * @file npm-run-topo.mjs
 * @description Run an npm script across the monorepo's workspaces in
 *   dependency order.
 *
 * `npm run <script> --workspaces` runs the workspaces in *alphabetical*
 * directory order, not topological order. That is wrong for scripts whose
 * outputs other packages consume: e.g. `@reticulum/node`'s `types` script
 * type-checks against the *generated* (git-ignored) declarations of
 * `@reticulum/rfed`, so `node` must not run before `rfed` has regenerated
 * them. With alphabetical ordering this only passes when a leftover
 * `packages/rfed/types/` from an earlier build happens to be fresh — which
 * broke the docs/site build twice.
 *
 * This script computes the dependency-first order from the packages'
 * `package.json` `dependencies` (`@reticulum/*` packages only; external
 * dependencies resolve from the registry and impose no ordering), then runs
 * `npm run <script> --if-present` in each package directory sequentially,
 * failing fast on the first non-zero exit.
 *
 * Usage: node scripts/npm-run-topo.mjs <script> [<repo root>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Computes the workspace packages in dependency-first order.
 *
 * @param {string} rootDir Repository root (containing `packages/`).
 * @returns {string[]} Package directory names (e.g. `["core", "lxmf", …]`),
 *   every package listed after all of its `@reticulum/*` dependencies.
 * @throws {Error} when the `@reticulum` dependency graph has a cycle.
 */
export function computeWorkspaceOrder(rootDir) {
  const packagesDir = join(rootDir, "packages");
  /**
   * package name → directory + its intra-repo dependency names.
   * @type {Map<string, { dir: string, deps: Set<string> }>}
   */
  const byName = new Map();
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgPath = join(packagesDir, dir.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = new Set(
      Object.keys(pkg.dependencies ?? {}).filter((d) =>
        d.startsWith("@reticulum/"),
      ),
    );
    byName.set(pkg.name, { dir: dir.name, deps });
  }

  const done = new Set();
  /** @type {string[]} */
  const order = [];
  while (order.length < byName.size) {
    // Ready = not yet emitted, with every intra-repo dependency already
    // emitted. Alphabetical among ready peers, so the sequence is
    // deterministic.
    const ready = [...byName.entries()]
      .filter(
        ([name, { deps }]) =>
          !done.has(name) &&
          [...deps].every((d) => !byName.has(d) || done.has(d)),
      )
      .sort((a, b) => a[1].dir.localeCompare(b[1].dir));
    if (ready.length === 0) {
      throw new Error("Cyclic @reticulum dependency between packages");
    }
    for (const [name, { dir }] of ready) {
      done.add(name);
      order.push(dir);
    }
  }
  return order;
}

// CLI: run `<script>` in each package, dependencies first.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [script, rootDir = process.cwd()] = process.argv.slice(2);
  if (!script) {
    console.error("Usage: node scripts/npm-run-topo.mjs <script> [<root>]");
    process.exit(1);
  }
  for (const dir of computeWorkspaceOrder(rootDir)) {
    console.log(`> ${dir}: npm run ${script}`);
    const result = spawnSync("npm", ["run", script, "--if-present"], {
      cwd: join(rootDir, "packages", dir),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      console.error(`npm run ${script} failed in packages/${dir}`);
      process.exit(result.status ?? 1);
    }
  }
}
