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
 * Per-destination path liveness state (`Transport.STATE_*`). A path starts
 * {@link PathState.UNKNOWN UNKNOWN} when learned, flips to
 * {@link PathState.RESPONSIVE RESPONSIVE} on a successful proof/link and to
 * {@link PathState.UNRESPONSIVE UNRESPONSIVE} when a proof/link times out.
 * `UNKNOWN` is the default for any destination with no recorded state.
 * @enum {number}
 */
export const PathState = {
  UNKNOWN: 0x00,
  UNRESPONSIVE: 0x01,
  RESPONSIVE: 0x02,
};

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
 * @property {number} state Path liveness ({@link PathState}); defaults to
 *   {@link PathState.UNKNOWN}. Reset to `UNKNOWN` whenever the entry is
 *   replaced by a fresh announce (`Transport.mark_path_unknown_state`).
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

    // §4.5 step 6.3 — replay defense: a random_blob already recorded for this
    // destination is normally rejected. The single exception is the
    // path_is_unresponsive gate below (Transport.py ~l.1887), handled per-branch.
    const isReplay = Boolean(
      existing &&
        randomBlob &&
        existing.randomBlobs.some((b) => bytesEqual(b, randomBlob)),
    );

    let shouldAdd = false;
    /** Set when acceptance is via the unresponsive-replay gate (state preserved). */
    let viaUnresponsiveGate = false;
    if (!existing) {
      shouldAdd = true;
    } else {
      const timebase = timebaseFromBlobs(existing.randomBlobs);
      if (entry.hops <= existing.hops) {
        // Shorter-or-equal path: refresh only on a fresher emission. A replayed
        // blob can never be fresher (same emission ⇒ emitted === timebase), so
        // this also enforces anti-replay for this branch.
        shouldAdd = emitted > timebase;
      } else {
        // Longer path: override only an expired or more-recently-emitted path.
        const now = Date.now();
        if (now >= existing.expires) {
          shouldAdd = !isReplay;
        } else if (emitted > timebase) {
          shouldAdd = true;
        } else if (
          emitted === timebase &&
          existing.state === PathState.UNRESPONSIVE
        ) {
          // §7 path_is_unresponsive gate: the same announce heard again, but
          // the stored path was marked unresponsive — accept it (likely via a
          // different next hop / interface) so we try an alternative instead of
          // trusting a known-dead path. Python does not call
          // mark_path_unknown_state here, so the state is preserved.
          shouldAdd = true;
          viaUnresponsiveGate = true;
        }
      }
    }

    if (!shouldAdd) return false;

    const randomBlobs = existing ? existing.randomBlobs.slice() : [];
    // Don't re-record a replayed blob (the unresponsive-gate case); it's
    // already there.
    if (randomBlob && !isReplay) {
      randomBlobs.push(randomBlob.slice());
      while (randomBlobs.length > MAX_RANDOM_BLOBS) randomBlobs.shift();
    }

    // A path replaced by a fresh announce is "unknown" until proven again
    // (Transport.mark_path_unknown_state). The unresponsive-gate exception
    // keeps the existing state, matching Python.
    const state =
      existing && viaUnresponsiveGate ? existing.state : PathState.UNKNOWN;

    this.routes.set(destKey, {
      interface: entry.viaInterface,
      nextHop: entry.nextHop,
      hops: entry.hops,
      timestamp: Date.now(),
      expires,
      randomBlobs,
      state,
    });
    return true;
  }

  /**
   * Sets the liveness state of a known path (`Transport.mark_path_*`).
   * @param {Uint8Array} destinationHash
   * @param {number} state A {@link PathState}.
   * @returns {boolean} `true` if a route was updated.
   */
  markState(destinationHash, state) {
    const route = this.routes.get(toHex(destinationHash));
    if (!route) return false;
    route.state = state;
    return true;
  }

  /**
   * The liveness state of a path, defaulting to {@link PathState.UNKNOWN}.
   * @param {Uint8Array} destinationHash
   * @returns {number}
   */
  getState(destinationHash) {
    return this.routes.get(toHex(destinationHash))?.state ?? PathState.UNKNOWN;
  }

  /**
   * Whether the path was marked unresponsive by a failed proof/link attempt
   * (`Transport.path_is_unresponsive`).
   * @param {Uint8Array} destinationHash
   * @returns {boolean}
   */
  pathIsUnresponsive(destinationHash) {
    return this.getState(destinationHash) === PathState.UNRESPONSIVE;
  }

  /**
   * Forgets a path immediately (`Transport.expire_path`). Python marks the
   * entry for lazy culling; with no transport-node cull job we delete outright
   * so `hasPath` reflects the expiry at once.
   * @param {Uint8Array} destinationHash
   * @returns {boolean} `true` if a route was removed.
   */
  expireRoute(destinationHash) {
    return this.routes.delete(toHex(destinationHash));
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
