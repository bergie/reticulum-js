/**
 * @file persistor.js
 * @description Selective persistence coordinator (work doc #16).
 *
 * Owns the *policy* for what gets persisted across restarts: only destinations
 * we have actually communicated with ({@link Persistor#markContacted}) or
 * explicitly favorited ({@link Persistor#store}) are written. The in-memory
 * `knownDestinations` / `knownRatchets` / routing table are left untouched
 * (they cache everything heard, which routing still needs); persistence is
 * purely additive and selective.
 *
 * Values are msgpack-encoded `Uint8Array`; the {@link StorageAdapter} backend
 * stores them opaquely. The `known_destinations` tuple layout matches Python
 * (`[time, packet_hash, public_key, app_data, 0]`, `RNS/Identity.py:107`) so a
 * persisted blob is interchangeable.
 */

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { MicroMsgPack } from "../utils/msgpack.js";
import { StorageNamespace } from "./storage.js";

/**
 * Coerces a msgpack-decoded value back to a pristine Uint8Array copy.
 * @param {any} v
 * @returns {Uint8Array}
 */
function toU8(v) {
  return v instanceof Uint8Array ? v : new Uint8Array(v ?? []);
}

// --- (de)serializers: core owns msgpack; the adapter stores opaque bytes ------

/**
 * Encodes a `knownDestinations` entry `[time, packetHash, publicKey, appData, flag]`.
 * @param {any[]} entry
 * @returns {Uint8Array}
 */
function encodeIdentityEntry(entry) {
  return MicroMsgPack.encode([
    entry[0],
    toU8(entry[1]),
    toU8(entry[2]),
    entry[3] ? toU8(entry[3]) : null,
    entry[4] ?? 0,
  ]);
}

/**
 * @param {Uint8Array} bytes
 * @returns {any[]} `[time, packetHash, publicKey, appData|null, flag]`
 * @throws when the bytes do not decode to a 5-tuple (so {@link Persistor#load}
 *   can skip corrupt records).
 */
function decodeIdentityEntry(bytes) {
  const e = MicroMsgPack.decode(bytes);
  if (!Array.isArray(e) || e.length < 4)
    throw new Error("identity entry is not a tuple");
  return [e[0], toU8(e[1]), toU8(e[2]), e[3] ? toU8(e[3]) : null, e[4] ?? 0];
}

/**
 * @param {Uint8Array[]} ring
 * @returns {Uint8Array}
 */
function encodeRatchetRing(ring) {
  return MicroMsgPack.encode(ring.map(toU8));
}

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array[]}
 */
function decodeRatchetRing(bytes) {
  const arr = MicroMsgPack.decode(bytes);
  return Array.isArray(arr) ? arr.map(toU8) : [];
}

/**
 * The serializable fields of a routing-table entry. The live `interface`
 * reference is not serializable and is dropped on encode.
 *
 * @typedef {Object} PersistableRoute
 * @property {Uint8Array} nextHop
 * @property {number} hops
 * @property {number} timestamp
 * @property {number} expires
 * @property {Uint8Array[]} [randomBlobs]
 */

/**
 * @param {PersistableRoute} route
 * @returns {Uint8Array}
 */
function encodeRoute(route) {
  return MicroMsgPack.encode([
    toU8(route.nextHop),
    route.hops,
    route.timestamp,
    route.expires,
    (route.randomBlobs ?? []).map(toU8),
  ]);
}

/**
 * @param {Uint8Array} bytes
 * @returns {PersistableRoute & { interface: null }} route with `interface: null`
 *   — the live Interface reference is re-associated when a fresh announce
 *   refreshes the destination's path.
 * @throws when the bytes do not decode to a tuple.
 */
function decodeRoute(bytes) {
  const e = MicroMsgPack.decode(bytes);
  if (!Array.isArray(e) || e.length < 4)
    throw new Error("path entry is not a tuple");
  return {
    interface: null,
    nextHop: toU8(e[0]),
    hops: e[1],
    timestamp: e[2],
    expires: e[3],
    randomBlobs: Array.isArray(e[4]) ? e[4].map(toU8) : [],
  };
}

/**
 * A parsed announce, sufficient to persist a peer out-of-band.
 *
 * Accepts a transport `announce` event's `detail` object directly (the shape
 * dispatched by `TransportCore._handleAnnounce`).
 *
 * @typedef {Object} StorableAnnounce
 * @property {Uint8Array} [destinationHash] Destination hash; overrides the
 *   positional argument to {@link Persistor#store} when present.
 * @property {Identity} identity Identity carrying the public key to persist.
 * @property {Uint8Array|null} [appData] App-specific metadata from the announce.
 * @property {Uint8Array|null} [ratchet] 32-byte ratchet X25519 pub, if present.
 * @property {Uint8Array} [packetHash] Announce packet hash; derived from
 *   `packet` when absent, else the public-key hash.
 * @property {{ getHash(): Promise<Uint8Array> }} [packet] The announce Packet.
 */

