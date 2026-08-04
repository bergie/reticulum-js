/**
 * @file lxmf.js
 * @description Node.js filesystem persistence for the LXMF propagation-node
 *   message store (work doc #27).
 *
 * On-disk layout under the configured `directory`:
 *
 *   <dir>/propagation_messages.rmp   — msgpack of {@link MessageStore} records
 *
 * The core {@link MessageStore} exposes `exportRecords()`/`importRecords()`
 * serialization seams; this module owns the on-disk layout and (de)serialization
 * timing. Records are msgpack-encoded via `@reticulum/core`'s `MsgPack` so the
 * core layer stays free of `node:` imports.
 *
 * Uses `node:fs/promises` so writes never block the event loop.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MsgPack } from "@reticulum/core";
import { MessageStore } from "@reticulum/core/src/lxmf/message_store.js";

const STORE_FILE = "propagation_messages.rmp";

/**
 * Persists the propagation-node message store to disk (one msgpack file,
 * overwritten atomically).
 *
 * @param {string} directory
 * @param {MessageStore} store
 * @returns {Promise<void>}
 */
export async function saveLXMFStore(directory, store) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, STORE_FILE),
    MsgPack.encode(store.exportRecords()),
  );
}

/**
 * Loads the propagation-node message store from disk into a fresh
 * {@link MessageStore} configured with the given limits. A missing file or
 * absent directory yields an empty store (a clean start).
 *
 * @param {string} directory
 * @param {Object} [opts] Forwarded to the {@link MessageStore} constructor.
 * @param {number|null} [opts.storageLimitBytes] Stored-message byte cap.
 * @param {number|null} [opts.messageTtlSecs] Stored-message age TTL.
 * @returns {Promise<MessageStore>}
 */
export async function loadLXMFStore(directory, opts = {}) {
  const store = new MessageStore({
    storageLimitBytes: opts.storageLimitBytes ?? null,
    messageTtlSecs: opts.messageTtlSecs ?? null,
  });
  const path = join(directory, STORE_FILE);
  if (existsSync(path)) {
    const bytes = await readFile(path);
    if (bytes.length > 0) {
      store.importRecords(MsgPack.decode(new Uint8Array(bytes)));
    }
  }
  return store;
}
