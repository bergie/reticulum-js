/**
 * Transport tests for the isomorphic-git ↔ rngit bridge.
 *
 * The unit-level tests verify the synthesized smart-HTTP responses against
 * the git protocol rules isomorphic-git enforces. The end-to-end tests run
 * a scripted rngit node (the `/git/list` + `/git/fetch` handlers, bundle
 * replies as file-with-metadata Resources) over an in-process loopback Link
 * and drive a real isomorphic-git clone/fetch through the transport,
 * comparing the result against the fixture repository created with the
 * system git.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  Allow,
  Destination,
  DestType,
  Direction,
  Identity,
  Link,
  LinkStatus,
  PacketType,
  ResourceResponse,
  toHex,
} from "@reticulum/core";
import { buildBundle, emptyPack, parseBundle } from "../src/bundle.js";
import { RngitClient } from "../src/client.js";
import { clone, fetch, push } from "../src/commands.js";
import { decodePktLines, encodePktLine, FLUSH } from "../src/pktline.js";
import { IDX_REPOSITORY } from "../src/protocol.js";
import {
  buildInfoRefsResponse,
  buildReportStatusResponse,
  buildUploadPackResponse,
  parseReceivePackRequest,
  parseUploadPackRequest,
  UnsupportedFeatureError,
} from "../src/transport.js";

// ---------------------------------------------------------------------------
// Fixture repository
// ---------------------------------------------------------------------------

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/**
 * Creates a git repo with two commits (a real file in each) plus a tag.
 *
 * @returns {{ dir: string, head: () => string, refs: () => Map<string,string> }}
 */
function makeSourceRepo() {
  const dir = mkdtempSync(join(tmpdir(), "rngit-src-"));
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", ["-C", dir, ...args], { env: ENV })
      .toString()
      .trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  fs.writeFileSync(join(dir, "README.md"), "# rngit test\nfirst\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  fs.writeFileSync(join(dir, "lib.js"), "export const answer = 42;\n");
  git("add", ".");
  git("commit", "-q", "-m", "two");
  git("tag", "v1.0");
  return {
    dir,
    head: () => git("rev-parse", "HEAD"),
    refs: () => {
      /** @type {Map<string,string>} */
      const refs = new Map();
      for (const line of git(
        "for-each-ref",
        "--format",
        "%(objectname) %(refname)",
      ).split("\n")) {
        const sep = line.indexOf(" ");
        refs.set(line.slice(sep + 1), line.slice(0, sep));
      }
      return refs;
    },
  };
}

/** @param {string} dir @param {string[]} args */
function runGit(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    env: ENV,
  })
    .toString()
    .trim();
}

// ---------------------------------------------------------------------------
// Loopback Link pair (pattern from @reticulum/core transport tests)
// ---------------------------------------------------------------------------

class LoopbackTransport {
  constructor() {
    /** @type {Map<string, Link>} */
    this.links = new Map();
    /** @type {Map<string, Destination>} */
    this.destinations = new Map();
    this.sent = [];
    this.peer = null;
  }
  /** @param {Uint8Array} hash @param {Link} link */
  addLink(hash, link) {
    this.links.set(toHex(hash), link);
  }
  removeLink(hash) {
    this.links.delete(toHex(hash));
  }
  /** @param {Uint8Array} hash @param {Destination} dest */
  addDestination(hash, dest) {
    this.destinations.set(toHex(hash), dest);
  }
  /** @param {import("@reticulum/core/src/core/packet.js").Packet} packet */
  async sendPacket(packet) {
    this.sent.push(packet);
    if (this.peer) {
      const peer = this.peer;
      Promise.resolve()
        .then(() => peer._route(packet))
        .catch((err) =>
          console.error("route error:", String(err).slice(0, 120)),
        );
    }
    return true;
  }
  /** @param {import("@reticulum/core/src/core/packet.js").Packet} packet */
  async _route(packet) {
    const dh = toHex(packet.destinationHash);
    if (this.links.has(dh)) {
      await this.links.get(dh).receive(packet);
    } else if (this.destinations.has(dh)) {
      const dest = this.destinations.get(dh);
      if (packet.packetType === PacketType.LINKREQUEST) {
        const link = await Link.accept(dest, this, packet);
        this.addLink(link.linkId, link);
      }
    }
  }
}