/**
 * @typedef {Object} PersistorOptions
 * @property {import("./storage.js").StorageAdapter|null} [adapter] Backend, or
 *   null to disable persistence (all methods become no-ops).
 * @property {Map<string, any[]>} [knownDestinations] Defaults to
 *   `Destination.knownDestinations`.
 * @property {Map<string, Uint8Array[]>} [knownRatchets] Defaults to
 *   `Destination.knownRatchets`.
 * @property {{ routes: Map<string, any> }} [routingTable] Transport path table;
 *   its `routes` map is read/written directly.
 * @property {number} [debounceMs] Coalesce window for writes triggered by
 *   {@link Persistor#markContacted}. Defaults to 3000; `<= 0` disables
 *   auto-flush (the caller drives {@link Persistor#flush}).
 */

/**
 * Coordinates selective persistence of learned peers, ratchet rings and path
 * entries across restarts.
 */
export class Persistor {
  /**
   * @param {PersistorOptions} [options]
   */
  constructor({
    adapter,
    knownDestinations,
    knownRatchets,
    routingTable,
    debounceMs = 3000,
  } = {}) {
    this.adapter = adapter ?? null;
    this.knownDestinations = knownDestinations ?? Destination.knownDestinations;
    this.knownRatchets = knownRatchets ?? Destination.knownRatchets;
    this.routingTable = routingTable ?? null;
    this.debounceMs = debounceMs;
    /**
     * Hex destination hashes slated for persistence — communicated-with OR
     * explicitly favorited.
     * @type {Set<string>}
     */
    this.persistedDestinations = new Set();
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._flushTimer = null;
  }

  /**
   * Returns the adapter only when it implements the full KV interface (#16),
   * else null. Used to narrow `this.adapter` (which may be null or a
   * legacy identity-only adapter) for the type checker.
   * @returns {import("./storage.js").StorageAdapter|null}
   * @private
   */
  _kvAdapter() {
    const a = this.adapter;
    if (
      a &&
      typeof a.get === "function" &&
      typeof a.set === "function" &&
      typeof a.delete === "function" &&
      typeof a.keys === "function"
    ) {
      return a;
    }
    return null;
  }

  /** True when a backend exposing the KV interface is configured. */
  get enabled() {
    return this._kvAdapter() !== null;
  }

  /**
   * Coerces a destination hash (bytes or hex) to its hex string key.
   * @param {Uint8Array|string} destinationHash
   * @returns {string}
   * @private
   */
  _hex(destinationHash) {
    return typeof destinationHash === "string"
      ? destinationHash
      : toHex(destinationHash);
  }

  /**
   * Marks a destination as communicated-with and schedules a debounced flush.
   * Called by the transport layer at real send/receive points.
   * @param {Uint8Array|string} destinationHash
   * @returns {void}
   */
  markContacted(destinationHash) {
    if (!this.enabled) return;
    const hex = this._hex(destinationHash);
    if (!this.persistedDestinations.has(hex)) {
      this.persistedDestinations.add(hex);
      log(
        "Persistor",
        `Scheduling persistence for contacted destination ${hex}`,
        LogLevel.DEBUG,
      );
    }
    this._scheduleFlush();
  }

  /**
   * Explicitly persists a destination (e.g. a favorited contact), regardless of
   * whether we have communicated with it.
   *
   * If the destination has already been learned from a heard announce, its
   * current identity/ratchet/path state is written immediately. To persist a
   * peer that has not been learned yet — or to refresh from a specific announce
   * — pass `announce`; it accepts a transport `announce` event's `detail`
   * object directly (see {@link StorableAnnounce}).
   *
   * Flushes immediately so the favorite survives an ungraceful crash.
   * @param {Uint8Array|string} destinationHash
   * @param {{ announce?: StorableAnnounce }} [options]
   * @returns {Promise<void>}
   */
  async store(destinationHash, { announce } = {}) {
    if (!this.enabled) return;
    const hex = this._hex(destinationHash);
    if (announce) {
      await this._ingestAnnounce(hex, announce);
    }
    this.persistedDestinations.add(hex);
    await this.flush();
  }

