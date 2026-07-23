/**
 * @file storage.js
 * @description Platform-neutral persistence contract for @reticulum/core
 *   (work doc #16).
 *
 * A single async key/value interface, backend-agnostic. The user supplies the
 * backend (file-on-disk for Node via `@reticulum/node`, IndexedDB for the
 * browser, or {@link MemoryStorageAdapter} for tests / ephemeral nodes); the
 * core layer owns msgpack (de)serialization of the values, which are always
 * opaque `Uint8Array`.
 *
 * The KV shape (`get/set/delete/keys`, namespaced by string) is already
 * consumed by `InterfaceDiscovery` (`src/transport/discovery.js`); this module
 * formalizes the typedef and ships a reference in-memory backend. The local
 * Identity's private key keeps the legacy single-blob `loadKey`/`saveKey` pair
 * (consumed by `Identity.loadOrGenerate`); the namespaced KV is used for
 * learned peers, ratchet rings and path entries.
 */

/**
 * Platform-neutral async key/value persistence. Values are opaque bytes; the
 * core layer owns (de)serialization (msgpack).
 *
 * Backends:
 *  - {@link MemoryStorageAdapter} — in-memory, for tests and ephemeral nodes.
 *  - `FileStorageAdapter` (`@reticulum/node`) — one file per record on disk.
 *  - `IndexedDBStorageAdapter` (browser, user-supplied) — one object store per
 *    namespace.
 *
 * @typedef {Object} StorageAdapter
 * @property {() => Promise<Uint8Array|null>} loadKey Loads the local
 *   Identity's private-key blob (128 bytes), or null when absent.
 * @property {(bytes: Uint8Array) => Promise<void>} saveKey Persists the local
 *   Identity's private-key blob.
 * @property {(namespace: string, key: string) => Promise<Uint8Array|null>} get
 *   Reads one record, or null when absent.
 * @property {(namespace: string, key: string, value: Uint8Array) => Promise<void>} set
 *   Writes (overwrites) one record.
 * @property {(namespace: string, key: string) => Promise<void>} delete
 *   Removes one record. No-op when the record is absent.
 * @property {(namespace: string) => Promise<string[]>} keys Lists the record
 *   keys present in a namespace.
 */

/**
 * Record namespaces used by the core persistence layer (work doc #16).
 *
 *  - `identities` — learned peer identities (`Destination.knownDestinations`
 *    entries; `[time, packet_hash, public_key, app_data, 0]`, Python-compatible).
 *  - `ratchets` — per-destination ratchet rings (arrays of X25519 pubs).
 *  - `paths` — transport path-table entries (next-hop routes).
 *
 * @enum {string}
 */
export const StorageNamespace = {
  IDENTITIES: "identities",
  RATCHETS: "ratchets",
  PATHS: "paths",
};

/**
 * Reference in-memory `StorageAdapter`. Records are kept in nested Maps keyed
 * by `namespace → key`. Useful for tests, ephemeral nodes, and as the behaviour
 * spec for real backends.
 *
 * Reads return a fresh copy (matching file/IndexedDB backends, which never hand
 * out their internal buffer), so callers cannot corrupt the store by mutating a
 * returned value.
 */
export class MemoryStorageAdapter {
  constructor() {
    /** @type {Map<string, Map<string, Uint8Array>>} */
    this._stores = new Map();
    /** @type {Uint8Array|null} */
    this._key = null;
  }

  /**
   * @param {string} namespace
   * @returns {Map<string, Uint8Array>}
   * @private
   */
  _ns(namespace) {
    let m = this._stores.get(namespace);
    if (!m) {
      m = new Map();
      this._stores.set(namespace, m);
    }
    return m;
  }

  async loadKey() {
    return this._key ? this._key.slice() : null;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async saveKey(bytes) {
    this._key = bytes.slice();
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @returns {Promise<Uint8Array|null>}
   */
  async get(namespace, key) {
    const v = this._stores.get(namespace)?.get(key);
    return v ? v.slice() : null;
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @param {Uint8Array} value
   * @returns {Promise<void>}
   */
  async set(namespace, key, value) {
    this._ns(namespace).set(key, value.slice());
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(namespace, key) {
    this._ns(namespace).delete(key);
  }

  /**
   * @param {string} namespace
   * @returns {Promise<string[]>}
   */
  async keys(namespace) {
    return Array.from(this._ns(namespace).keys());
  }
}