/**
 * Establishes a loopback Link pair with a scripted rngit node on the
 * responder side.
 *
 * @param {object} handlers - `{ list, fetch, push?, delete? }` request
 *   handlers, each `(data) → response`.
 * @returns {Promise<{ initiator: Link, responderDest: Destination }>}
 */
async function makeRngitPair(handlers) {
  const responderIdentity = await Identity.generate();
  const tI = new LoopbackTransport();
  const tR = new LoopbackTransport();
  tI.peer = tR;
  tR.peer = tI;

  const responderDest = await Destination.create(
    "git.repositories",
    Direction.IN,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: tR }),
  );
  tR.addDestination(responderDest.destinationHash, responderDest);

  await responderDest.registerRequestHandler("/git/list", {
    allow: Allow.ALL,
    responseGenerator: async (_path, data) => handlers.list(data),
  });
  await responderDest.registerRequestHandler("/git/fetch", {
    allow: Allow.ALL,
    responseGenerator: async (_path, data) => handlers.fetch(data),
  });
  if (handlers.push) {
    await responderDest.registerRequestHandler("/git/push", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data) => handlers.push(data),
    });
  }
  if (handlers.delete) {
    await responderDest.registerRequestHandler("/git/delete", {
      allow: Allow.ALL,
      responseGenerator: async (_path, data) => handlers.delete(data),
    });
  }

  const initiatorDest = await Destination.create(
    "git.repositories",
    Direction.OUT,
    DestType.SINGLE,
    responderIdentity,
    /** @type {any} */ ({ transport: tI }),
  );

  const initiator = await Link.initiate(initiatorDest, tI);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const responder = [...tR.links.values()][0];
    if (
      initiator.status === LinkStatus.ACTIVE &&
      responder &&
      responder.status === LinkStatus.ACTIVE
    ) {
      return { initiator, responderDest };
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`handshake did not complete (initiator=${initiator.status})`);
}

// ---------------------------------------------------------------------------
// Unit level
// ---------------------------------------------------------------------------

describe("parseUploadPackRequest", () => {
  test("extracts wants and haves", () => {
    const sha = (n) => `${String(n).repeat(40)}`.slice(0, 40);
    const body = [
      encodePktLine(`want ${sha(1)} side-band-64k ofs-delta\n`),
      encodePktLine(`want ${sha(2)}\n`),
      FLUSH,
      encodePktLine(`have ${sha(3)}\n`),
      encodePktLine("done\n"),
    ].reduce((acc, part) => {
      const out = new Uint8Array(acc.length + part.length);
      out.set(acc);
      out.set(part, acc.length);
      return out;
    }, new Uint8Array(0));
    const { wants, haves } = parseUploadPackRequest(body);
    assert.deepEqual(wants, [sha(1), sha(2)]);
    assert.deepEqual(haves, [sha(3)]);
  });

  test("rejects shallow requests", () => {
    const body = [encodePktLine("deepen 1\n"), FLUSH].reduce(
      joinBytes,
      new Uint8Array(0),
    );
    assert.throws(() => parseUploadPackRequest(body), UnsupportedFeatureError);
  });
});

