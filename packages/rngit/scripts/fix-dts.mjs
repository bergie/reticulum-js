#!/usr/bin/env node
/**
 * Post-generation fixer for .d.ts files.
 *
 * tsc (as of 6.x) has two issues that hurt the JSR documentation score:
 *
 * 1. Module-level `@module` JSDoc is not always preserved in .d.ts output
 *    (it is dropped when imports appear between the JSDoc and the first
 *    declaration).  We copy the `@module` block from the source `.js` file
 *    to the top of the generated `.d.ts` file.
 *
 * 2. `@enum` consts are split into `export type X = …` + `export namespace X { … }`.
 *    The JSDoc is attached to the `type` declaration but never copied to the
 *    `namespace`, so deno_doc reports the namespace as undocumented.  We copy
 *    the JSDoc from the `type` to the `namespace`.
 *
 * Run automatically after `tsc` via the `types` npm script.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const typesDir = join(pkgRoot, "types", "src");
const srcDir = join(pkgRoot, "src");

/**
 * Extract the leading `@module` JSDoc block from a .js source file.
 * Returns the full `/** … *\/` comment string, or null if not found.
 */
function extractModuleDoc(jsSource) {
  // Match the first JSDoc block that contains @module
  const match = jsSource.match(/^\s*(\/\*\*[\s\S]*?@module[\s\S]*?\*\/)/);
  return match ? match[1].trim() : null;
}

/**
 * Extract all `@namespace` JSDoc blocks from a .js source file.
 * Returns a Map of namespace name → JSDoc comment string.
 */
function extractNamespaceDocs(jsSource) {
  const docs = new Map();
  // Match each complete JSDoc block, then check if it contains @namespace.
  const re = /\/\*\*[\s\S]*?\*\//g;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(jsSource)) !== null) {
    const block = m[0];
    const nsMatch = block.match(/@namespace\s+(\w+)/);
    if (nsMatch) {
      docs.set(nsMatch[1], block.trim());
    }
  }
  return docs;
}

/**
 * Copy JSDoc from `export type X` declarations to the following
 * `export namespace X` declarations in a .d.ts file.
 *
 * tsc emits:
 *   /** doc *\/
 *   export type Foo = number;
 *   export namespace Foo { … }
 *
 * We transform it to:
 *   /** doc *\/
 *   export type Foo = number;
 *   /** doc *\/
 *   export namespace Foo { … }
 */
function addNamespaceDocs(dtsContent, namespaceDocs = new Map()) {
  const lines = dtsContent.split("\n");
  const result = [];
  let pendingJsDoc = null; // JSDoc lines collected for the next type decl
  let pendingTypeName = null;
  let prevLineWasTypeDecl = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Collect JSDoc blocks (/** … */)
    if (line.trim().startsWith("/**")) {
      const jsDocLines = [line];
      // Multi-line JSDoc
      if (!line.includes("*/")) {
        for (let j = i + 1; j < lines.length; j++) {
          jsDocLines.push(lines[j]);
          if (lines[j].includes("*/")) {
            i = j;
            break;
          }
        }
      }
      pendingJsDoc = jsDocLines;
      // A new JSDoc block after a type declaration means it's not the
      // type's doc anymore — clear the association so we don't duplicate.
      pendingTypeName = null;
      result.push(...jsDocLines);
      continue;
    }

    // Detect `export type X = …;`
    const typeMatch = line.match(/^export\s+type\s+(\w+)\s*=/);
    if (typeMatch) {
      pendingTypeName = typeMatch[1];
      prevLineWasTypeDecl = true;
      result.push(line);
      continue;
    }

    // Detect `export namespace X {`
    const nsMatch = line.match(/^export\s+namespace\s+(\w+)\s*\{/);
    if (nsMatch) {
      const nsName = nsMatch[1];
      // Case 1: JSDoc from a matching `export type X` (enum split)
      if (pendingJsDoc && pendingTypeName === nsName) {
        result.push(...pendingJsDoc);
        result.push(line);
        pendingJsDoc = null;
        pendingTypeName = null;
        prevLineWasTypeDecl = false;
        continue;
      }
      // Case 2: standalone namespace (from @namespace tag) — tsc strips
      // the JSDoc entirely, so inject it from the source .js file.
      const srcDoc = namespaceDocs.get(nsName);
      if (srcDoc && !prevLineWasTypeDecl) {
        result.push(srcDoc);
        result.push(line);
        pendingJsDoc = null;
        pendingTypeName = null;
        prevLineWasTypeDecl = false;
        continue;
      }
    }

    // Non-type, non-namespace line: clear pending JSDoc
    if (line.trim() !== "" && !line.trim().startsWith("*")) {
      pendingJsDoc = null;
      pendingTypeName = null;
      prevLineWasTypeDecl = false;
    }
    result.push(line);
  }

  return result.join("\n");
}

/**
 * Recursively collect all .d.ts files under a directory.
 */
async function collectDtsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDtsFiles(fullPath)));
    } else if (entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  let dtsFiles;
  try {
    dtsFiles = await collectDtsFiles(typesDir);
  } catch {
    console.error("No types/ directory found. Run tsc first.");
    process.exit(1);
  }

  let fixedCount = 0;

  for (const dtsFile of dtsFiles) {
    const dtsContent = await readFile(dtsFile, "utf-8");
    let modified = dtsContent;

    // 1. Add @module JSDoc from the corresponding .js file
    const relPath = relative(typesDir, dtsFile);
    // .d.ts → .js
    const jsRelPath = relPath.replace(/\.d\.ts$/, ".js");
    const jsFile = join(srcDir, jsRelPath);

    let jsExists = false;
    try {
      await stat(jsFile);
      jsExists = true;
    } catch {
      // No corresponding .js file (e.g. a .d.ts-only module)
    }

    if (jsExists) {
      const jsSource = await readFile(jsFile, "utf-8");
      const moduleDoc = extractModuleDoc(jsSource);
      if (moduleDoc && !modified.includes("@module")) {
        modified = `${moduleDoc}\n${modified}`;
        fixedCount++;
      }
      const namespaceDocs = extractNamespaceDocs(jsSource);
      // 2. Copy JSDoc from type declarations to namespace declarations,
      //    and inject JSDoc for standalone @namespace declarations.
      modified = addNamespaceDocs(modified, namespaceDocs);
    } else {
      // 2. Still process type→namespace copying even without a .js source.
      modified = addNamespaceDocs(modified);
    }

    if (modified !== dtsContent) {
      await writeFile(dtsFile, modified, "utf-8");
    }
  }

  console.log(
    `Fixed ${fixedCount} .d.ts files with @module docs, processed ${dtsFiles.length} total.`,
  );
}

// Only run main() when executed directly via `node scripts/fix-dts.mjs`,
// not when imported for testing (see test/scripts/fix-dts.test.js).
const isMainModule = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    // Deno or other runtime — assume not main.
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for testing (see test/scripts/fix-dts.test.js).
export {
  addNamespaceDocs,
  collectDtsFiles,
  extractModuleDoc,
  extractNamespaceDocs,
};
