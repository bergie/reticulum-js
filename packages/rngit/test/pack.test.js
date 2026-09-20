/**
 * Packfile tests: the minimal inflate decoder and thin-base resolution
 * ("fattening").
 *
 * Fixtures come from the system git: thin bundles are built with
 * `git bundle create` and the `have` exclusions exactly like an rngit node
 * answers `/git/fetch`, and the fattened packs are validated by canonical
 * `git index-pack` + `git fsck --strict`.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import zlib from "node:zlib";
import { emptyPack, parseBundle } from "../src/bundle.js";
import {
  applyDelta,
  buildPack,
  fattenPack,
  inflateWithBounds,
  parsePack,
  resolvePack,
} from "../src/pack.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** @param {string} dir @param {string[]} args */
function runGit(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { env: ENV })
    .toString()
    .trim();
}

describe("inflateWithBounds", () => {
  test("round trips zlib streams of many sizes and levels exactly", () => {
    for (const size of [0, 1, 10, 100, 1000, 8000, 65536, 200000]) {
      const raw = Buffer.alloc(size);
      for (let i = 0; i < size; i++) raw[i] = (i * 7 + 13) & 0xff;
      for (const level of [0, 1, 6, 9]) {
        const compressed = zlib.deflateSync(raw, { level });
        // Append trailing bytes to prove the decoder stops at the stream end.
        const padded = Buffer.concat([
          compressed,
          Buffer.from("trailing-data"),
        ]);
        const { bytes, consumed } = inflateWithBounds(padded);
        assert.ok(
          Buffer.compare(Buffer.from(bytes), raw) === 0,
          `size=${size} level=${level} content mismatch`,
        );
        assert.equal(
          consumed,
          compressed.length,
          `size=${size} level=${level} consumed mismatch`,
        );
      }
    }
  });

  test("rejects bad zlib headers", () => {
    assert.throws(() => inflateWithBounds(new Uint8Array([1, 2, 3, 4, 5, 6])));
  });
});

describe("pack parsing and fattening", () => {
  /**
   * Builds a fixture: work repo (two commits + a big file), a bare repo,
   * a client store cloned from the pre-state, and a thin bundle for an
   * incremental commit — mirroring the rngit fetch flow.
   *
   * @returns {{ dir: string, clientDir: string, bundle: Uint8Array, newMain: string }}
   */
  function makeThinFixture() {
    const dir = mkdtempSync(join(tmpdir(), "rngit-pack-"));
    const workDir = join(dir, "work");
    const bareDir = join(dir, "repo.git");
    runGit(dir, "init", "-q", "-b", "main", "work");
    fs.writeFileSync(join(workDir, "README.md"), "# pack\n");
    runGit(workDir, "add", ".");
    runGit(workDir, "commit", "-q", "-m", "one");
    fs.writeFileSync(join(workDir, "lib.js"), "export const two = 2;\n");
    runGit(workDir, "add", ".");
    runGit(workDir, "commit", "-q", "-m", "two");
    runGit(workDir, "tag", "v1.0");
    const big = Buffer.alloc(1024 * 1024 + 12345);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) & 0xff;
    fs.writeFileSync(join(workDir, "blob.bin"), big);
    runGit(workDir, "add", ".");
    runGit(workDir, "commit", "-q", "-m", "big file");
    runGit(dir, "init", "-q", "--bare", "-b", "main", "repo.git");
    runGit(workDir, "push", "-q", bareDir, "main", "refs/tags/v1.0");

    // Client store with the pre-state (canonical clone: a known-good store).
    runGit(dir, "clone", "-q", "--no-hardlinks", bareDir, "client");

    // Incremental commit on the server side, then a thin bundle excluding
    // the client's tips — exactly what an rngit node's fetch handler builds.
    fs.writeFileSync(join(workDir, "lib.js"), "export const three = 3;\n");
    runGit(workDir, "add", ".");
    runGit(workDir, "commit", "-q", "-m", "three");
    runGit(workDir, "push", "-q", bareDir, "main");

    const haveMain = runGit(join(dir, "client"), "rev-parse", "HEAD");
    const haveTag = runGit(join(dir, "client"), "rev-parse", "refs/tags/v1.0");
    const bundlePath = join(dir, "thin.bundle");
    execFileSync(
      "git",
      [
        "-C",
        bareDir,
        "bundle",
        "create",
        "-q",
        bundlePath,
        "refs/heads/main",
        "refs/tags/v1.0",
        `^${haveMain}`,
        `^${haveTag}`,
      ],
      { env: ENV },
    );
    return {
      dir,
      clientDir: join(dir, "client"),
      bundle: new Uint8Array(fs.readFileSync(bundlePath)),
      newMain: runGit(workDir, "rev-parse", "main"),
    };
  }

  test("resolves a thin bundle pack against the local store", async () => {
    const { dir, clientDir, bundle, newMain } = makeThinFixture();
    try {
      const parsed = parseBundle(bundle);
      assert.ok(parsed.prerequisites.length >= 1, "bundle is thin");
      const { objects, thin } = await resolvePack({
        pack: parsed.pack,
        fs,
        gitdir: join(clientDir, ".git"),
      });
      assert.equal(thin, true, "external base was used");
      assert.ok(objects.length >= 3);
      // The resolved objects match the server's history exactly.
      const oids = objects.map((o) => o.oid);
      assert.ok(oids.includes(newMain), "new main commit resolved");
      for (const object of objects) {
        assert.equal(
          runGit(
            join(dir, "work"),
            "cat-file",
            "-t",
            /** @type {string} */ (object.oid),
          ),
          object.type,
        );
        assert.equal(
          runGit(
            join(dir, "work"),
            "cat-file",
            "-s",
            /** @type {string} */ (object.oid),
          ),
          String(object.raw.length),
        );
      }
    } finally {
      removeTree(dir);
    }
  });

  test("fattened pack is accepted by canonical git (index-pack + fsck)", async () => {
    const { dir, clientDir, bundle, newMain } = makeThinFixture();
    try {
      const parsed = parseBundle(bundle);
      const fattened = await fattenPack({
        pack: parsed.pack,
        fs,
        gitdir: join(clientDir, ".git"),
      });

      // Store and index the fattened pack with canonical git.
      const packPath = join(
        clientDir,
        ".git",
        "objects",
        "pack",
        "fattened.pack",
      );
      fs.writeFileSync(packPath, fattened);
      execFileSync("git", ["-C", clientDir, "index-pack", packPath], {
        env: ENV,
      });
      runGit(clientDir, "update-ref", "refs/remotes/origin/main", newMain);
      runGit(clientDir, "fsck", "--strict");
      assert.equal(
        runGit(
          clientDir,
          "cat-file",
          "-p",
          "refs/remotes/origin/main:lib.js",
        ).trim(),
        "export const three = 3;",
      );
    } finally {
      removeTree(dir);
    }
  });

  test("self-contained packs pass through untouched", async () => {
    const { dir, clientDir, bundle } = makeThinFixture();
    try {
      // A bundle with NO have-exclusions is self-contained.
      const fullBundlePath = join(dir, "full.bundle");
      execFileSync(
        "git",
        [
          "-C",
          join(dir, "repo.git"),
          "bundle",
          "create",
          "-q",
          fullBundlePath,
          "--all",
        ],
        { env: ENV },
      );
      const full = new Uint8Array(fs.readFileSync(fullBundlePath));
      const parsed = parseBundle(full);
      const fattened = await fattenPack({
        pack: parsed.pack,
        fs,
        gitdir: join(clientDir, ".git"),
      });
      assert.equal(fattened, parsed.pack, "byte-identical passthrough");
    } finally {
      removeTree(dir);
    }
  });

  test("parsePack rejects malformed input", async () => {
    assert.throws(() => parsePack(new Uint8Array(20)));
    assert.throws(() =>
      parsePack(new TextEncoder().encode("PACKjunkjunkjunkjunkjunkjunk")),
    );
    const empty = await emptyPack();
    // Zero-object packs parse to zero entries.
    const { entries, count } = parsePack(empty);
    assert.equal(count, 0);
    assert.equal(entries.length, 0);
  });
});

