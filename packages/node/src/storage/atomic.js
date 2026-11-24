/**
 * @file atomic.js
 * @description Crash-safe file replacement for the Node.js storage layer
 *   (`FileStorageAdapter` records, identity key, owned ratchets, and the
 *   LXMF/rfed store dumps).
 *
 * A plain `writeFile(target, …)` truncates the target and writes in place, so
 * a process kill, OOM kill or power cut mid-write leaves a *partial file
 * forever* — observed in the field as `Persistor` "Skipping corrupt
 * identities/paths record" warnings on every subsequent boot (`Unexpected
 * end of data` from the msgpack decoder) for every record that happened to
 * be in flight when the process died.
 *
 * {@link atomicWriteFile} instead writes to a uniquely named sibling temp
 * file, fsyncs it, then `rename(2)`s it over the target — atomic on POSIX
 * (and NTFS/WRLock on Windows). A reader either sees the complete previous
 * file or the complete new one, never a mixture, and a crash can only ever
 * leave an orphaned `.tmp-*` sibling, never a damaged target. The fsync
 * before rename extends the same guarantee across power loss, not just
 * process death.
 */

import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Replaces `filePath` with `bytes` atomically.
 *
 * The temp file is a sibling of the target (same directory ⇒ same
 * filesystem ⇒ `rename` is atomic) and carries a random suffix, so
 * concurrent writers to the same target cannot clobber each other's temp
 * file and a leftover from a crashed process never collides either.
 *
 * @param {string} filePath Target path, replaced atomically.
 * @param {Uint8Array} bytes Content to write.
 * @param {object} [options]
 * @param {number} [options.mode] File mode for the new file (e.g. `0o600`
 *   for secret material). `rename` preserves the temp file's mode, so this
 *   is how the final file ends up owner-only regardless of umask. Defaults
 *   to Node's usual `0o666`-and-umask behaviour.
 * @param {(tmpPath: string) => Promise<void>} [options.beforeRename] Hook
 *   run on the temp file just before the rename — e.g. stamping mtime for
 *   stores that persist a timestamp as the file's `utimes`.
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, bytes, options = {}) {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    const handle = await open(tmp, "w", options.mode);
    try {
      await handle.writeFile(bytes);
      // Durability before the rename: after a power cut the target must be
      // either the old bytes or the fully-written new bytes, never a hole.
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.beforeRename) {
      await options.beforeRename(tmp);
    }
    await rename(tmp, filePath);
    // Best-effort directory fsync so the rename itself survives a power
    // cut too. Opening a directory read-only fails on some platforms
    // (Windows); the file-level guarantee above still holds there.
    try {
      const dir = await open(dirname(filePath), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      /* directory fsync not supported here — file-level guarantee stands */
    }
  } catch (e) {
    // Never leave the temp sibling behind on a failed write.
    try {
      await unlink(tmp);
    } catch {
      /* best effort — a leftover sibling is harmless */
    }
    throw e;
  }
}
