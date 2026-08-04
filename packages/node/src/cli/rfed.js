#!/usr/bin/env node
/**
 * @file rfed.js
 * @description CLI runner for the Node.js rfed (Reticulum Federation) node
 *   (work doc #25).
 *
 * Boots a `Reticulum` instance with a mesh interface, loads (or creates) the
 * node identity, hydrates the four rfed stores from disk, and runs an
 * {@link RFedNode} with periodic maintenance, persistence, and optional static
 * peer sync. State survives restarts.
 *
 * Usage:
 *   node packages/node/src/cli/rfed.js [options]
 *
 * Options:
 *   --rfed-dir <path>          rfed store directory (blobs/ + *.rmp). Default ./rfed-data
 *   --rns-dir <path>           Reticulum storage dir (identity/paths). Default ./reticulum
 *   --name <name>              rfed.node announce display name. Default "rfed"
 *   --stamp-cost <bits>        required PoW leading-zero bits (0 = disabled). Default 16
 *   --stamp-flex <bits>        downward cost tolerance. Default 3
 *   --interface <shared|auto|tcp>   mesh interface. Default "shared"
 *   --sync-peer <hex>          rfed.node hash to sync with periodically (repeatable)
 *   --sync-interval <sec>      peer-sync period. Default 300
 *   --maintenance-interval <sec>    maintenance + persist period. Default 3600
 *   --primary-node <hex>       designated backup target for this node's subs (SPEC §11)
 *   --secondary-node <hex>     fallback backup target (repeatable)
 *   --owner-offline-secs <sec> silence before a backup fails over. Default 90
 *   --trusted-backup-peer <hex>  restrict /rfed/backup/push to these owners (repeatable)
 *   --backup-interval <sec>    backup push + failover tick period. Default 30
 *
 * Environment (tcp interface only): RNS_HOST (default 127.0.0.1), RNS_PORT (42424)
 *
 * Signals: SIGINT/SIGTERM flush stores to disk and exit.
 */
