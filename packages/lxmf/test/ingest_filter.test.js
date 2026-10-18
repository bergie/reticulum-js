/**
 * Ingest filter + dropped-mirror memory (metered traffic levers).
 *
 * The `ingestFilter` hook lets the application decide which *mirrored*
 * propagation blobs (offer-born peer-sync transfers) to store. Two
 * invariants:
 *
 *   1. The hook never sees direct submissions to this node — the node is
 *      their origin custodian and the only copy, so dropping one would
 *      silently destroy the sender's message (a black hole).
 *   2. What was dropped is remembered: the /offer want-list never re-wants a
 *      processed transient id (stored, locally delivered, or dropped), so a
 *      dropped mirror is not re-pulled on the next sync round — and not
 *      re-pulled in bulk when a peer re-peers after rotation or restart and
 *      offers its backlog afresh.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Identity } from "@reticulum/core/src/core/identity.js";
import { toHex } from "@reticulum/core/src/utils/encoding.js";
import { PropagationNode } from "../src/propagation_node.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/** A blob over the minimum size with a cost-0 stamp, addressed to `dest`. */
function blob(dest) {
  const lxmf = rnd(160);
  lxmf.set(dest, 0);
  const stamped = new Uint8Array(lxmf.length + 32);
  stamped.set(lxmf, 0);
  return stamped;
}

function makeNode(ingestFilter) {
  return new PropagationNode({
    stampCost: 0,
    peeringCost: 0,
    ingestFilter,
  });
}

test("the hook drops third-party mirrors and keeps allowlisted ones", async () => {
  const allowed = rnd(16);
  const thirdParty = rnd(16);
  const allowedHex = toHex(allowed);
  /** @type {any[]} */
  const seen = [];
  const node = makeNode((candidate) => {
    seen.push(candidate);
    return toHex(candidate.destinationHash) === allowedHex;
  });

  const res = await node.ingestBlobs([blob(thirdParty), blob(allowed)], {
    origin: "peer-sync",
  });

  assert.equal(res.dropped, 1, "the third-party mirror is dropped");
  assert.equal(res.stored, 1, "the allowlisted mirror is stored");
  assert.equal(node.store.size, 1);
  assert.equal(
    toHex(
      node.store.get(node.store.transientIdsForDestination(allowed)[0])
        .destinationHash,
    ),
    allowedHex,
  );
  assert.equal(seen.length, 2, "the hook sees every mirror candidate");
  const candidate = seen[0];
  assert.ok(candidate.transientId instanceof Uint8Array);
  assert.ok(candidate.destinationHash instanceof Uint8Array);
  assert.equal(typeof candidate.size, "number");
  assert.equal(typeof candidate.stampValue, "number");
});

test("direct submissions are never filtered (origin custody)", async () => {
  const hookCalls = [];
  const node = makeNode((candidate) => {
    hookCalls.push(candidate);
    return false; // even a "drop everything" policy must not apply here
  });

  const res = await node.ingestBlobs([blob(rnd(16))], {
    origin: "submission",
  });

  assert.equal(hookCalls.length, 0, "the hook never sees direct submissions");
  assert.equal(res.stored, 1, "direct submissions are always kept");
  assert.equal(res.dropped, 0);
  assert.equal(node.store.size, 1);
});

test("dropped mirrors are not re-wanted on the next offer round", async () => {
  const allowed = rnd(16);
  const thirdParty = rnd(16);
  /** @type {any[]} */
  const seen = [];
  const node = makeNode((candidate) => {
    seen.push(candidate);
    return toHex(candidate.destinationHash) === toHex(allowed);
  });
  await node.ingestBlobs([blob(thirdParty), blob(allowed)], {
    origin: "peer-sync",
  });
  // transient ids are SHA-256(lxmfData) — capture the real ones from the hook.
  const thirdPartyTid = toHex(seen[0].transientId);
  const allowedTid = toHex(seen[1].transientId);

  const remote = await Identity.generate();
  const unknown = rnd(32);
  const response = await node.handleOfferRequest(remote, [
    new Uint8Array(32), // any key validates at cost 0
    [seen[0].transientId, seen[1].transientId, unknown],
  ]);

  // The dropped id must not come back as wanted (it was processed); the
  // stored one is not re-wanted; the never-seen id still is.
  assert.ok(Array.isArray(response), "the node wants the unknown id");
  assert.equal(response.length, 1);
  assert.notEqual(toHex(response[0]), thirdPartyTid);
  assert.notEqual(toHex(response[0]), allowedTid);
  assert.equal(toHex(response[0]), toHex(unknown));
});

test("locally delivered ids are not re-wanted either", async () => {
  const node = makeNode(null);
  const tid = rnd(32);
  node.locallyProcessed.set(toHex(tid), Date.now() / 1000);

  const remote = await Identity.generate();
  const response = await node.handleOfferRequest(remote, [
    new Uint8Array(32),
    [tid],
  ]);
  assert.strictEqual(
    response,
    false,
    "a processed id must not be re-wanted (previously it was, re-pulling it)",
  );
});
