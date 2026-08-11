import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addNamespaceDocs,
  extractModuleDoc,
  extractNamespaceDocs,
} from "../../scripts/fix-dts.mjs";

describe("extractModuleDoc", () => {
  it("extracts a @module JSDoc block from a .js source", () => {
    const src = `/**
 * @module @reticulum/core/src/foo.js
 * @description Foo module
 */

export function bar() {}
`;
    const doc = extractModuleDoc(src);
    assert.ok(doc);
    assert.ok(doc.includes("@module @reticulum/core/src/foo.js"));
    assert.ok(doc.includes("Foo module"));
  });

  it("returns null when no @module tag is present", () => {
    const src = `/** Just a regular JSDoc. */
export function bar() {}
`;
    assert.equal(extractModuleDoc(src), null);
  });
});

describe("extractNamespaceDocs", () => {
  it("extracts @namespace JSDoc blocks keyed by name", () => {
    const src = `/**
 * @module foo
 */

/** Helper utilities.
 * @namespace utils
 */
export const utils = {};
`;
    const docs = extractNamespaceDocs(src);
    assert.equal(docs.size, 1);
    assert.ok(docs.has("utils"));
    assert.ok(docs.get("utils").includes("Helper utilities."));
  });

  it("does not cross JSDoc block boundaries", () => {
    // The @module block must not be captured as part of the @namespace block.
    const src = `/**
 * @module foo
 * @description Top-level module
 */

/** Helper utilities.
 * @namespace utils
 */
export const utils = {};
`;
    const docs = extractNamespaceDocs(src);
    assert.equal(docs.size, 1);
    const doc = docs.get("utils");
    assert.ok(doc.includes("Helper utilities."));
    assert.ok(!doc.includes("@module"));
  });

  it("returns an empty map when no @namespace tags exist", () => {
    const src = `/** Just a regular JSDoc. */
export function bar() {}
`;
    assert.equal(extractNamespaceDocs(src).size, 0);
  });
});

describe("addNamespaceDocs", () => {
  it("copies JSDoc from type to namespace for @enum splits", () => {
    const dts = `/** Color values. */
export type Color = number;
export namespace Color {
    let RED: number;
    let GREEN: number;
}
`;
    const result = addNamespaceDocs(dts);
    const nsIdx = result.indexOf("export namespace Color");
    const beforeNs = result.substring(0, nsIdx);
    assert.ok(
      beforeNs.includes("Color values."),
      "namespace should be preceded by JSDoc with description",
    );
  });

  it("injects JSDoc for standalone @namespace declarations", () => {
    const dts = `export namespace utils {
    function foo(): void;
}
`;
    const namespaceDocs = new Map([
      ["utils", "/**\n * Utility helpers.\n * @namespace utils\n */"],
    ]);
    const result = addNamespaceDocs(dts, namespaceDocs);
    const nsIdx = result.indexOf("export namespace utils");
    const beforeNs = result.substring(0, nsIdx);
    assert.ok(
      beforeNs.includes("Utility helpers."),
      "standalone namespace should be preceded by its JSDoc",
    );
  });

  it("preserves all existing JSDoc blocks", () => {
    const dts = `/** Module doc. */

/** Function doc. */
export declare function bar(): void;

/** Type doc. */
export type Color = number;
export namespace Color {
    let RED: number;
}
`;
    const result = addNamespaceDocs(dts);
    // Module doc preserved
    assert.ok(result.includes("Module doc."));
    // Function doc preserved
    assert.ok(result.includes("Function doc."));
    // Type doc preserved
    assert.ok(result.includes("Type doc."));
    // Namespace now has doc
    const nsIdx = result.indexOf("export namespace Color");
    assert.ok(
      result.substring(0, nsIdx).includes("Type doc."),
      "namespace should have the type's JSDoc copied",
    );
  });

  it("is idempotent — does not duplicate docs on re-run", () => {
    const dts = `/** Test enum. */
export type TestEnum = number;
export namespace TestEnum {
    let A: number;
    let B: number;
}
`;
    const result1 = addNamespaceDocs(dts);
    const result2 = addNamespaceDocs(result1);
    assert.equal(
      result1,
      result2,
      "second run should produce identical output",
    );
  });
});
