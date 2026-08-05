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
import { PathState, RoutingTable } from "../../src/transport/router.js";
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

  test("a route unused for the timeout is culled lazily on access", () => {
    // Python culls on IDX_PT_TIMESTAMP + DESTINATION_TIMEOUT (last-used), not
    // the frozen ingestion `expires`. A route whose last-used timestamp is
    // older than the timeout is removed on first lookup.
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
      timestamp: 0, // last used at the epoch — long past the 7-day timeout
    });

    assert.strictEqual(table.hasRoute(hash), false);
    assert.strictEqual(table.getRoute(hash), undefined);
  });

  test("a recently-used route survives a stale ingestion expires (regression)", () => {
    // Regression for the false "Expired route" cull: the cull must use
    // last-used `timestamp`, not the frozen ingestion `expires`. A path in
    // active use must not be culled just because its announce was ingested long
    // ago (mirrors Python IDX_PT_TIMESTAMP + DESTINATION_TIMEOUT).
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
      expires: Date.now() - 1000, // stale ingestion expiry (replacement-only)
      timestamp: Date.now(), // used right now
    });

    const route = table.getRoute(hash);
    assert.ok(route, "recently-used route must not be culled");
    assert.strictEqual(route.hops, 2);
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

  test("a hydrated route re-associates its interface by name lazily", () => {
    // After a restart, persisted routes load with `interface: null` and only
    // the interface name. getRoute must resolve the live reference via the
    // transport's interfaceResolver so egress + bitrate-adaptive timeouts use
    // the correct medium.
    const table = new RoutingTable();
    const hash = dest();
    const tcp = /** @type {any} */ (
      Object.assign(new EventTarget(), { name: "tcp0", bitrate: 1000000 })
    );
    table.interfaceResolver = (name) => (name === "tcp0" ? tcp : null);
    // Simulate a route hydrated from storage.
    table.routes.set(toHex(hash), {
      interface: null,
      interfaceName: "tcp0",
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      timestamp: Date.now(),
      expires: Date.now() + 100000,
      randomBlobs: [blobAt(1000)],
      state: 0,
    });

    const route = table.getRoute(hash);
    assert.ok(route);
    assert.strictEqual(route.interface, tcp, "interface re-associated by name");
    assert.strictEqual(route.interface.bitrate, 1000000);
  });
});

describe("RoutingTable — path-health state", () => {
  test("a new route starts in the UNKNOWN state", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });

    assert.strictEqual(table.getState(hash), PathState.UNKNOWN);
    assert.strictEqual(table.pathIsUnresponsive(hash), false);
  });

  test("markState flips liveness and pathIsUnresponsive tracks it", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });

    assert.strictEqual(table.markState(hash, PathState.UNRESPONSIVE), true);
    assert.strictEqual(table.pathIsUnresponsive(hash), true);
    assert.strictEqual(table.getState(hash), PathState.UNRESPONSIVE);

    table.markState(hash, PathState.RESPONSIVE);
    assert.strictEqual(table.pathIsUnresponsive(hash), false);

    // markState on an unknown destination is a no-op.
    const other = dest();
    assert.strictEqual(table.markState(other, PathState.RESPONSIVE), false);
    assert.strictEqual(table.getState(other), PathState.UNKNOWN);
  });

  test("replacing a path with a fresh announce resets state to UNKNOWN", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 3,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });
    // Simulate a successful comms → RESPONSIVE, then it goes stale → UNRESPONSIVE.
    table.markState(hash, PathState.UNRESPONSIVE);

    // A shorter path with a newer emission replaces it → state resets.
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(2000),
    });
    assert.strictEqual(table.getState(hash), PathState.UNKNOWN);
  });

  test("the unresponsive-replay gate accepts a repeated blob on a dead path", () => {
    // Transport.py ~l.1887: the same announce (same emission) heard again is
    // normally rejected, but if the stored path is UNRESPONSIVE a longer path
    // carrying the same random_blob is accepted so we can try an alternative.
    const table = new RoutingTable();
    const hash = dest();
    const blob = blobAt(1000);
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blob,
    });
    table.markState(hash, PathState.UNRESPONSIVE);

    const altNext = crypto.getRandomValues(new Uint8Array(16));
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: altNext,
      hops: 4, // longer path, same emission (replay) — normally rejected
      viaInterface: iface,
      randomBlob: blob,
    });

    assert.strictEqual(ok, true);
    assert.ok(bytesEqual(table.getRoute(hash).nextHop, altNext));
    // Python does not call mark_path_unknown_state here, so state is preserved.
    assert.strictEqual(table.getState(hash), PathState.UNRESPONSIVE);
  });

  test("a repeated blob is still rejected when the path is responsive", () => {
    // The unresponsive gate must NOT fire for a healthy path.
    const table = new RoutingTable();
    const hash = dest();
    const blob = blobAt(1000);
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blob,
    });
    table.markState(hash, PathState.RESPONSIVE);

    const ok = table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 4,
      viaInterface: iface,
      randomBlob: blob,
    });
    assert.strictEqual(ok, false);
  });

  test("expireRoute forgets the path immediately", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });

    assert.strictEqual(table.expireRoute(hash), true);
    assert.strictEqual(table.hasRoute(hash), false);
    assert.strictEqual(table.expireRoute(hash), false); // already gone
  });

  test("setHops rewrites a known path's hop count (link rebalance)", () => {
    const table = new RoutingTable();
    const hash = dest();
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 3,
      viaInterface: iface,
      randomBlob: blobAt(1000),
    });

    assert.strictEqual(table.setHops(hash, 5), true);
    assert.strictEqual(table.getRoute(hash).hops, 5);
    // Next hop / interface are left untouched.
    assert.strictEqual(table.setHops(dest(), 1), false); // unknown destination
  });
});

