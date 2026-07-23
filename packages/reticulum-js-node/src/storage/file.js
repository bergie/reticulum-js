/**
 * @file file.js
 * @description Node.js reference {@link FileStorageAdapter} — a
 *   `StorageAdapter` (reticulum-js, work doc #16) backed by the local
 *   filesystem.
 *
 * On-disk layout under the configured `directory`:
 *
 *   <dir>/identity.key            — local Identity private-key blob (loadKey/saveKey)
 *   <dir>/<namespace>/<key>.bin   — one file per namespaced record (get/set/delete/keys)
 *
 * Records are written verbatim as opaque bytes; the core layer owns msgpack
 * (de)serialization. Keys are hex destination hashes and namespaces are fixed
 * strings (`identities`, `ratchets`, `paths`, …), so both are filesystem-safe;
 * a guard still rejects path separators / parent traversal just in case.
 *
 * Uses `node:fs/promises` so writes never block the event loop. Read methods
 * return `null`/`[]` for absent records (ENOENT) instead of throwing.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reference filesystem `StorageAdapter` for Node.js.
 *
 * @example
 * import { FileStorageAdapter } from "reticulum-js-node";
 * const rns = new Reticulum({ storageAdapter: new FileStorageAdapter("./data") });
 */
export class FileStorageAdapter {
  /**
   * @param {string} directory Directory holding `identity.key` and per-namespace
   *   subdirectories. Created on first write.
   */
  constructor(directory) {
    this.directory = directory;
  }

  /** @returns {string} */
  _keyPath() {
    return join(this.directory, "identity.key");
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @returns {string}
   * @private
   */
  _recordPath(namespace, key) {
    _assertSafe(namespace, "namespace");
    _assertSafe(key, "key");
    return join(this.directory, namespace, `${key}.bin`);
  }

  /**
   * @returns {Promise<Uint8Array|null>}
   */
  async loadKey() {
    try {
      return new Uint8Array(await readFile(this._keyPath()));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async saveKey(bytes) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this._keyPath(), bytes);
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @returns {Promise<Uint8Array|null>}
   */
  async get(namespace, key) {
    try {
      return new Uint8Array(await readFile(this._recordPath(namespace, key)));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @param {Uint8Array} value
   * @returns {Promise<void>}
   */
  async set(namespace, key, value) {
    await mkdir(join(this.directory, namespace), { recursive: true });
    await writeFile(this._recordPath(namespace, key), value);
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(namespace, key) {
    try {
      await unlink(this._recordPath(namespace, key));
    } catch (e) {
      if (isNotFound(e)) return; // idempotent
      throw e;
    }
  }

  /**
   * @param {string} namespace
   * @returns {Promise<string[]>}
   */
  async keys(namespace) {
    _assertSafe(namespace, "namespace");
    const dir = join(this.directory, namespace);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".bin")).map((f) => f.slice(0, -4));
  }
}

/**
 * True for a "no such file or directory" error.
 * @param {any} e
 * @returns {boolean}
 */
function isNotFound(e) {
  return !!e && e.code === "ENOENT";
}

/**
 * Rejects path separators and parent-traversal segments so a caller-supplied
 * namespace/key can't escape its directory.
 * @param {string} name
 * @param {string} label
 */
function _assertSafe(name, label) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0")
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(name)}`);
  }
}
