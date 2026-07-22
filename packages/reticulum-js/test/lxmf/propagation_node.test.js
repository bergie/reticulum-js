/**
 * Propagation node server logic (§5.3) — store, `/get` exchange, and ingestion.
 *
 * Tests the protocol logic in isolation (no transport): the MessageStore, the
 * PropagationNode `/get` request handler (list / fetch / purge / ownership /
 * access control), and ingestion including the stamp-validation path whose
 * transient_id derivation is verified against the Python reference fixture.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType } from "../../src/core/packet.js";
import {
  PEER_ERROR_NO_ACCESS,
  PEER_ERROR_NO_IDENTITY,
} from "../../src/lxmf/constants.js";
import { Message } from "../../src/lxmf/message.js";
import { MessageStore } from "../../src/lxmf/message_store.js";
import { PropagationNode } from "../../src/lxmf/propagation_node.js";
import { fromHex, toHex } from "../../src/utils/encoding.js";

const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "fixtures", "lxmf_propagation.json"),
    "utf8",
  ),
);

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Builds a fabricated store entry addressed to `destinationHash`. */
function fakeEntry(destinationHash, size) {
  return {
    transientId: rnd(32),
    destinationHash,
    lxmfData: rnd(size),
    stampData: rnd(32),
    received: 1000,
    stampValue: 0,
    size,
  };
}

describe("MessageStore", () => {
  test("add/has/get/remove and dedup", () => {
    const store = new MessageStore();
    const e = fakeEntry(rnd(16), 100);
    assert.strictEqual(store.add(e), true);
    assert.strictEqual(store.has(e.transientId), true);
    assert.strictEqual(store.get(e.transientId), e);
    assert.strictEqual(store.add(e), false, "duplicate add is a no-op");
    assert.strictEqual(store.size, 1);
    assert.strictEqual(store.remove(e.transientId), true);
    assert.strictEqual(store.has(e.transientId), false);
  });

  test("transientIdsForDestination filters + sorts by size ascending", () => {
    const store = new MessageStore();
    const dest = rnd(16);
    const other = rnd(16);
    store.add(fakeEntry(dest, 300));
    store.add(fakeEntry(dest, 100));
    store.add(fakeEntry(dest, 200));
    store.add(fakeEntry(other, 50)); // not addressed to `dest`

    const ids = store.transientIdsForDestination(dest);
    assert.strictEqual(ids.length, 3);
    const sizes = ids.map((id) => store.get(id).size);
    assert.deepStrictEqual(sizes, [100, 200, 300]);
  });

  test("ownership: serve/purge only affect messages owned by the caller", () => {
    const store = new MessageStore();
    const a = rnd(16);
    const b = rnd(16);
    const ea = fakeEntry(a, 100);
    const eb = fakeEntry(b, 100);
    store.add(ea);
    store.add(eb);

    // B cannot serve or purge A's message.
    assert.strictEqual(store.serveDataForDestination(ea.transientId, b), null);
    assert.strictEqual(store.removeForDestination(ea.transientId, b), false);
    assert.strictEqual(store.has(ea.transientId), true);

    // A can.
    assert.ok(store.serveDataForDestination(ea.transientId, a));
    assert.strictEqual(store.removeForDestination(ea.transientId, a), true);
    assert.strictEqual(store.has(ea.transientId), false);
  });
});

describe("PropagationNode `/get` handler", () => {
  /** A node + a client identity whose messages populate the store. */
  async function setup() {
    const client = await Identity.generate();
    const clientOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      client,
      null,
    );
    const clientHash = clientOut.destinationHash;

    const node = new PropagationNode({ stampCost: 0, stampCostFlexibility: 0 });
    node.store.add(fakeEntry(clientHash, 100));
    node.store.add(fakeEntry(clientHash, 200));
    // Another client's message — must be invisible.
    node.store.add(fakeEntry(rnd(16), 999));

    return { node, client, clientHash };
  }

  test("list phase [null,null] returns the client's transient_ids (size-asc)", async () => {
    const { node, client } = await setup();
    const res = await node.handleGetRequest(client, [null, null]);
    assert.ok(Array.isArray(res));
    assert.strictEqual(res.length, 2);
    const sizes = res.map((id) => node.store.get(id).size);
    assert.deepStrictEqual(sizes, [100, 200]);
  });

  test("fetch phase returns base lxmf_data and purges haves", async () => {
    const { node, client } = await setup();
    const list = /** @type {Uint8Array[]} */ (
      await node.handleGetRequest(client, [null, null])
    );
    const want = list[0];
    const have = list[1];

    const served = await node.handleGetRequest(client, [[want], [have]]);
    assert.ok(Array.isArray(served));
    assert.strictEqual(served.length, 1);
    assert.deepStrictEqual(served[0], node.store.get(want).lxmfData);
    // `have` was purged.
    assert.strictEqual(node.store.has(have), false);
    assert.strictEqual(node.store.has(want), true);
  });

  test("purge-ack phase [null, haves] returns [] and purges", async () => {
    const { node, client } = await setup();
    const list = /** @type {Uint8Array[]} */ (
      await node.handleGetRequest(client, [null, null])
    );
    const res = await node.handleGetRequest(client, [null, [list[0]]]);
    assert.deepStrictEqual(res, []);
    assert.strictEqual(node.store.has(list[0]), false);
  });

  test("respects the client transfer limit (skips oversize)", async () => {
    const client = await Identity.generate();
    const clientOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      client,
      null,
    );
    const node = new PropagationNode({ stampCost: 0, stampCostFlexibility: 0 });
    node.store.add(fakeEntry(clientOut.destinationHash, 600));
    node.store.add(fakeEntry(clientOut.destinationHash, 600));

    // 1 KB limit: two 600-byte messages + overhead exceed it, so only one is
    // served.
    const list = /** @type {Uint8Array[]} */ (
      await node.handleGetRequest(client, [null, null])
    );
    const served = await node.handleGetRequest(client, [
      [list[0], list[1]],
      [],
      1,
    ]);
    assert.ok(Array.isArray(served));
    assert.strictEqual(served.length, 1);
  });

  test("access control: missing identity / disallowed identity", async () => {
    const { node, client } = await setup();
    assert.strictEqual(
      await node.handleGetRequest(null, [null, null]),
      PEER_ERROR_NO_IDENTITY,
    );

    node.identityAllowed = () => false;
    assert.strictEqual(
      await node.handleGetRequest(client, [null, null]),
      PEER_ERROR_NO_ACCESS,
    );
  });
});

