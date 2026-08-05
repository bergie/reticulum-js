import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";

/**
 * One week in ms — the path-liveness horizon (Transport.PATHFINDER_E ==
 * Transport.DESTINATION_TIMEOUT). It serves two distinct purposes, mirroring
 * the Python reference:
 *   - **Cull**: a route is dropped when it has been *unused* for this long
 *     (`IDX_PT_TIMESTAMP + DESTINATION_TIMEOUT`); the timestamp is refreshed on
 *     every outbound send, so a path in active use never times out.
 *   - **Ingestion `expires`**: set once when an announce is learned
 *     (`now + PATHFINDER_E`, the `IDX_PT_EXPIRES` slot) and used *only* for the
 *     longer-hop replacement decision — never for culling.
 * Interface-mode-specific expiries (Access Point / Roaming) are a
 * transport-instance concern and not yet modelled here.
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
 *   without a receiving interface (e.g. local-client synthesis), and for routes
 *   hydrated from storage until {@link RoutingTable#getRoute} lazily
 *   re-associates it via {@link Route#interfaceName}.
 * @property {string|null} interfaceName Persisted name of the learning
 *   interface, used to lazily re-associate the live {@link interface} reference
 *   after a restart (the object itself can't be serialised). `null` when the
 *   route was learned without an interface.
 * @property {Uint8Array} nextHop The 16-byte address of the next transport hop.
 *   This is the announcing transport node's `transport_id` (read from a HEADER_2
 *   announce) for a multi-hop path, or the destination hash itself when the
 *   announce arrived directly (HEADER_1, 1 hop). Placed into HEADER_2 on send.
 * @property {number} hops Distance to the destination.
 * @property {number} timestamp ms epoch of the last route *use* (outbound
 *   send). The cull drops a route once `timestamp + PATH_EXPIRY_MS` is in the
 *   past (Python `IDX_PT_TIMESTAMP + DESTINATION_TIMEOUT`); refreshed on every
 *   send so an active path never times out.
 * @property {number} expires ms epoch set once at announce ingestion
 *   (`now + PATH_EXPIRY_MS`, Python `IDX_PT_EXPIRES`). Used *only* for the
 *   longer-hop replacement decision — **not** for culling.
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
    /**
     * Resolves a persisted interface name back to a live Interface, so routes
     * hydrated from storage (whose `interface` is `null`) can re-associate the
     * correct outbound medium on first access. Set by {@link import("../transport.js").TransportCore};
     * `null` for a standalone/test table (routes then fall back to the default
     * interface at send time).
     * @type {((name: string) => import("../interfaces/base.js").Interface|null)|null}
     */
    this.interfaceResolver = null;
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
   *   Stored as the ingestion `expires` (Python `IDX_PT_EXPIRES`); used only for
   *   the longer-hop replacement decision, never for culling.
   * @param {number} [entry.timestamp] ms epoch of last use; defaults to now.
   *   The cull basis (Python `IDX_PT_TIMESTAMP`). Overridden by the persistor
   *   on hydration to restore the real last-used time.
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
    /** Set when acceptance keeps the existing liveness state (unresponsive-gate / gravity switch). */
    let preserveState = false;
    if (!existing) {
      shouldAdd = true;
    } else {
      const timebase = timebaseFromBlobs(existing.randomBlobs);
      if (entry.hops <= existing.hops) {
        if (emitted > timebase) {
          // Shorter-or-equal path with a fresher emission. A replayed blob can
          // never be fresher (same emission ⇒ emitted === timebase), so this
          // also enforces anti-replay for this branch.
          shouldAdd = true;
        } else if (emitted === timebase) {
          // §gravity tie-break (Transport.py ~l.1836-1844): the *same* announce
          // heard on a higher-gravity interface replaces the path so traffic
          // egresses via the preferred interface. With default gravity
          // (null/0) everywhere this is a no-op. Python doesn't call
          // mark_path_unknown_state here, so the liveness state is preserved.
          const currentGravity = existing.interface?.gravity ?? null;
          const announceGravity = entry.viaInterface?.gravity ?? null;
          if (
            currentGravity !== null &&
            announceGravity !== null &&
            announceGravity > currentGravity
          ) {
            shouldAdd = true;
            preserveState = true;
          }
        }
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
          // a different next hop / interface) so we try an alternative instead
          // of trusting a known-dead path. Python does not call
          // mark_path_unknown_state here, so the state is preserved.
          shouldAdd = true;
          preserveState = true;
        }
      }
    }

    if (!shouldAdd) return false;

    const randomBlobs = existing ? existing.randomBlobs.slice() : [];
    // Don't re-record a replayed blob (the unresponsive-gate / gravity-same-
    // announce cases); it's already there.
    if (randomBlob && !isReplay) {
      randomBlobs.push(randomBlob.slice());
      while (randomBlobs.length > MAX_RANDOM_BLOBS) randomBlobs.shift();
    }

    // A path replaced by a fresh announce is "unknown" until proven again
    // (Transport.mark_path_unknown_state). The unresponsive-gate and
    // gravity-switch exceptions keep the existing state, matching Python.
    const state =
      existing && preserveState ? existing.state : PathState.UNKNOWN;

    this.routes.set(destKey, {
      interface: entry.viaInterface,
      interfaceName: entry.viaInterface?.name ?? null,
      nextHop: entry.nextHop,
      hops: entry.hops,
      timestamp: entry.timestamp ?? Date.now(),
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
   * Rewrites the hop count of a known path (`Transport.py` link path-rebalance
   * at the terminus: `path_entry[IDX_PT_HOPS] = packet.hops`). Leaves the
   * next hop / interface / state untouched — only corrects the distance
   * estimate after a link handshake reveals the real path length.
   * @param {Uint8Array} destinationHash
   * @param {number} hops
   * @returns {boolean} `true` if a route was updated.
   */
  setHops(destinationHash, hops) {
    const route = this.routes.get(toHex(destinationHash));
    if (!route) return false;
    route.hops = hops;
    return true;
  }

  /**
   * Looks up the best-known route for a destination hash.
   *
   * Two lazy behaviours, both evaluated on access (a leaf has no periodic
   * tables-cull job, unlike Python's `Transport.jobs`):
   *   - **Cull on last-used**: drops the route once it has been *unused* for
   *     {@link PATH_EXPIRY_MS} (`route.timestamp + PATH_EXPIRY_MS`, mirroring
   *     `IDX_PT_TIMESTAMP + DESTINATION_TIMEOUT`). The frozen ingestion
   *     `expires` is intentionally **not** used here — it is for the
   *     longer-hop replacement decision only, and a path in active use must not
   *     be culled just because its announce is old.
   *   - **Interface re-association**: a route hydrated from storage has
   *     `interface: null`; resolve the live reference by name (via
   *     {@link RoutingTable#interfaceResolver}) so egress and bitrate-adaptive
   *     timeouts use the correct medium.
   *
   * @param {Uint8Array} destinationHash
   * @returns {Route|undefined}
   */
  getRoute(destinationHash) {
    const destKey = toHex(destinationHash);
    const route = this.routes.get(destKey);
    if (!route) return undefined;
    if (Date.now() >= route.timestamp + PATH_EXPIRY_MS) {
      this.routes.delete(destKey);
      log("Router", `Expired route to ${destKey}`, LogLevel.DEBUG);
      return undefined;
    }
    if (!route.interface && route.interfaceName && this.interfaceResolver) {
      const iface = this.interfaceResolver(route.interfaceName);
      if (iface) {
        route.interface = iface;
        log(
          "Router",
          `Re-associated path to ${destKey} via interface ${route.interfaceName}`,
          LogLevel.DEBUG,
        );
      }
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