  /**
   * Writes an announce's identity/app_data/ratchet into the in-memory maps (the
   * injected ones, so tests stay isolated) so the next flush persists them.
   * Mirrors `TransportCore._handleAnnounce` step 6 for the client-driven path.
   * @param {string} hex
   * @param {StorableAnnounce} announce
   * @returns {Promise<void>}
   * @private
   */
  async _ingestAnnounce(hex, announce) {
    const publicKey = announce.identity?.publicKey;
    if (!publicKey) return;
    let packetHash = announce.packetHash;
    if (
      !packetHash &&
      announce.packet &&
      typeof announce.packet.getHash === "function"
    ) {
      packetHash = await announce.packet.getHash();
    }
    if (!packetHash) {
      packetHash = await Identity.fullHash(publicKey);
    }
    const appData = announce.appData ?? announce.identity?.appData ?? null;
    this.knownDestinations.set(hex, [
      Date.now() / 1000,
      toU8(packetHash),
      toU8(publicKey),
      appData ? toU8(appData) : null,
      0,
    ]);
    if (announce.ratchet && announce.ratchet.length > 0) {
      const ring = this.knownRatchets.get(hex) ?? [];
      const copy = toU8(announce.ratchet);
      if (!ring.some((r) => bytesEqual(r, copy))) {
        ring.unshift(copy);
        this.knownRatchets.set(hex, ring);
      }
    }
  }

  /**
   * Schedules a debounced flush. No-op when auto-flush is disabled.
   * @returns {void}
   * @private
   */
  _scheduleFlush() {
    if (this.debounceMs <= 0) return;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch((e) =>
        log("Persistor", `Debounced flush failed: ${e}`, LogLevel.WARNING),
      );
    }, this.debounceMs);
  }

  /**
   * Writes every persisted destination's identity, ratchet ring and path entry
   * to the adapter now, cancelling any pending debounced flush. No-op when
   * disabled.
   * @returns {Promise<void>}
   */
  async flush() {
    const adapter = this._kvAdapter();
    if (!adapter) return;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    let written = 0;
    for (const hex of this.persistedDestinations) {
      const entry = this.knownDestinations.get(hex);
      if (entry) {
        await adapter.set(
          StorageNamespace.IDENTITIES,
          hex,
          encodeIdentityEntry(entry),
        );
        written++;
      }
      const ring = this.knownRatchets.get(hex);
      if (ring) {
        await adapter.set(
          StorageNamespace.RATCHETS,
          hex,
          encodeRatchetRing(ring),
        );
      }
      if (this.routingTable) {
        const route = this.routingTable.routes.get(hex);
        if (route) {
          await adapter.set(StorageNamespace.PATHS, hex, encodeRoute(route));
        }
      }
    }
    if (written > 0) {
      log(
        "Persistor",
        `Flushed ${written} contacted/favorited destination(s) to storage.`,
        LogLevel.DEBUG,
      );
    }
  }

  /**
   * Hydrates the in-memory maps from the adapter and rebuilds the persisted
   * set. Call once at startup. Corrupt records are skipped with a warning.
   * @returns {Promise<void>}
   */
  async load() {
    const adapter = this._kvAdapter();
    if (!adapter) return;
    await this._loadNamespace(
      adapter,
      StorageNamespace.IDENTITIES,
      this.knownDestinations,
      decodeIdentityEntry,
    );
    await this._loadNamespace(
      adapter,
      StorageNamespace.RATCHETS,
      this.knownRatchets,
      decodeRatchetRing,
    );
    if (this.routingTable) {
      await this._loadNamespace(
        adapter,
        StorageNamespace.PATHS,
        this.routingTable.routes,
        decodeRoute,
      );
    }
    log(
      "Persistor",
      `Loaded ${this.persistedDestinations.size} persisted destination(s).`,
      LogLevel.DEBUG,
    );
  }

  /**
   * Loads one namespace into a map, registering each key as persisted.
   * @param {import("./storage.js").StorageAdapter} adapter
   * @param {string} namespace
   * @param {Map<string, any>} into
   * @param {(bytes: Uint8Array) => any} decode
   * @returns {Promise<void>}
   * @private
   */
  async _loadNamespace(adapter, namespace, into, decode) {
    const keys = await adapter.keys(namespace);
    for (const key of keys) {
      const bytes = await adapter.get(namespace, key);
      if (!bytes) continue;
      try {
        into.set(key, decode(bytes));
        this.persistedDestinations.add(key);
      } catch (e) {
        log(
          "Persistor",
          `Skipping corrupt ${namespace} record ${key}: ${e}`,
          LogLevel.WARNING,
        );
      }
    }
  }
}
