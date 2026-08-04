/**
 * @file rfed.js
 * @description Node.js filesystem persistence for the rfed in-memory stores
 *   (work doc #25).
 *
 * On-disk layout under the configured `directory` (mirrors the Rust `rfed`
 * layout, though disk format is implementation-specific — a JS node and a Rust
 * node do not share a disk):
 *
 *   <dir>/blobs/<ch_hex>/<id_hex>.bin   — one raw blob per file (mtime = `received`)
 *   <dir>/subscriptions.rmp             — msgpack of subscription records
 *   <dir>/deferred_delivery.rmp         — msgpack of deferred-queue records
 *   <dir>/notify_registrations.rmp      — msgpack of notify-registration records
 *
 * The core stores expose `exportRecords()`/`importRecords()` serialization
 * seams; this module owns the on-disk layout and (de)serialization timing.
 * Tables are msgpack-encoded via `@reticulum/core`'s `MsgPack` so the core
 * layer stays free of `node:` imports.
 *
 * Uses `node:fs/promises` so writes never block the event loop.
 */
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { MsgPack } from "@reticulum/core";
import {
  BlobStore,
  DeferredQueue,
  NotifyRegistry,
  SubscriptionTable,
} from "@reticulum/core/src/rfed/index.js";
import { fromHex, toHex } from "@reticulum/core/src/utils/encoding.js";

/**
 * Persists the four rfed stores to disk. The `blobs/` tree is rewritten from
 * scratch each call (stale blob files are removed); the three table files are
 * overwritten atomically.
 *
 * @param {string} directory
 * @param {{ blobStore: BlobStore, subscriptions: SubscriptionTable, deferred: DeferredQueue, notify: NotifyRegistry }} stores
 * @returns {Promise<void>}
 */
export async function saveRFedStores(directory, stores) {
  const { blobStore, subscriptions, deferred, notify } = stores;

  // Blobs: per-file under <dir>/blobs/<ch_hex>/<id_hex>.bin (mtime = received).
  const blobsDir = join(directory, "blobs");
  await rm(blobsDir, { recursive: true, force: true });
  await mkdir(blobsDir, { recursive: true });
  for (const r of blobStore.exportRecords()) {
    const chHex = toHex(r.channelHash);
    const idHex = toHex(r.messageId);
    const subDir = join(blobsDir, chHex);
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, `${idHex}.bin`);
    await writeFile(filePath, r.blob);
    // Preserve the original `received` timestamp via mtime (used for TTL).
    await utimes(filePath, r.received, r.received);
  }

  // Tables: single msgpack files.
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "subscriptions.rmp"),
    MsgPack.encode(await subscriptions.exportRecords()),
  );
  await writeFile(
    join(directory, "deferred_delivery.rmp"),
    MsgPack.encode(deferred.exportRecords()),
  );
  await writeFile(
    join(directory, "notify_registrations.rmp"),
    MsgPack.encode(notify.exportRecords()),
  );
}

/**
 * Loads the four rfed stores from disk into fresh instances. Missing files or
 * an absent directory yield empty stores (a clean start).
 *
 * @param {string} directory
 * @param {Object} [opts]
 * @param {number} [opts.storageLimitBytes] BlobStore capacity cap.
 * @param {number} [opts.globalDeferredLimit] DeferredQueue global cap.
 * @returns {Promise<{ blobStore: BlobStore, subscriptions: SubscriptionTable, deferred: DeferredQueue, notify: NotifyRegistry }>}
 */
export async function loadRFedStores(directory, opts = {}) {
  const blobStore = new BlobStore({
    storageLimitBytes: opts.storageLimitBytes,
  });
  const subscriptions = new SubscriptionTable();
  const deferred = new DeferredQueue({
    globalLimit: opts.globalDeferredLimit,
  });
  const notify = new NotifyRegistry();

  // Blobs: walk <dir>/blobs/<ch_hex>/<id_hex>.bin.
  const blobsDir = join(directory, "blobs");
  if (existsSync(blobsDir)) {
    /** @type {any[]} */
    const records = [];
    for (const chHex of await readdir(blobsDir)) {
      const subDir = join(blobsDir, chHex);
      if (!(await statSafe(subDir))?.isDirectory()) continue;
      for (const file of await readdir(subDir)) {
        if (!file.endsWith(".bin")) continue;
        const idHex = file.slice(0, -".bin".length);
        const filePath = join(subDir, file);
        const blob = await readFile(filePath);
        const { mtimeMs } = await stat(filePath);
        records.push({
          channelHash: fromHex(chHex),
          messageId: fromHex(idHex),
          blob: new Uint8Array(blob),
          received: mtimeMs / 1000,
        });
      }
    }
    blobStore.importRecords(records);
  }

  // Tables.
  await loadTable(join(directory, "subscriptions.rmp"), async (bytes) =>
    subscriptions.importRecords(MsgPack.decode(bytes)),
  );
  await loadTable(join(directory, "deferred_delivery.rmp"), (bytes) =>
    deferred.importRecords(MsgPack.decode(bytes)),
  );
  await loadTable(join(directory, "notify_registrations.rmp"), (bytes) =>
    notify.importRecords(MsgPack.decode(bytes)),
  );

  return { blobStore, subscriptions, deferred, notify };
}

/**
 * Reads a table file (if present) and hands its bytes to `importer`.
 * @param {string} path
 * @param {(bytes: Uint8Array) => (void|Promise<void>)} importer
 */
async function loadTable(path, importer) {
  if (!existsSync(path)) return;
  const bytes = await readFile(path);
  if (bytes.length === 0) return;
  await importer(new Uint8Array(bytes));
}

/** `stat` that returns `null` on ENOENT instead of throwing.
 * @param {string} path
 */
async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
