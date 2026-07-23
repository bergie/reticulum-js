import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";

/**
 * Default path expiration: one week (Transport.PATHFINDER_E). A full-transport
 * path learned from a regular announce is kept for a week unless refreshed by a
 * newer announce. Interface-mode-specific expiries (Access Point / Roaming) are
 * a transport-instance concern and not yet modelled here.
 */
const PATH_EXPIRY_MS = 60 * 60 * 24 * 7 * 1000;

/** Maximum announce `random_blob`s remembered per destination (Transport.MAX_RANDOM_BLOBS). */
const MAX_RANDOM_BLOBS = 64;

/**
 * @typedef {Object} Route
 * @property {import("../interfaces/base.js").Interface|null} interface The
 *   interface the destination was announced through — i.e. the outbound
 *   interface to use to reach the next hop. `null` for announces injected
 *   without a receiving interface (e.g. local-client synthesis).
 * @property {Uint8Array} nextHop The 16-byte address of the next transport hop.
 *   This is the announcing transport node's `transport_id` (read from a HEADER_2
 *   announce) for a multi-hop path, or the destination hash itself when the
 *   announce arrived directly (HEADER_1, 1 hop). Placed into HEADER_2 on send.
 * @property {number} hops Distance to the destination.
 * @property {number} timestamp ms epoch of the last route touch (send/receive).
 * @property {number} expires ms epoch after which the route is lazily culled.
 * @property {Uint8Array[]} randomBlobs Recorded announce `random_hash`es, used
 *   for replay defense and path-table replacement ordering (§4.5 step 6.3).
 */

/**
 * Reads the uint40 emission timestamp embedded in a 10-byte announce
 * `random_blob` (§4.1): bytes [5:10], big-endian Unix seconds.
 *
 * @param {Uint8Array} randomBlob
 * @returns {number} seconds, or 0 if the blob is malformed/too short.
 */
function emissionTime(randomBlob) {
  if (!randomBlob || randomBlob.length < 10) return 0;
  let t = 0;
  for (let i = 5; i < 10; i++) t = t * 256 + randomBlob[i];
  return t;
}

/**
 * The path-table replacement timebase (Transport.timebase_from_random_blobs):
 * the most recent emission timestamp across all recorded `random_blob`s.
 *
 * @param {Uint8Array[]} blobs
 * @returns {number}
 */
function timebaseFromBlobs(blobs) {
  let t = 0;
  for (const b of blobs) {
    const e = emissionTime(b);
    if (e > t) t = e;
  }
  return t;
}

/**
 * Maintains the table of learned paths to remote destinations.
 *
 * Each entry maps a destination hash (hex) to the next hop, the interface it was
 * learned through, the announced hop count, an expiry and the recorded announce
 * `random_blob`s. Acceptance follows the Python reference (Transport.py inbound
 * announce handling): shortest path wins, ties go to the more recently emitted
 * announce, and a seen `random_blob` is never accepted twice (anti-replay /
 * anti-loop).
 */
export class RoutingTable {
  constructor() {
    /** @type {Map<string, Route>} */
    this.routes = new Map();
  }

  /**
   * Ingests a validated announce into the path table.
   *
   * Acceptance rules (Transport.py ~1759–1830):
   *   - a `random_blob` already recorded for this destination is always rejected;
   *   - unknown destination → add;
   *   - `hops <= existing.hops` → add only if emitted more recently than the
   *     stored timebase (shorter-or-equal path that is also newer wins);
   *   - `hops > existing.hops` → add only if the stored path has expired, or the
   *     new announce was emitted more recently than the stored one.
   *
   * @param {Uint8Array} destinationHash
   * @param {Object} entry
   * @param {Uint8Array} entry.nextHop
   * @param {number} entry.hops
   * @param {import("../interfaces/base.js").Interface|null} entry.viaInterface
   * @param {Uint8Array} entry.randomBlob 10-byte announce `random_hash`.
   * @param {number} [entry.expires] ms epoch; defaults to now + PATH_EXPIRY_MS.
   * @returns {boolean} `true` if the route was added or replaced.
   */
  addOrUpdateRoute(destinationHash, entry) {
    const destKey = toHex(destinationHash);
    const existing = this.routes.get(destKey);
    const { randomBlob } = entry;
    const emitted = emissionTime(randomBlob);
    const expires = entry.expires ?? Date.now() + PATH_EXPIRY_MS;

    // §4.5 step 6.3 — replay defense: never accept an announce whose
    // random_blob we have already recorded for this destination.
    if (existing && randomBlob) {
      if (existing.randomBlobs.some((b) => bytesEqual(b, randomBlob))) {
        return false;
      }
    }

    let shouldAdd;
    if (!existing) {
      shouldAdd = true;
    } else if (entry.hops <= existing.hops) {
      shouldAdd = emitted > timebaseFromBlobs(existing.randomBlobs);
    } else {
      // Longer path: only override an expired or more-recently-emitted path.
      const now = Date.now();
      shouldAdd =
        now >= existing.expires ||
        emitted > timebaseFromBlobs(existing.randomBlobs);
    }

    if (!shouldAdd) return false;

    const randomBlobs = existing ? existing.randomBlobs.slice() : [];
    if (randomBlob) {
      randomBlobs.push(randomBlob.slice());
      while (randomBlobs.length > MAX_RANDOM_BLOBS) randomBlobs.shift();
    }

    this.routes.set(destKey, {
      interface: entry.viaInterface,
      nextHop: entry.nextHop,
      hops: entry.hops,
      timestamp: Date.now(),
      expires,
      randomBlobs,
    });
    return true;
  }

  /**
   * Looks up the best-known route for a destination hash, lazily expiring stale
   * entries (Transport.py tables-cull job, but evaluated on access for a leaf).
   *
   * @param {Uint8Array} destinationHash
   * @returns {Route|undefined}
   */
  getRoute(destinationHash) {
    const destKey = toHex(destinationHash);
    const route = this.routes.get(destKey);
    if (route && Date.now() >= route.expires) {
      this.routes.delete(destKey);
      log("Router", `Expired route to ${destKey}`, LogLevel.DEBUG);
      return undefined;
    }
    return route;
  }

  /**
   * @param {Uint8Array} destinationHash
   * @returns {boolean}
   */
  hasRoute(destinationHash) {
    return this.getRoute(destinationHash) !== undefined;
  }

  /**
   * Called when a physical interface disconnects: drops every route learned
   * through it so subsequent sends seek an alternative path (failover).
   *
   * @param {import("../interfaces/base.js").Interface} failedInterface
   */
  dropInterface(failedInterface) {
    let droppedCount = 0;
    for (const [destKey, route] of this.routes.entries()) {
      if (route.interface === failedInterface) {
        this.routes.delete(destKey);
        droppedCount++;
      }
    }
    log("Router", `Dropped ${droppedCount} routes due to interface failure.`);
  }
}