describe("buildInfoRefsResponse", () => {
  test("advertises refs, HEAD and symref capabilities", () => {
    const listing = {
      head: "refs/heads/main",
      refs: new Map([
        ["refs/heads/main", "a".repeat(40)],
        ["refs/tags/v1.0", "b".repeat(40)],
      ]),
    };
    const lines = decodePktLines(
      buildInfoRefsResponse(listing, "git-upload-pack"),
    );
    assert.equal(
      new TextDecoder().decode(lines[0]),
      "# service=git-upload-pack\n",
    );
    assert.equal(lines[1], null); // flush after service header
    const headLine = new TextDecoder().decode(lines[2]);
    assert.match(headLine, /^a{40} HEAD\0/);
    assert.match(headLine, /symref=HEAD:refs\/heads\/main/);
    assert.match(headLine, /side-band-64k/);
    const mainLine = new TextDecoder().decode(lines[3]);
    assert.equal(mainLine, `${"a".repeat(40)} refs/heads/main\n`);
    assert.equal(lines[5], null); // terminating flush
  });

  test("falls back to the capabilities pseudo-ref for empty repos", () => {
    const lines = decodePktLines(
      buildInfoRefsResponse({ head: null, refs: new Map() }, "git-upload-pack"),
    );
    const refLine = new TextDecoder().decode(lines[2]);
    assert.match(refLine, /^0{40} capabilities\^\{\}\0side-band-64k/);
  });
});

