/**
 * RoutingTable unit tests (src/transport/router.js).
 *
 * Exercises the path-table acceptance rules — shortest/newest-wins with
 * `random_blob` replay defense and lazy expiry — against synthetic entries, so
 * the logic can be verified independently of announce signature verification.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { createAnnounceRandomHash } from "../../src/core/destination.js";
import { RoutingTable } from "../../src/transport/router.js";
import { bytesEqual, toHex } from "../../src/utils/encoding.js";

/** @param {number} sec Emission timestamp (Unix seconds) encoded into [5:10]. */
function blobAt(sec) {
  return createAnnounceRandomHash(
    crypto.getRandomValues(new Uint8Array(16)),
    sec,
  );
}

const dest = () => crypto.getRandomValues(new Uint8Array(16));
const iface = /** @type {any} */ (
  Object.assign(new EventTarget(), { name: "eth0" })
);

describe("RoutingTable.addOrUpdateRoute — acceptance rules", () => {
  test("adds a route for an unknown destination", () => {
    const table = new RoutingTable();
    const hash = dest();
    const nextHop = crypto.getRandomValues(new Uint8Array(16));

    const ok = table.addOrUpdateRoute(hash, {
      nextHop,
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });

    assert.strictEqual(ok, true);
    const route = table.getRoute(hash);
    assert.ok(route);
    assert.strictEqual(route.hops, 2);
    assert.ok(bytesEqual(route.nextHop, nextHop));
    assert.strictEqual(route.interface, iface);
  });

  test("a shorter path with a newer emission replaces a longer one", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 3,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });
    const shorterNext = crypto.getRandomValues(new Uint8Array(16));
    table.addOrUpdateRoute(hash, {
      nextHop: shorterNext,
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(2000),
    });

    const route = table.getRoute(hash);
    assert.strictEqual(route?.hops, 2);
    assert.ok(bytesEqual(route.nextHop, shorterNext));
  });

  test("a longer path with a newer emission still replaces (Python parity)", () => {
    // Transport.py: a longer path overrides when emitted more recently than the
    // stored timebase — recency wins over hop count for live topology changes.
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });
    const longerNext = crypto.getRandomValues(new Uint8Array(16));
    table.addOrUpdateRoute(hash, {
      nextHop: longerNext,
      hops: 4,
      viaInterface: iface,
      randomBlob: blobAt(5000),
    });

    const route = table.getRoute(hash);
    assert.strictEqual(route?.hops, 4);
    assert.ok(bytesEqual(route.nextHop, longerNext));
  });

  test("a longer path with an older emission is rejected", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(5000),
    });
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 4,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });

    assert.strictEqual(ok, false);
    assert.strictEqual(table.getRoute(hash)?.hops, 2);
  });

  test("an equal-hop, newer emission refreshes the path", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });
    const freshNext = crypto.getRandomValues(new Uint8Array(16));
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: freshNext,
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(2000),
    });

    assert.strictEqual(ok, true);
    assert.ok(bytesEqual(table.getRoute(hash).nextHop, freshNext));
  });

  test("an equal-hop, older emission is rejected", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(3000),
    });
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(2000),
    });

    assert.strictEqual(ok, false);
  });
});

describe("RoutingTable — replay defense & expiry", () => {
  test("a repeated random_blob is always rejected (anti-replay)", () => {
    const table = new RoutingTable();
    const hash = dest();
    const replayed = blobAt(1000);
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: replayed,
    });
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 1, // even a shorter path must not be accepted on a replayed blob
      viaInterface: iface,
      randomBlob: replayed,
    });

    assert.strictEqual(ok, false);
    assert.strictEqual(table.getRoute(hash)?.hops, 2);
  });

  test("an expired route is culled lazily on access", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
      expires: Date.now() - 1000, // already expired
    });

    assert.strictEqual(table.hasRoute(hash), false);
    assert.strictEqual(table.getRoute(hash), undefined);
  });

  test("an expired shorter path is overridden by a longer one", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(5000),
      expires: Date.now() - 1000,
    });
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 5,
      viaInterface: iface,
      randomBlob: blobAt(1000), // older, but the stored path is expired
    });

    assert.strictEqual(ok, true);
    assert.strictEqual(table.getRoute(hash)?.hops, 5);
  });
});

describe("RoutingTable — interface failover", () => {
  test("dropInterface removes only routes learned through that interface", () => {
    const table = new RoutingTable();
    const a = dest();
    const b = dest();
    const eth0 = /** @type {any} */ (
      Object.assign(new EventTarget(), { name: "eth0" })
    );
    const eth1 = /** @type {any} */ (
      Object.assign(new EventTarget(), { name: "eth1" })
    );
    table.addOrUpdateRoute(a, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 1,
      viaInterface: eth0,
      randomBlob: blobAt(1000),
    });
    table.addOrUpdateRoute(b, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 1,
      viaInterface: eth1,
      randomBlob: blobAt(1000),
    });

    table.dropInterface(eth0);

    assert.strictEqual(table.hasRoute(a), false);
    assert.strictEqual(table.hasRoute(b), true);
    // Sanity: keys are hex strings, not raw arrays.
    assert.strictEqual(typeof [...table.routes.keys()][0], "string");
    assert.ok(toHex(b).length);
  });
});
