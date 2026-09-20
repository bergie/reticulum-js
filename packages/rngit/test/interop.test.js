/**
 * Live interop tests against a real rngit node (the Python reference
 * server).
 *
 * Gated behind `RNGIT_INTEROP=1` because they need the `rngit` CLI (from the
 * reference implementation), the system `git`, and a reachable rnsd shared
 * instance. When enabled, the test:
 *
 *   1. builds a fixture bare repository and an rngit node configuration,
 *   2. starts a real `rngit node` (the reference server),
 *   3. clones the repository through the @reticulum/rngit transport over
 *      the shared rnsd instance,
 *   4. verifies the clone against the system git (rev-parse, fsck, log),
 *   5. pushes a new commit into the bare repository and re-fetches,
 *      verifying incremental (have-list) transfer.
 *
 * The rngit node announces its destination on the mesh the rnsd is
 * connected to — run this only on networks where a test announce is
 * acceptable.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const ENABLED = process.env.RNGIT_INTEROP === "1";

/** @param {string} dir @param {string[]} args */
function runGit(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
    .toString()
    .trim();
}

describe("rngit live interop (reference rngit node)", () => {
  /**
   * Builds the fixture: work repo with commits, a bare repo, rngit config.
   *
   * @returns {{ base: string, bigFileBytes: Buffer }} the rngit config dir
   *   and the big fixture blob for clone verification.
   */
  function makeFixture() {
    const base = mkdtempSync(join(tmpdir(), "rngit-interop-"));
    const workDir = join(base, "work");
    const bareDir = join(base, "repos", "interop-repo.git");
    runGit(base, "init", "-q", "-b", "main", "work");
    runGit(workDir, "config", "user.name", "Test");
    runGit(workDir, "config", "user.email", "test@example.com");
    fs.writeFileSync(join(workDir, "README.md"), "# interop\n");
    runGit(workDir, "add", ".");
    runGit(workDir, "commit", "-q", "-m", "one");
    fs.writeFileSync(join(workDir, "lib.js"), "export const two = 2;\n");
    runGit(workDir, "add", ".");
    runGit(workDir, "commit", "-q", "-m", "two");
    runGit(workDir, "tag", "v1.0");
    // A ~1.5 MiB incompressible file pushes the clone bundle over the
    // reference implementation's segment split boundary (1 MiB - 1), so the
    // live clone exercises multi-segment transfer against the real node.
    const bigFileBytes = randomBytes(1.5 * 1024 * 1024);
    fs.writeFileSync(join(workDir, "blob.bin"), bigFileBytes);
    runGit(workDir, "add", ".");
    runGit(workDir, "commit", "-q", "-m", "big file");
    runGit(
      base,
      "init",
      "-q",
      "--bare",
      "-b",
      "main",
      "repos/interop-repo.git",
    );
    runGit(workDir, "push", "-q", bareDir, "main", "refs/tags/v1.0");

    fs.writeFileSync(
      join(base, "config"),
      `[rngit]
node_name = RNGit JS Interop Test
announce_interval = 1

[repositories]
interop = ${join(base, "repos")}

[access]
interop = rw:all

[logging]
loglevel = 4
`,
    );
    return { base, bigFileBytes };
  }

  test("clone and incremental fetch from a real rngit node", {
    skip:
      !ENABLED && "set RNGIT_INTEROP=1 and ensure rnsd + rngit are available",
  }, async () => {
    const { RngitClient, clone, fetch } = await import("../src/index.js");
    const { MemoryStorageAdapter, Reticulum } = await import("@reticulum/core");
    const { LocalClientInterface } = await import("@reticulum/node");

    const { base, bigFileBytes } = makeFixture();
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-interop-clone-"));
    /** @type {import("node:child_process").ChildProcess|null} */
    let server = null;
    /** @type {import("@reticulum/core").Reticulum|null} */
    let rns = null;
    try {
      // Destination hash is deterministic for the persisted node identity.
      const identityOut = execFileSync(
        "rngit",
        ["node", "-p", "--config", base],
        { encoding: "utf8" },
      );
      const match = identityOut.match(
        /Repositories Destination\s*:\s*<?([0-9a-f]+)>?/i,
      );
      assert.ok(match, `could not parse destination from:\n${identityOut}`);
      const destinationHash = match[1];
      const url = `rns://${destinationHash}/interop/interop-repo.git`;

      server = spawn("rngit", ["node", "--config", base], {
        stdio: "ignore",
      });
      // Give the node a moment to start up and announce.
      await new Promise((r) => setTimeout(r, 2000));

      rns = new Reticulum({ storageAdapter: new MemoryStorageAdapter() });
      const shared = await LocalClientInterface.connectToSharedInstance();
      if (!shared) {
        throw new Error(
          "No rnsd shared instance reachable; interop test requires one",
        );
      }
      rns.addInterface(shared, true);

      const client = new RngitClient({
        url,
        reticulum: rns,
        pathTimeoutMs: 60000,
      });

      // --- listing matches git ls-remote ------------------------------
      const bareRefs = new Map();
      const lsRemote = execFileSync("git", [
        "ls-remote",
        join(base, "repos", "interop-repo.git"),
      ])
        .toString()
        .trim();
      for (const line of lsRemote.split("\n")) {
        const [sha, ref] = line.split(/\s+/);
        if (sha && ref)
          bareRefs.set(ref.replace(/^refs\/heads\//, "refs/heads/"), sha);
      }
      const listing = await client.list();
      assert.equal(listing.head, "refs/heads/main");
      assert.equal(
        listing.refs.get("refs/heads/main"),
        bareRefs.get("refs/heads/main"),
      );
      assert.equal(
        listing.refs.get("refs/tags/v1.0"),
        bareRefs.get("refs/tags/v1.0"),
      );

      // --- clone ------------------------------------------------------
      const result = await clone({ fs, dir: cloneDir, url, client });
      assert.equal(result.fetchHead, bareRefs.get("refs/heads/main"));
      assert.equal(runGit(cloneDir, "rev-parse", "HEAD"), result.fetchHead);
      assert.equal(
        runGit(cloneDir, "rev-parse", "HEAD~1"),
        runGit(join(base, "work"), "rev-parse", "main~1"),
      );
      runGit(cloneDir, "fsck", "--strict");
      assert.equal(
        fs.readFileSync(join(cloneDir, "lib.js"), "utf8"),
        "export const two = 2;\n",
      );
      // The ~1.5 MiB blob arrived via a multi-segment resource transfer.
      const blob = fs.readFileSync(join(cloneDir, "blob.bin"));
      assert.equal(blob.length, bigFileBytes.length);
      assert.ok(
        Buffer.compare(blob, bigFileBytes) === 0,
        "multi-segment big file intact",
      );
      const remoteUrl = runGit(cloneDir, "remote", "get-url", "origin");
      assert.equal(remoteUrl, url);

      // --- incremental fetch ------------------------------------------
      fs.writeFileSync(
        join(base, "work", "lib.js"),
        "export const three = 3;\n",
      );
      const workDir2 = join(base, "work");
      runGit(workDir2, "add", ".");
      runGit(workDir2, "commit", "-q", "-m", "three");
      runGit(
        workDir2,
        "push",
        "-q",
        join(base, "repos", "interop-repo.git"),
        "main",
      );
      const newHead = runGit(
        join(base, "repos", "interop-repo.git"),
        "rev-parse",
        "main",
      );

      await fetch({ fs, dir: cloneDir, url, client });
      assert.equal(
        runGit(cloneDir, "rev-parse", "refs/remotes/origin/main"),
        newHead,
      );
      runGit(cloneDir, "merge", "--ff-only", "origin/main");
      assert.equal(
        fs.readFileSync(join(cloneDir, "lib.js"), "utf8"),
        "export const three = 3;\n",
      );
      runGit(cloneDir, "fsck", "--strict");
    } finally {
      if (server) server.kill("SIGTERM");
      if (rns) await rns.stop();
      removeTree(base);
      removeTree(cloneDir);
    }
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