describe("buildPack", () => {
  test("emits a pack canonical git indexes with correct oids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rngit-buildpack-"));
    try {
      const workDir = join(dir, "work");
      runGit(dir, "init", "-q", "-b", "main", "work");
      fs.writeFileSync(join(workDir, "a.txt"), "alpha\n");
      runGit(workDir, "add", ".");
      runGit(workDir, "commit", "-q", "-m", "one");
      const blobOid = runGit(workDir, "rev-parse", "HEAD:a.txt");
      const blob = new Uint8Array(
        execFileSync("git", ["-C", workDir, "cat-file", "blob", blobOid]),
      );

      const built = await buildPack([
        { type: "blob", raw: blob, oid: blobOid },
      ]);
      const repo2 = join(dir, "repo2");
      runGit(dir, "init", "-q", "-b", "main", "repo2");
      const packPath = join(repo2, ".git", "objects", "pack", "built.pack");
      fs.writeFileSync(packPath, built);
      execFileSync("git", ["-C", repo2, "index-pack", packPath], { env: ENV });
      assert.equal(
        runGit(repo2, "cat-file", "-p", blobOid).trim(),
        "alpha",
        "object readable with the original oid",
      );
    } finally {
      removeTree(dir);
    }
  });
});

describe("applyDelta", () => {
  test("applies copy and insert instructions", () => {
    const base = new TextEncoder().encode("hello world");
    // Delta: copy 5 from offset 0, insert "!", copy 5 from offset 6.
    // Copy opcode: 0x80 | offset-low-present (0x01) | size-low-present (0x10),
    // then the offset byte(s), then the size byte(s).
    const encoder = new TextEncoder();
    const literal = encoder.encode("!");
    const delta = new Uint8Array([
      11, // base size
      11, // target size
      0x80 | 0x01 | 0x10,
      0,
      5, // copy 5 from offset 0
      literal.length,
      ...literal, // insert "!"
      0x80 | 0x01 | 0x10,
      6,
      5, // copy 5 from offset 6
    ]);
    const target = applyDelta(base, delta);
    assert.equal(new TextDecoder().decode(target), "hello!world");
  });

  test("rejects size mismatches", () => {
    const base = new Uint8Array([1, 2, 3]);
    // Delta declares base size 4.
    assert.throws(
      () => applyDelta(base, new Uint8Array([4, 3, 1, 0x61])),
      /base size mismatch/,
    );
  });
});

/** Best-effort recursive removal — cleanup races must not fail a test. */
function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* transient */
  }
}