describe("PropagationNode ingestion (stamp path)", () => {
  test("stores a blob and derives transient_id == SHA-256(lxmf_data)", async () => {
    const node = new PropagationNode({ stampCost: 0, stampCostFlexibility: 0 });
    // A base lxmf_data addressed to a non-local destination, plus a trailing
    // cost-0 stamp (any 32 bytes suffice at target_cost=0).
    const base = fromHex(FIXTURE.pythonPropagation.lxmfData);
    const stamp = new Uint8Array(32);
    const blob = new Uint8Array(base.length + stamp.length);
    blob.set(base, 0);
    blob.set(stamp, base.length);

    const { stored, delivered } = await node.ingestBlobs([blob]);
    assert.strictEqual(stored, 1);
    assert.strictEqual(delivered, 0);

    const expectedTid = fromHex(FIXTURE.pythonPropagation.transientId);
    const entry = node.store.get(expectedTid);
    assert.ok(entry, "transient_id must match the Python-derived value");
    assert.deepStrictEqual(entry.lxmfData, base);
    assert.deepStrictEqual(entry.stampData, stamp);
  });

  test("locally delivers a message addressed to a registered identity", async () => {
    const recipient = await Identity.fromBytes(
      fromHex(FIXTURE.recipientIdentity128),
    );
    const inDest = await Destination.IN(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient,
      null,
    );

    /** @type {{msg: import("../../src/lxmf/message.js").Message, tid: Uint8Array}|null} */
    let delivered = null;
    const node = new PropagationNode({
      stampCost: 0,
      stampCostFlexibility: 0,
      getDeliveryDestination: (hash) =>
        toHex(hash) ===
        toHex(/** @type {Uint8Array} */ (inDest.destinationHash))
          ? inDest
          : null,
      onLocalDelivery: (msg, tid) => {
        delivered = { msg, tid };
      },
    });

    const base = fromHex(FIXTURE.pythonPropagation.lxmfData);
    const stamp = new Uint8Array(32);
    const blob = new Uint8Array(base.length + stamp.length);
    blob.set(base, 0);
    blob.set(stamp, base.length);

    const res = await node.ingestBlobs([blob]);
    assert.strictEqual(res.delivered, 1);
    assert.strictEqual(res.stored, 0);
    assert.ok(delivered);
    assert.strictEqual(delivered.msg.title, FIXTURE.message.title);
    assert.strictEqual(delivered.msg.content, FIXTURE.message.content);
    assert.deepStrictEqual(
      delivered.tid,
      fromHex(FIXTURE.pythonPropagation.transientId),
    );
  });

  test("deduplicates repeated ingestion of the same blob", async () => {
    const node = new PropagationNode({ stampCost: 0, stampCostFlexibility: 0 });
    const base = fromHex(FIXTURE.pythonPropagation.lxmfData);
    const stamp = new Uint8Array(32);
    const blob = new Uint8Array(base.length + stamp.length);
    blob.set(base, 0);
    blob.set(stamp, base.length);

    await node.ingestBlobs([blob]);
    const second = await node.ingestBlobs([blob]);
    assert.strictEqual(second.stored, 0, "duplicate must not re-store");
    assert.strictEqual(node.store.size, 1);
  });

  test("rejects a blob whose stamp is below the required cost", async () => {
    // Require cost 8; a zero stamp has effectively no guaranteed leading-zero
    // bits, so it is rejected by stampValid (the workblock/hash won't meet it).
    const node = new PropagationNode({
      stampCost: 8,
      stampCostFlexibility: 0,
    });
    const base = fromHex(FIXTURE.pythonPropagation.lxmfData);
    const stamp = new Uint8Array(32); // zero stamp
    const blob = new Uint8Array(base.length + stamp.length);
    blob.set(base, 0);
    blob.set(stamp, base.length);

    const res = await node.ingestBlobs([blob]);
    assert.strictEqual(res.rejected, 1);
    assert.strictEqual(res.stored, 0);
  });
});