describe("RoutingTable — interface gravity", () => {
  /** @param {number} g @param {string} name */
  const gface = (g, name) =>
    /** @type {any} */ (Object.assign(new EventTarget(), { name, gravity: g }));

  test("a same-emission announce on a higher-gravity interface replaces the path", () => {
    const table = new RoutingTable();
    const hash = dest();
    const blob = blobAt(1000);
    const radio = gface(1, "radio");
    const wired = gface(5, "wired");
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: radio,
      randomBlob: blob,
    });

    const wiredNext = crypto.getRandomValues(new Uint8Array(16));
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: wiredNext,
      hops: 2,
      viaInterface: wired,
      randomBlob: blob, // same emission (replay) on a higher-gravity interface
    });

    assert.strictEqual(ok, true);
    assert.strictEqual(table.getRoute(hash).interface, wired);
    assert.ok(bytesEqual(table.getRoute(hash).nextHop, wiredNext));
  });

  test("equal or lower gravity does not replace a same-emission path", () => {
    const table = new RoutingTable();
    const hash = dest();
    const blob = blobAt(1000);
    const high = gface(5, "high");
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: high,
      randomBlob: blob,
    });
    const origNext = table.getRoute(hash).nextHop;

    // Equal gravity → no replace.
    assert.strictEqual(
      table.addOrUpdateRoute(hash, {
        nextHop: crypto.getRandomValues(new Uint8Array(16)),
        hops: 2,
        viaInterface: gface(5, "eq"),
        randomBlob: blob,
      }),
      false,
    );
    // Lower gravity → no replace.
    assert.strictEqual(
      table.addOrUpdateRoute(hash, {
        nextHop: crypto.getRandomValues(new Uint8Array(16)),
        hops: 2,
        viaInterface: gface(1, "low"),
        randomBlob: blob,
      }),
      false,
    );
    assert.ok(bytesEqual(table.getRoute(hash).nextHop, origNext));
  });

  test("null gravity (the default) never triggers a gravity replacement", () => {
    const table = new RoutingTable();
    const hash = dest();
    const blob = blobAt(1000);
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: gface(null, "a"),
      randomBlob: blob,
    });
    assert.strictEqual(
      table.addOrUpdateRoute(hash, {
        nextHop: crypto.getRandomValues(new Uint8Array(16)),
        hops: 2,
        viaInterface: gface(5, "b"), // even a higher number can't win: other side is null
        randomBlob: blob,
      }),
      false,
    );
  });

  test("a newer emission always wins, regardless of gravity", () => {
    const table = new RoutingTable();
    const hash = dest();
    const high = gface(9, "high");
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: high,
      randomBlob: blobAt(1000),
    });
    // A fresher announce on a *lower*-gravity interface still replaces.
    const lowNext = crypto.getRandomValues(new Uint8Array(16));
    const ok = table.addOrUpdateRoute(hash, {
      nextHop: lowNext,
      hops: 2,
      viaInterface: gface(1, "low"),
      randomBlob: blobAt(5000),
    });
    assert.strictEqual(ok, true);
    assert.ok(bytesEqual(table.getRoute(hash).nextHop, lowNext));
  });

  test("a gravity replacement preserves the existing liveness state", () => {
    const table = new RoutingTable();
    const hash = dest();
    const blob = blobAt(1000);
    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: gface(1, "radio"),
      randomBlob: blob,
    });
    table.markState(hash, PathState.RESPONSIVE);

    table.addOrUpdateRoute(hash, {
      nextHop: crypto.getRandomValues(new Uint8Array(16)),
      hops: 2,
      viaInterface: gface(5, "wired"),
      randomBlob: blob,
    });
    assert.strictEqual(table.getState(hash), PathState.RESPONSIVE);
  });
});
