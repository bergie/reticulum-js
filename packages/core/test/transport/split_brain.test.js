/**
 * Split-brain safety (work doc #37): when an install tree contains two
 * physical copies of `@reticulum/core` (the npm nesting / stale-hoist layout),
 * Node runs two module instances with divergent module state. The
 * instance-scoped caches must make state converge through the shared
 * `Reticulum` instance even in that layout, and `warnIfFragmented` must
 * detect it.
 *
 * The test manufactures a genuine second module instance by copying the core
 * package to a temp directory and importing it from there — the same
 * resolved-path-based module dedupe mechanism npm fragmentation exercises.
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Reticulum } from "../../src/core/reticulum.js";
import {
  CORE_INSTANCE_TOKEN,
  warnIfFragmented,
} from "../../src/transport/identity-cache.js";

test("split-brain — a fragmented install shares state through the instance", async (t) => {
  // Manufacture a second physical copy of the core package, exactly like a
  // fragmented npm tree: importing the same source from a different resolved
  // path gives Node two module instances. Needs a writable temp dir; runners
  // that sandbox the filesystem (e.g. `deno test` without --allow-write)
  // can't exercise it, so the test skips instead of failing.
  const coreRoot = fileURLToPath(new URL("../../", import.meta.url));
  let copyDir;
  try {
    copyDir = mkdtempSync(join(tmpdir(), "rns-split-brain-"));
    cpSync(join(coreRoot, "src"), join(copyDir, "src"), { recursive: true });
    cpSync(join(coreRoot, "package.json"), join(copyDir, "package.json"));
  } catch (err) {
    t.skip(`temp dir unavailable: ${err.message.split("\n")[0]}`);
    return;
  }
  t.after(() => rmSync(copyDir, { recursive: true, force: true }));

  const copyUrl = (rel) => new URL(`file://${join(copyDir, "src", rel)}`).href;
  const { Reticulum: ReticulumCopy } = await import(
    copyUrl("core/reticulum.js")
  );
  const { Destination: DestinationCopy } = await import(
    copyUrl("core/destination.js")
  );
  const { Identity: IdentityCopy } = await import(copyUrl("core/identity.js"));

  await t.test("the two copies are genuinely distinct module instances", () => {
    assert.notStrictEqual(ReticulumCopy, Reticulum);
  });

  await t.test(
    "warnIfFragmented detects the mismatch (and stays silent when tokens match)",
    () => {
      // Same-copy: no fragmentation, returns false.
      assert.equal(
        warnIfFragmented("test", CORE_INSTANCE_TOKEN, CORE_INSTANCE_TOKEN),
        false,
      );
      // Cross-copy: different tokens → fragmentation detected.
      const otherToken = {};
      assert.equal(
        warnIfFragmented("test", CORE_INSTANCE_TOKEN, otherToken),
        true,
      );
    },
  );

  await t.test(
    "state converges through the shared Reticulum instance",
    async (t2) => {
      // A Reticulum instance built by THIS copy's Reticulum (the transport
      // side, e.g. the embedding app holding the hoisted copy). A dependent
      // package bundled against the OTHER copy (e.g. @reticulum/lxmf, whose
      // classes come from the temp copy above) receives this same instance
      // object — that's the layout the acceptance criteria describe.
      const rns = new Reticulum();
      t2.after(() => rns.stop?.());

      // A peer announces: the transport ingests the identity into the
      // instance-scoped cache (this is what `_handleAnnounce` does on a real
      // announce; here we drive the same instance method directly).
      const peerIdentity = await IdentityCopy.generate();
      const peerDest = await DestinationCopy.SINGLE(
        "splitbrain.test",
        1, // Direction.IN
        peerIdentity,
      );
      const destHash = peerDest.destinationHash;
      await rns.transport.rememberIdentity(
        crypto.getRandomValues(new Uint8Array(32)),
        destHash,
        peerIdentity.publicKey,
        null,
      );

      // The dependent (copy B) recalls through the shared instance — state
      // converges regardless of tree layout. There are no class-level
      // caches to diverge anymore: the only reachable state is the
      // instance's, which copy B accesses by holding the `rns` object
      // (that's the fix).
      const recalled = await rns.transport.recallIdentity(destHash);
      assert.ok(recalled, "identity recalled through the shared instance");

      // Prove `recalled` really carries the peer's public key: a signature by
      // the peer verifies under the recalled identity.
      const sig = await peerIdentity.sign(new Uint8Array([1, 2, 3]));
      assert.ok(
        await recalled.validate(sig, new Uint8Array([1, 2, 3])),
        "the recalled identity is the peer's",
      );

      // Ratchets converge the same way.
      const ratchet = crypto.getRandomValues(new Uint8Array(32));
      rns.transport.rememberRatchet(destHash, ratchet);
      assert.deepEqual(
        rns.transport.recallRatchet(destHash),
        ratchet,
        "ratchet recalled through the shared instance",
      );
    },
  );

  await t.test(
    "receipts converge through the shared instance too",
    async () => {
      const rns = new Reticulum();
      const { PacketReceipt: PacketReceiptCopy } = await import(
        copyUrl("core/packet_receipt.js")
      );

      // The transport tracks a receipt built by copy B's class, and the
      // instance lookup finds it — a PROOF arriving on either copy's
      // transport resolves against the same receipt.
      const receipt = new PacketReceiptCopy(
        crypto.getRandomValues(new Uint8Array(32)),
        crypto.getRandomValues(new Uint8Array(16)),
      );
      rns.transport.trackReceipt(receipt);
      assert.strictEqual(
        rns.transport.findReceipt(receipt.truncatedHash),
        receipt,
        "receipt found through the shared instance",
      );
    },
  );
});