describe("buildUploadPackResponse", () => {
  test("answers NAK then muxes the pack on band 1", () => {
    const pack = new Uint8Array(3000).fill(0xab);
    const response = buildUploadPackResponse(pack);
    const lines = decodePktLines(response);
    assert.equal(new TextDecoder().decode(lines[0]), "NAK\n");
    // All pack bytes arrive on band 1, in order, minus the band byte.
    const reassembled = lines
      .slice(1)
      .map((line) => line.subarray(1))
      .reduce(joinBytes, new Uint8Array(0));
    assert.deepEqual(Array.from(reassembled), Array.from(pack));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: clone and incremental fetch through the transport
// ---------------------------------------------------------------------------

describe("rngit transport against isomorphic-git (loopback)", () => {
  /**
   * Builds the scripted rngit node handlers backed by a fixture repo.
   * Supports the full transfer set: list, fetch, push and delete — so
   * push tests run against a bare repository fixture.
   *
   * @param {string} srcDir
   * @param {{ lastPush?: any }} [state] - Recording object for assertions
   *   about which push path the node took.
   */
  function rngitNode(srcDir, state = {}) {
    return {
      /** @param {any} data */
      async list(data) {
        assert.equal(data[IDX_REPOSITORY], "test/repo");
        const refs = runGit(
          srcDir,
          "for-each-ref",
          "--format",
          "%(objectname) %(refname)",
        ).trim();
        const head = runGit(srcDir, "symbolic-ref", "HEAD").trim();
        const payload = `${refs}\n@${head} HEAD\n`;
        return new Uint8Array([0, ...new TextEncoder().encode(payload)]);
      },

      /**
       * @param {any} data
       */
      async fetch(data) {
        assert.equal(data[IDX_REPOSITORY], "test/repo");
        // Shape check: refs carry sha+ref, haves are SHAs.
        assert.ok(Array.isArray(data.refs) && data.refs.length > 0);
        for (const entry of data.refs) {
          assert.match(entry.sha, /^[0-9a-f]{40}$/);
          assert.match(entry.ref, /^refs\//);
        }
        if (data.have) {
          for (const have of data.have) assert.match(have, /^[0-9a-f]{40}$/);
        }

        const bundlePath = join(srcDir, "fetch.bundle");
        const args = ["bundle", "create", "-q", bundlePath, "--all"];
        // Honour the client's haves so incremental fetches stay thin.
        for (const have of data.have ?? []) {
          args.push(`^${have}`);
        }
        runGit(srcDir, ...args);
        return new ResourceResponse(
          new Uint8Array(readFileSync(bundlePath)),
          new Map([[1, 0]]), // IDX_RESULT_CODE = RES_OK
        );
      },

      /**
       * Mirrors the node's `/git/push` handling: bundles are fetched into
       * the repository, direct `update_ref` operations set refs without a
       * transfer.
       * @param {any} data
       */
      async push(data) {
        assert.equal(data[IDX_REPOSITORY], "test/repo");
        if (data.bundle) {
          state.lastPush = "bundle";
          const bundlePath = join(srcDir, "push.bundle");
          writeFileSync(bundlePath, data.bundle);
          const args = [
            "fetch",
            "-q",
            bundlePath,
            `${data.local_ref}:${data.remote_ref}`,
          ];
          if (data.force) args.push("--force");
          runGit(srcDir, ...args);
        } else if (Array.isArray(data.operations)) {
          state.lastPush = "operations";
          for (const op of data.operations) {
            assert.equal(op.action, "update_ref");
            // The object must exist in the node's repository.
            runGit(srcDir, "cat-file", "-t", op.sha);
            runGit(srcDir, "update-ref", op.ref, op.sha);
          }
        } else {
          throw new Error("invalid push request");
        }
        return new Uint8Array([0]);
      },

      /**
       * Mirrors the node's `/git/delete` handling.
       * @param {any} data
       */
      async delete(data) {
        assert.equal(data[IDX_REPOSITORY], "test/repo");
        assert.match(data.ref, /^refs\//);
        runGit(srcDir, "update-ref", "-d", data.ref);
        return new Uint8Array([0]);
      },
    };
  }

  test("clone pulls refs, history and working tree from the rngit node", async () => {
    const src = makeSourceRepo();
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-clone-"));
    try {
      const { initiator } = await makeRngitPair(rngitNode(src.dir));
      const client = new RngitClient({
        url: `rns://${"ab".repeat(16)}/test/repo`,
        link: initiator,
      });

      const result = await clone({
        fs,
        dir: cloneDir,
        url: `rns://${"ab".repeat(16)}/test/repo`,
        client,
      });

      // The default branch came from the symref advertisement.
      assert.equal(result.defaultBranch, "refs/heads/main");
      assert.equal(result.fetchHead, src.head());

      // HEAD, refs and working tree match the source repository.
      assert.equal(runGit(cloneDir, "rev-parse", "HEAD").trim(), src.head());
      assert.equal(
        runGit(cloneDir, "rev-parse", "refs/remotes/origin/main").trim(),
        src.head(),
      );
      assert.equal(
        fs.readFileSync(join(cloneDir, "README.md"), "utf8"),
        "# rngit test\nfirst\n",
      );
      assert.equal(
        fs.readFileSync(join(cloneDir, "lib.js"), "utf8"),
        "export const answer = 42;\n",
      );
      // Git is happy with the store (fsck on the full clone).
      runGit(cloneDir, "fsck", "--strict");

      // The recorded remote stays the rns:// URL, placeholder-free.
      const config = fs.readFileSync(join(cloneDir, ".git", "config"), "utf8");
      assert.match(config, /rns:\/\/[0-9a-f]+\/test\/repo/);
      assert.ok(!config.includes("http://rngit"));
    } finally {
      removeTree(src.dir);
      removeTree(cloneDir);
    }
  });

  test("fetch updates incrementally using the have list", async () => {
    const src = makeSourceRepo();
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-fetch-"));
    try {
      const { initiator } = await makeRngitPair(rngitNode(src.dir));
      const url = `rns://${"cd".repeat(16)}/test/repo`;
      const client = new RngitClient({ url, link: initiator });

      await clone({ fs, dir: cloneDir, url, client });
      const clonedAt = src.head();

      // New commit on the source side.
      fs.writeFileSync(join(src.dir, "lib.js"), "export const answer = 43;\n");
      runGit(src.dir, "add", ".");
      runGit(src.dir, "commit", "-q", "-m", "three");

      // Same client/link — a second fetch session over the same transport.
      await fetch({ fs, dir: cloneDir, url, client });

      assert.notEqual(src.head(), clonedAt);
      assert.equal(
        runGit(cloneDir, "rev-parse", "refs/remotes/origin/main").trim(),
        src.head(),
      );
      // fetch updates refs only — merge the update into the local branch,
      // then verify the worktree, history and store integrity.
      runGit(cloneDir, "merge", "--ff-only", "origin/main");
      assert.equal(
        fs.readFileSync(join(cloneDir, "lib.js"), "utf8"),
        "export const answer = 43;\n",
      );
      runGit(cloneDir, "fsck", "--strict");
    } finally {
      removeTree(src.dir);
      removeTree(cloneDir);
    }
  });

  test("multi-segment bundles (over 1 MiB) clone through the transport", async () => {
    const src = makeSourceRepo();
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-big-"));
    try {
      // A ~2.5 MiB incompressible file pushes the bundle over the
      // MAX_EFFICIENT_SIZE segment boundary (1 MiB - 1). Deterministic
      // arithmetic patterns with a short period compress to almost
      // nothing — use real random bytes so the bundle genuinely spans
      // multiple segments.
      const big = randomBytes(2.5 * 1024 * 1024);
      fs.writeFileSync(join(src.dir, "blob.bin"), big);
      runGit(src.dir, "add", ".");
      runGit(src.dir, "commit", "-q", "-m", "big file");

      const { initiator } = await makeRngitPair(rngitNode(src.dir));
      const client = new RngitClient({
        url: `rns://${"99".repeat(16)}/test/repo`,
        link: initiator,
      });

      const result = await clone({
        fs,
        dir: cloneDir,
        url: `rns://${"99".repeat(16)}/test/repo`,
        client,
      });
      assert.equal(result.fetchHead, src.head());
      assert.equal(runGit(cloneDir, "rev-parse", "HEAD").trim(), src.head());
      runGit(cloneDir, "fsck", "--strict");
      const round = fs.readFileSync(join(cloneDir, "blob.bin"));
      assert.equal(round.length, big.length);
      assert.ok(Buffer.compare(round, big) === 0, "big file intact");
    } finally {
      removeTree(src.dir);
      removeTree(cloneDir);
    }
  });

  test("clone and push report isomorphic-git progress events", async () => {
    const src = makeSourceRepo();
    const bareDir = mkdtempSync(join(tmpdir(), "rngit-prog-"));
    runGit(bareDir, "init", "-q", "--bare", "-b", "main", ".");
    runGit(src.dir, "push", "-q", bareDir, "main", "refs/tags/v1.0");
    // Make the clone bundle span multiple segments (random bytes —
    // deterministic patterns compress away).
    const big = randomBytes(1.5 * 1024 * 1024);
    fs.writeFileSync(join(src.dir, "blob.bin"), big);
    runGit(src.dir, "add", ".");
    runGit(src.dir, "commit", "-q", "-m", "big file");
    runGit(src.dir, "push", "-q", bareDir, "main");
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-prog-clone-"));
    try {
      const { initiator } = await makeRngitPair(rngitNode(bareDir, {}));
      const client = new RngitClient({
        url: `rns://${"66".repeat(16)}/test/repo`,
        link: initiator,
      });

      /** @type {any[]} */
      const downloadEvents = [];
      await clone({
        fs,
        dir: cloneDir,
        url: `rns://${"66".repeat(16)}/test/repo`,
        client,
        onProgress: (/** @type {any} */ e) => downloadEvents.push(e),
      });
      const receiving = downloadEvents.filter(
        (e) => e.phase === "Receiving objects",
      );
      // Our transfer events use byte totals over 1 MiB; isomorphic-git
      // also emits its own "Receiving objects" events with object-count
      // totals (small numbers), which interleave.
      const ours = receiving.filter((e) => e.total > 1024 * 1024);
      assert.ok(ours.length >= 2, "download progress events arrived");
      // Monotonic across our events (segments accumulate).
      for (let i = 1; i < ours.length; i++) {
        assert.ok(ours[i].loaded >= ours[i - 1].loaded);
      }
      // The bundle size is covered and the transfer completes.
      assert.ok(ours[ours.length - 1].loaded > 1024 * 1024);
      assert.ok(ours[ours.length - 1].loaded <= ours[ours.length - 1].total);

      // Push progress: "Writing objects" while the bundle uploads.
      fs.writeFileSync(join(cloneDir, "lib.js"), "export const p = 1;\n");
      runGit(cloneDir, "add", ".");
      runGit(cloneDir, "config", "user.name", "Test");
      runGit(cloneDir, "config", "user.email", "test@example.com");
      runGit(cloneDir, "commit", "-q", "-m", "progress push");
      /** @type {any[]} */
      const uploadEvents = [];
      await push({
        fs,
        dir: cloneDir,
        ref: "main",
        client,
        onProgress: (/** @type {any} */ e) => uploadEvents.push(e),
      });
      const writing = uploadEvents.filter((e) => e.phase === "Writing objects");
      assert.ok(writing.length >= 1, "upload progress events arrived");
      for (let i = 1; i < writing.length; i++) {
        assert.ok(writing[i].loaded >= writing[i - 1].loaded);
      }
      assert.ok(
        writing[writing.length - 1].loaded > 0,
        "upload progress reports bytes",
      );
    } finally {
      removeTree(src.dir);
      removeTree(bareDir);
      removeTree(cloneDir);
    }
  });

  test("parseReceivePackRequest extracts commands, caps and pack", () => {
    const sha = (n) => `${n}`.repeat(40).slice(0, 40);
    const caps = "report-status agent=git/isomorphic-git@1.42.2";
    const pack = new Uint8Array([
      0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1, 0xde, 0xad,
    ]);
    const body = [
      encodePktLine(`${sha("0")} ${sha("1")} refs/heads/main\0 ${caps}\n`),
      FLUSH,
      pack,
    ].reduce(joinBytes, new Uint8Array(0));
    const { commands, pack: extracted } = parseReceivePackRequest(body);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].old, sha("0"));
    assert.equal(commands[0].new, sha("1"));
    assert.equal(commands[0].ref, "refs/heads/main");
    assert.deepEqual(Array.from(extracted ?? []), Array.from(pack));
  });

  test("buildReportStatusResponse frames unpack/ref statuses", () => {
    const response = buildReportStatusResponse([
      { ref: "refs/heads/main", ok: true },
      { ref: "refs/tags/x", ok: false, error: "already exists" },
    ]);
    const lines = decodePktLines(response);
    const text = (/** @type {Uint8Array} */ l) => new TextDecoder().decode(l);
    assert.equal(text(lines[0]), "unpack ok\n");
    assert.equal(text(lines[1]), "ok refs/heads/main\n");
    assert.equal(text(lines[2]), "ng refs/tags/x already exists\n");
    assert.equal(lines[3], null);
  });

  test("buildBundle output parses back with parseBundle", async () => {
    const pack = await emptyPack();
    const bundle = buildBundle(
      [{ sha: "a".repeat(40), ref: "refs/heads/main" }],
      pack,
    );
    const parsed = parseBundle(bundle);
    assert.equal(parsed.refs.get("refs/heads/main"), "a".repeat(40));
    assert.deepEqual(Array.from(parsed.pack), Array.from(pack));
  });

  test("push advances the rngit node's repository (bare fixture)", async () => {
    const src = makeSourceRepo();
    // Serve from a bare clone so pushes land in a real server-side repo.
    const bareDir = mkdtempSync(join(tmpdir(), "rngit-bare-"));
    runGit(bareDir, "init", "-q", "--bare", "-b", "main", ".");
    runGit(src.dir, "push", "-q", bareDir, "main", "refs/tags/v1.0");
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-push-"));
    try {
      const state = {};
      const { initiator } = await makeRngitPair(rngitNode(bareDir, state));
      const client = new RngitClient({
        url: `rns://${"77".repeat(16)}/test/repo`,
        link: initiator,
      });

      await clone({
        fs,
        dir: cloneDir,
        url: `rns://${"77".repeat(16)}/test/repo`,
        client,
      });
      assert.equal(state.lastPush, undefined);

      // Local commit, then push.
      fs.writeFileSync(join(cloneDir, "lib.js"), "export const answer = 44;\n");
      runGit(cloneDir, "add", ".");
      runGit(cloneDir, "config", "user.name", "Test");
      runGit(cloneDir, "config", "user.email", "test@example.com");
      runGit(cloneDir, "commit", "-q", "-m", "local work");
      const localHead = runGit(cloneDir, "rev-parse", "HEAD").trim();

      const result = await push({ fs, dir: cloneDir, ref: "main", client });
      assert.equal(result.ok, true);
      assert.equal(result.refs["refs/heads/main"].ok, true);
      assert.equal(
        state.lastPush,
        "bundle",
        "bundle path used for new objects",
      );

      // The node's repository advanced to the pushed commit.
      assert.equal(
        runGit(bareDir, "rev-parse", "refs/heads/main").trim(),
        localHead,
      );
      runGit(bareDir, "fsck", "--strict");
      // The clone's remote-tracking ref moved too.
      assert.equal(
        runGit(cloneDir, "rev-parse", "refs/remotes/origin/main").trim(),
        localHead,
      );
    } finally {
      removeTree(src.dir);
      removeTree(bareDir);
      removeTree(cloneDir);
    }
  });

  test("push of existing objects uses the direct update path", async () => {
    const src = makeSourceRepo();
    const bareDir = mkdtempSync(join(tmpdir(), "rngit-bare-"));
    runGit(bareDir, "init", "-q", "--bare", "-b", "main", ".");
    runGit(src.dir, "push", "-q", bareDir, "main", "refs/tags/v1.0");
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-push-"));
    try {
      const state = {};
      const { initiator } = await makeRngitPair(rngitNode(bareDir, state));
      const client = new RngitClient({
        url: `rns://${"78".repeat(16)}/test/repo`,
        link: initiator,
      });
      await clone({
        fs,
        dir: cloneDir,
        url: `rns://${"78".repeat(16)}/test/repo`,
        client,
      });

      // Push an already-present commit under a new branch name: every
      // object exists on the node, so no bundle transfer is needed.
      const result = await push({
        fs,
        dir: cloneDir,
        ref: "main",
        remoteRef: "refs/heads/copy",
        client,
      });
      assert.equal(result.ok, true);
      assert.equal(state.lastPush, "operations", "direct update path");
      assert.equal(
        runGit(bareDir, "rev-parse", "refs/heads/copy").trim(),
        runGit(bareDir, "rev-parse", "refs/heads/main").trim(),
      );
    } finally {
      removeTree(src.dir);
      removeTree(bareDir);
      removeTree(cloneDir);
    }
  });

  test("push deletes a remote ref", async () => {
    const src = makeSourceRepo();
    const bareDir = mkdtempSync(join(tmpdir(), "rngit-bare-"));
    runGit(bareDir, "init", "-q", "--bare", "-b", "main", ".");
    runGit(src.dir, "push", "-q", bareDir, "main", "refs/tags/v1.0");
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-del-"));
    try {
      const { initiator } = await makeRngitPair(rngitNode(bareDir, {}));
      const client = new RngitClient({
        url: `rns://${"79".repeat(16)}/test/repo`,
        link: initiator,
      });
      await clone({
        fs,
        dir: cloneDir,
        url: `rns://${"79".repeat(16)}/test/repo`,
        client,
      });
      assert.match(
        runGit(bareDir, "rev-parse", "refs/heads/main"),
        /^[0-9a-f]{40}$/,
      );

      const result = await push({
        fs,
        dir: cloneDir,
        ref: "main",
        delete: true,
        client,
      });
      assert.equal(result.ok, true);
      assert.equal(
        runGit(
          bareDir,
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/main",
        ),
        "",
        "ref deleted on the node",
      );
    } finally {
      removeTree(src.dir);
      removeTree(bareDir);
      removeTree(cloneDir);
    }
  });

  test("non-fast-forward pushes without force are rejected client-side", async () => {
    const src = makeSourceRepo();
    const bareDir = mkdtempSync(join(tmpdir(), "rngit-bare-"));
    runGit(bareDir, "init", "-q", "--bare", "-b", "main", ".");
    runGit(src.dir, "push", "-q", bareDir, "main", "refs/tags/v1.0");
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-ff-"));
    try {
      const { initiator } = await makeRngitPair(rngitNode(bareDir, {}));
      const client = new RngitClient({
        url: `rns://${"7a".repeat(16)}/test/repo`,
        link: initiator,
      });
      await clone({
        fs,
        dir: cloneDir,
        url: `rns://${"7a".repeat(16)}/test/repo`,
        client,
      });
      runGit(cloneDir, "config", "user.name", "Test");
      runGit(cloneDir, "config", "user.email", "test@example.com");

      // Diverge the server.
      runGit(src.dir, "commit", "--allow-empty", "-q", "-m", "server side");
      runGit(src.dir, "push", "-q", bareDir, "main");
      // Diverge the client.
      runGit(cloneDir, "commit", "--allow-empty", "-q", "-m", "client side");

      await assert.rejects(
        () => push({ fs, dir: cloneDir, ref: "main", client }),
        (/** @type {any} */ err) => err.code === "PushRejectedError",
      );

      // With force, the push lands.
      const result = await push({
        fs,
        dir: cloneDir,
        ref: "main",
        force: true,
        client,
      });
      assert.equal(result.ok, true);
      assert.equal(
        runGit(bareDir, "rev-parse", "refs/heads/main").trim(),
        runGit(cloneDir, "rev-parse", "HEAD").trim(),
      );
    } finally {
      removeTree(src.dir);
      removeTree(bareDir);
      removeTree(cloneDir);
    }
  });

  test("empty-bundle replies mean nothing to transfer", async () => {
    const src = makeSourceRepo();
    const cloneDir = mkdtempSync(join(tmpdir(), "rngit-empty-"));
    try {
      const { initiator } = await makeRngitPair(rngitNode(src.dir));
      const url = `rns://${"ef".repeat(16)}/test/repo`;
      const client = new RngitClient({ url, link: initiator });
      const headAtClone = src.head();

      await clone({ fs, dir: cloneDir, url, client });
      assert.equal(runGit(cloneDir, "rev-parse", "HEAD").trim(), headAtClone);

      // A node that answers every fetch with the empty-bundle status byte
      // (\x00) — everything the client wants is already local.
      const alwaysEmpty = {
        list: rngitNode(src.dir).list,
        fetch: async () => new Uint8Array([0]),
      };
      const second = await makeRngitPair(alwaysEmpty);
      const emptyClient = new RngitClient({ url, link: second.initiator });

      await fetch({ fs, dir: cloneDir, url, client: emptyClient });

      // No change, no corruption.
      assert.equal(
        runGit(cloneDir, "rev-parse", "refs/remotes/origin/main").trim(),
        headAtClone,
      );
      runGit(cloneDir, "fsck", "--strict");
    } finally {
      removeTree(src.dir);
      removeTree(cloneDir);
    }
  });
});

/** @param {Uint8Array} acc @param {Uint8Array} part */
function joinBytes(acc, part) {
  const out = new Uint8Array(acc.length + part.length);
  out.set(acc);
  out.set(part, acc.length);
  return out;
}

/** Best-effort recursive removal — cleanup races must not fail a test. */
function removeTree(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* transient */
  }
}
