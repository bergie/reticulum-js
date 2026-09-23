/**
 * Spec test-vector loader (work doc #38).
 *
 * Reads the known-good byte vectors from the sibling
 * `reticulum-specifications` repo
 * (`test-vectors/{identities,announces,links,lxmf}.json`), intended as a
 * cross-implementation compliance suite (SPEC.md README: "grow into a
 * compliance suite"). When the directory is absent, the whole suite skips
 * cleanly — no submodule dependency, CI stays green without the spec
 * repo checked out.
 *
 * Resolve the base path via `RETICULUM_SPEC_VECTORS` (point at the
 * `test-vectors` dir directly), with a fallback to the sibling checkout
 * at `../reticulum-specifications/test-vectors`.
 *
 * @module test/spec-vectors/_loader
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the test-vectors directory, or `null` when absent (or unreadable
 * under a restrictive permission scope — e.g. Deno's narrow `--allow-read`,
 * which throws `NotCapable` from `existsSync` on a denied path). The suite
 * skips cleanly in that case rather than crashing the module.
 *
 * @returns {string|null}
 */
function resolveVectorsDir() {
  const env = process.env.RETICULUM_SPEC_VECTORS;
  const candidates = [
    env,
    // From `packages/<pkg>/test/spec-vectors/`, the sibling spec repo at
    // `<projects>/reticulum-specifications/test-vectors` is five levels up
    // (…/spec-vectors → test → <pkg> → packages → <repo-root> → <projects>).
    join(
      HERE,
      "..",
      "..",
      "..",
      "..",
      "..",
      "reticulum-specifications",
      "test-vectors",
    ),
  ].filter(Boolean);
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (existsSync(c)) return c;
    } catch {
      /* permission denied (e.g. Deno narrow --allow-read) — treat as absent */
    }
  }
  return null;
}

const VECTORS_DIR = resolveVectorsDir();

/**
 * Returns `true` when the spec test-vectors are available on this host.
 * Call this at the top of each `test(...)` body and `return` early when false
 * so the whole suite no-ops cleanly on hosts without the spec repo checked
 * out (Node's `t.skip()` marks skipped but does not abort the test body).
 *
 * @returns {boolean}
 */
export function vectorsAvailable() {
  return VECTORS_DIR !== null;
}

/**
 * @deprecated Use {@link vectorsAvailable} + an early `return` instead;
 * `t.skip()` marks the test skipped but does not stop the test body.
 *
 * @param {import("node:test").TestContext} _t
 */
export function assertVectorsAvailable(_t) {
  if (!VECTORS_DIR) {
    throw new Error(
      "spec vectors not available — guard with vectorsAvailable() and return early",
    );
  }
}

/**
 * Loads a named vector file.
 *
 * @param {string} name - One of `identities`, `announces`, `links`, `lxmf`.
 * @returns {{_about: string, vectors: any[]}}
 */
export function loadVectors(name) {
  if (!VECTORS_DIR) throw new Error("spec vectors not available");
  const path = join(VECTORS_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Builds a label→Identity map from the identities vectors, loading each
 * via `Identity.fromBytes(private_key_hex)` (the spec's documented
 * load recipe). Announce/link/lxmf vectors reference identities by
 * `*_identity_label`, so the suite resolves labels through this map.
 *
 * @returns {Promise<Map<string, import("../../src/core/identity.js").Identity>>}
 */
export async function loadIdentityMap() {
  const { Identity } = await import("../../src/core/identity.js");
  const { vectors } = loadVectors("identities");
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const v of vectors) {
    const priv = hexToBytes(v.inputs.private_key_hex);
    const id = await Identity.fromPrivateKey(priv);
    if (!id) throw new Error(`failed to load identity ${v.label}`);
    map.set(v.label, id);
  }
  return map;
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
  const clean = hex.toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