import { parseArgs } from "node:util";
import {
  Destination,
  Identity,
  Reticulum,
  fromHex,
  toHex,
} from "@reticulum/core";
import { RFedNode } from "@reticulum/core/src/rfed/index.js";
import {
  AutoInterface,
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "../index.js";
import { loadRFedStores, saveRFedStores } from "../storage/rfed.js";

const MAINTENANCE_INTERVAL_DEFAULT = 3600;
const SYNC_INTERVAL_DEFAULT = 300;
/** Backup push + failover tick cadence (SPEC §11; Rust `BACKUP_TICK_SECS`). */
const BACKUP_INTERVAL_DEFAULT = 30;

/**
 * Boots and runs the rfed node until interrupted.
 * @returns {Promise<void>}
 */
async function main() {
  const { values } = parseArgs({
    options: {
      "rfed-dir": { type: "string", default: "./rfed-data" },
      "rns-dir": { type: "string", default: "./reticulum" },
      name: { type: "string", default: "rfed" },
      "stamp-cost": { type: "string", default: "16" },
      "stamp-flex": { type: "string", default: "3" },
      interface: { type: "string", default: "shared" },
      "sync-peer": { type: "string", multiple: true, default: [] },
      "sync-interval": { type: "string", default: String(SYNC_INTERVAL_DEFAULT) },
      "maintenance-interval": {
        type: "string",
        default: String(MAINTENANCE_INTERVAL_DEFAULT),
      },
      "primary-node": { type: "string" },
      "secondary-node": { type: "string", multiple: true, default: [] },
      "owner-offline-secs": { type: "string", default: "90" },
      "trusted-backup-peer": { type: "string", multiple: true, default: [] },
      "backup-interval": {
        type: "string",
        default: String(BACKUP_INTERVAL_DEFAULT),
      },
    },
  });

  const rfedDir = values["rfed-dir"];
  const stampCost = Number.parseInt(values["stamp-cost"], 10) || 0;
  const stampFlex = Number.parseInt(values["stamp-flex"], 10) || 0;
  const maintenanceInterval =
    Number.parseInt(values["maintenance-interval"], 10) ||
    MAINTENANCE_INTERVAL_DEFAULT;
  const syncInterval =
    Number.parseInt(values["sync-interval"], 10) || SYNC_INTERVAL_DEFAULT;
  const backupInterval =
    Number.parseInt(values["backup-interval"], 10) || BACKUP_INTERVAL_DEFAULT;
  const ownerOfflineSecs =
    Number.parseInt(values["owner-offline-secs"], 10) || 90;
  /** @type {string[]} */
  const syncPeers = values["sync-peer"];
  const iface = values.interface;
  // Backup failover (SPEC §11). Hashes are 16 bytes (32 hex chars).
  const primaryNode = values["primary-node"]
    ? fromHex(values["primary-node"])
    : null;
  /** @type {Uint8Array[]} */
  const secondaryNodes = (values["secondary-node"] ?? []).map((h) =>
    fromHex(h),
  );
  /** @type {Uint8Array[]} */
  const trustedBackupPeers = (values["trusted-backup-peer"] ?? []).map((h) =>
    fromHex(h),
  );

  console.log(`rfed node — store: ${rfedDir}, interface: ${iface}`);

  // ── Reticulum core + mesh interface ───────────────────────────────────
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter(values["rns-dir"]),
  });

  const attachedInterface = await attachInterface(rns, iface);
  if (attachedInterface) {
    console.log(`Mesh interface: ${attachedInterface}`);
  } else {
    console.warn(
      "No mesh interface attached — the node is reachable only locally.",
    );
  }

  // ── Node identity (persistent) ───────────────────────────────────────
  const identity = await Identity.loadOrGenerate(rns.storage);
  console.log(`Node identity: ${toHex(identity.identityHash)}`);

  // ── Hydrate rfed stores from disk ────────────────────────────────────
  const stores = await loadRFedStores(rfedDir);
  console.log(
    `Loaded stores: ${stores.blobStore.allMessageIds().length} blob(s), ` +
      `${stores.subscriptions.length} subscription(s), ` +
      `${stores.deferred.totalLen()} deferred, ` +
      `${stores.notify.count} notify registration(s).`,
  );

  // ── RFed node ────────────────────────────────────────────────────────
  const node = new RFedNode({
    identity,
    rns,
    stores,
    config: {
      name: values.name,
      stampCost,
      stampFlexibility: stampFlex,
      primaryNode,
      secondaryNodes,
      ownerOfflineSecs,
      trustedBackupPeers,
    },
  });
  await node.start();
  console.log(
    `rfed.node up — ${toHex(node.nodeHash ?? new Uint8Array())} (stamp cost ${stampCost || "off"}, flex ${stampFlex})`,
  );

  // Request paths to static sync peers so links can establish.
  for (const peerHex of syncPeers) {
    rns.transport.requestPath(fromHex(peerHex));
  }

  // ── Periodic: maintenance + persist ──────────────────────────────────
  const persist = async () => {
    try {
      const { blobsEvicted, deferredEvicted } = node.tickMaintenance();
      await saveRFedStores(rfedDir, {
        blobStore: node.blobStore,
        subscriptions: node.subscriptions,
        deferred: node.deferred,
        notify: node.notifyRegistry,
      });
      if (blobsEvicted || deferredEvicted) {
        console.log(
          `maintenance: evicted ${blobsEvicted} blob(s), ${deferredEvicted} deferred; persisted.`,
        );
      }
    } catch (err) {
      console.error(`maintenance/persist failed: ${String(err)}`);
    }
  };
  const maintenanceTimer = setInterval(persist, maintenanceInterval * 1000);

  // ── Periodic: backup push + failover (SPEC §11) ─────────────────────
  const backupTick = async () => {
    try {
      const res = await node.tickBackupDelivery();
      if (res.pushed || res.adopted || res.pruned || res.repushed) {
        console.log(
          `backup: pushed ${res.pushed}, adopted ${res.adopted}, ` +
            `repushed ${res.repushed}, pruned ${res.pruned}.`,
        );
      }
    } catch (err) {
      console.warn(`backup tick failed: ${String(err)}`);
    }
  };
  const backupTimer = setInterval(backupTick, backupInterval * 1000);

  // ── Periodic: peer sync ──────────────────────────────────────────────
  let syncTimer = null;
  if (syncPeers.length > 0) {
    const syncOnce = async () => {
      for (const peerHex of syncPeers) {
        try {
          const n = await node.syncWithPeer(fromHex(peerHex));
          if (n > 0) console.log(`sync: ${n} blob(s) from ${peerHex}`);
        } catch (err) {
          console.warn(`sync with ${peerHex} failed: ${String(err)}`);
        }
      }
    };
    syncTimer = setInterval(syncOnce, syncInterval * 1000);
    // Kick one off shortly after startup (let paths settle).
    setTimeout(syncOnce, 5000);
  }

  // ── Shutdown ────────────────────────────────────────────────────────
  let shuttingDown = false;
  /** @param {string} sig */
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} received — flushing stores and shutting down…`);
    clearInterval(maintenanceTimer);
    clearInterval(backupTimer);
    if (syncTimer) clearInterval(syncTimer);
    try {
      node.stop();
      await saveRFedStores(rfedDir, {
        blobStore: node.blobStore,
        subscriptions: node.subscriptions,
        deferred: node.deferred,
        notify: node.notifyRegistry,
      });
    } catch (err) {
      console.error(`flush failed: ${String(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("Running. (Ctrl+C to stop)\n");
}

/**
 * Attaches the requested mesh interface to `rns`.
 *
 * @param {Reticulum} rns
 * @param {string} kind - "shared" | "auto" | "tcp"
 * @returns {Promise<string|null>} a human-readable label, or null if nothing attached.
 */
async function attachInterface(rns, kind) {
  if (kind === "auto") {
    const auto = new AutoInterface({ name: "auto" });
    await auto.connect();
    rns.addInterface(/** @type {any} */ (auto), true);
    return "AutoInterface";
  }
  if (kind === "tcp") {
    const tcp = new TCPClientInterface({
      host: process.env.RNS_HOST ?? "127.0.0.1",
      port: Number(process.env.RNS_PORT ?? 42424),
    });
    await tcp.connect();
    rns.addInterface(/** @type {any} */ (tcp), true);
    return `TCP ${tcp.host}:${tcp.port}`;
  }
  // "shared" (default): prefer the local shared rnsd instance; fall back to auto.
  const shared = await LocalClientInterface.connectToSharedInstance();
  if (shared) {
    rns.addInterface(/** @type {any} */ (shared), true);
    return "shared rnsd instance";
  }
  const auto = new AutoInterface({ name: "auto" });
  await auto.connect();
  rns.addInterface(/** @type {any} */ (auto), true);
  return "AutoInterface (shared instance unavailable)";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
