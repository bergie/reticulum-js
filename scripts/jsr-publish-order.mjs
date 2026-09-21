#!/usr/bin/env node
/**
 * @file jsr-publish-order.mjs
 * @description Compute the JSR publish order for the monorepo's packages.
 *
 * `deno publish` resolves a package's `jsr:` dependencies against the JSR
 * registry at *publish* time (unlike npm, where a version range resolves at
 * install time). A workspace dependency that has not been published yet is
 * an unresolvable reference and fails the publish — e.g. publishing
 * `@reticulum/node` before `@reticulum/rfed` fails with:
 *
 *     unresolvable 'jsr:' dependency: '@reticulum/rfed@^0.9.0',
 *     no published version matches the constraint
 *
 * So packages must publish dependencies-first. This script computes that
 * order from the actual dependency graph (`package.json` `dependencies`,
 * scoped to `@reticulum/*` packages that carry a `jsr.json`), keeping
 * alphabetical order among otherwise-ready packages so the sequence is
 * deterministic. Used by the JSR publish loop in `.github/workflows/
 * publish.yml`.
 *
 * Usage: node scripts/jsr-publish-order.mjs [<repo root>]
 *   Prints one `packages/<dir>` line per JSR package, dependencies first.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Computes the JSR-publishable packages in dependency-first order.
 *
 * @param {string} rootDir Repository root (containing `packages/`).
 * @returns {string[]} Package directory names (e.g. `["core", "lxmf", …]`),
 *   every package listed after all of its `@reticulum/*` dependencies.
 * @throws {Error} when the `@reticulum` dependency graph has a cycle.
 */
export function computePublishOrder(rootDir) {
  const packagesDir = join(rootDir, "packages");
  /**
   * jsr package name → directory + its intra-repo dependency names.
   * @type {Map<string, { dir: string, deps: Set<string> }>}
   */
  const byName = new Map();
  for (const dir of readdirSync(packagesDir)) {
    const jsrPath = join(packagesDir, dir, "jsr.json");
    const pkgPath = join(packagesDir, dir, "package.json");
    if (!existsSync(jsrPath) || !existsSync(pkgPath)) continue;
    const jsr = JSON.parse(readFileSync(jsrPath, "utf8"));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = new Set(
      Object.keys(pkg.dependencies ?? {}).filter((d) =>
        d.startsWith("@reticulum/"),
      ),
    );
    byName.set(jsr.name, { dir, deps });
  }

  const published = new Set();
  /** @type {string[]} */
  const order = [];
  while (order.length < byName.size) {
    // Ready = unpublished, with every intra-repo dependency already emitted
    // (dependencies outside this repo's JSR set are ignored — they resolve
    // against published versions). Alphabetical among ready peers.
    const ready = [...byName.entries()]
      .filter(
        ([name, { deps }]) =>
          !published.has(name) &&
          [...deps].every((d) => !byName.has(d) || published.has(d)),
      )
      .sort((a, b) => a[1].dir.localeCompare(b[1].dir));
    if (ready.length === 0) {
      throw new Error(
        "Cyclic @reticulum dependency between packages with a jsr.json",
      );
    }
    for (const [name, { dir }] of ready) {
      published.add(name);
      order.push(dir);
    }
  }
  return order;
}

// CLI: print `packages/<dir>` lines when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] ?? process.cwd();
  for (const dir of computePublishOrder(rootDir)) {
    console.log(`packages/${dir}`);
  }
}
