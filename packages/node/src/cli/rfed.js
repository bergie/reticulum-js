#!/usr/bin/env node
/**
 * @file rfed.js
 * @description CLI runner for the Node.js rfed (Reticulum Federation) node
 *   (work doc #25) and, optionally, an LXMF propagation node (work doc #27).
 *
 * Boots a `Reticulum` instance with a mesh interface, loads (or creates) the
 * node identity, and runs one or both roles sharing that instance + identity:
 *
 *   - **rfed node** (default on; `--no-rfed` disables): hydrates the four rfed
 *     stores from disk and runs an {@link RFedNode} with periodic maintenance,
 *     persistence, backup failover, and optional static peer sync.
 *   - **LXMF propagation node** (`--lxmf-propagation`): an `lxmd`-like
 *     propagation node with disk-persisted message store, optional static
 *     peers, and autopeering.
 *
 * State survives restarts.
 *
 * Usage:
 *   node packages/node/src/cli/rfed.js [options]
 *
 * Options:
 *   --rfed-dir <path>          store directory (rfed + LXMF). Default ./rfed-data
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
 * LXMF propagation node (optional, --lxmf-propagation):
 *   --lxmf-propagation         also run an LXMF propagation node (lxmd-like)
 *   --no-rfed                  disable the rfed node (run LXMF propagation only)
 *   --lxmf-name <name>         propagation node display name
 *   --lxmf-stamp-cost <bits>   propagation stamp cost. Default 8
 *   --lxmf-peering-cost <bits> peering cost advertised to peers. Default 18
 *   --propagation-peer <hex>   static lxmf.propagation peer to sync with (repeatable)
 *   --autopeer                 auto-peer with discovered propagation nodes
 *   --autopeer-max-cost <bits> max advertised peering cost to auto-peer at. Default 18
 *   --lxmf-message-ttl-days <n>  prune stored LXMF messages older than this (default: none)
 *
 * Storage limits + TTLs (per-role unless noted):
 *   --storage-limit-mb <n>     byte cap for BOTH rfed blobs and LXMF messages
 *   --blob-ttl-days <n>        rfed blob age TTL. Default 30
 *   --deferred-ttl-days <n>    rfed deferred-queue entry TTL. Default 7
 *
 * Environment (tcp interface only): RNS_HOST (default 127.0.0.1), RNS_PORT (42424)
 *
 * Signals: SIGINT/SIGTERM flush stores to disk and exit.
 */
import { parseArgs } from "node:util";
import {
  fromHex,
  Identity,
  Reticulum,
  toHex,
} from "@reticulum/core";
import { LXMRouter } from "@reticulum/core/src/lxmf/index.js";
import { RFedNode } from "@reticulum/core/src/rfed/index.js";
import {
  AutoInterface,
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "../index.js";
import { loadRFedStores, saveRFedStores } from "../storage/rfed.js";
import { loadLXMFStore, saveLXMFStore } from "../storage/lxmf.js";

const MAINTENANCE_INTERVAL_DEFAULT = 3600;
const SYNC_INTERVAL_DEFAULT = 300;
/** Backup push + failover tick cadence (SPEC §11; Rust `BACKUP_TICK_SECS`). */
const BACKUP_INTERVAL_DEFAULT = 30;

/**
 * Boots and runs the configured role(s) until interrupted.
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
      "sync-interval": {
        type: "string",
        default: String(SYNC_INTERVAL_DEFAULT),
      },
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
      // ── LXMF propagation node (optional) ──
      "lxmf-propagation": { type: "boolean", default: false },
      "no-rfed": { type: "boolean", default: false },
      "lxmf-name": { type: "string" },
      "lxmf-stamp-cost": { type: "string", default: "8" },
      "lxmf-peering-cost": { type: "string", default: "18" },
      "propagation-peer": { type: "string", multiple: true, default: [] },
      autopeer: { type: "boolean", default: false },
      "autopeer-max-cost": { type: "string", default: "18" },
      "lxmf-message-ttl-days": { type: "string" },
      // ── Storage limits + TTLs ──
      "storage-limit-mb": { type: "string" },
      "blob-ttl-days": { type: "string", default: "30" },
      "deferred-ttl-days": { type: "string", default: "7" },
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

  // ── Role selection + limits ──────────────────────────────────────────
  const enableRfed = !values["no-rfed"];
  const enableLxmf = !!values["lxmf-propagation"];
  if (!enableRfed && !enableLxmf) {
    console.error("Nothing to run: both --no-rfed and no --lxmf-propagation.");
    process.exit(1);
  }
  /** @type {string[]} */
  const propagationPeers = values["propagation-peer"] ?? [];
  const lxmfStampCost = Number.parseInt(values["lxmf-stamp-cost"], 10) || 0;
  const lxmfPeeringCost = Number.parseInt(values["lxmf-peering-cost"], 10) || 0;
  const autopeerMaxCost = Number.parseInt(values["autopeer-max-cost"], 10) || 0;
  // Shared byte cap (MB → bytes) for rfed blobs + LXMF messages.
  const storageLimitBytes = values["storage-limit-mb"]
    ? Number.parseInt(values["storage-limit-mb"], 10) * 1000 * 1000
    : null;
  const blobTtlSecs =
    (Number.parseInt(values["blob-ttl-days"], 10) || 30) * 24 * 3600;
  const deferredTtlSecs =
    (Number.parseInt(values["deferred-ttl-days"], 10) || 7) * 24 * 3600;
  const lxmfMessageTtlSecs = values["lxmf-message-ttl-days"]
    ? Number.parseInt(values["lxmf-message-ttl-days"], 10) * 24 * 3600
    : null;

  console.log(
    `rfed runner — store: ${rfedDir}, interface: ${iface}` +
      (enableLxmf ? " (+ LXMF propagation)" : ""),
  );

  // ── Reticulum core + mesh interface (shared by both roles) ───────────
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

  // ── Node identity (persistent, shared by both roles) ─────────────────
  const identity = await Identity.loadOrGenerate(rns.storage);
  console.log(`Node identity: ${toHex(identity.identityHash)}`);

  // ── rfed node (default on) ───────────────────────────────────────────
  /** @type {RFedNode|null} */
  let node = null;
  if (enableRfed) {
    const stores = await loadRFedStores(rfedDir, {
      storageLimitBytes: storageLimitBytes ?? undefined,
    });
    console.log(
      `Loaded rfed stores: ${stores.blobStore.allMessageIds().length} blob(s), ` +
        `${stores.subscriptions.length} subscription(s), ` +
        `${stores.deferred.totalLen()} deferred, ` +
        `${stores.notify.count} notify registration(s).`,
    );
    node = new RFedNode({
      identity,
      rns,
      stores,
      config: {
        name: values.name,
        stampCost,
        stampFlexibility: stampFlex,
        storageLimitBytes: storageLimitBytes ?? undefined,
        blobTtlSecs,
        deferredTtlSecs,
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
    for (const peerHex of syncPeers) {
      rns.transport.requestPath(fromHex(peerHex));
    }
  }

  // ── LXMF propagation node (optional) ─────────────────────────────────
  /** @type {LXMRouter|null} */
  let lxmfRouter = null;
  if (enableLxmf) {
    lxmfRouter = new LXMRouter(identity, /** @type {any} */ (rns));
    await lxmfRouter.init();
    const lxmfStore = await loadLXMFStore(rfedDir, {
      storageLimitBytes,
      messageTtlSecs: lxmfMessageTtlSecs,
    });
    const pn = await lxmfRouter.enablePropagation({
      stampCost: lxmfStampCost,
      name: values["lxmf-name"] ?? values.name,
      peeringCost: lxmfPeeringCost,
      storageLimitBytes,
      messageTtlSecs: lxmfMessageTtlSecs,
      store: lxmfStore,
    });
    if (values.autopeer) lxmfRouter.enableAutopeer(autopeerMaxCost);
    await lxmfRouter.announcePropagationNode();
    console.log(
      `lxmf.propagation up — ${pn.store.size} stored message(s)` +
        (values.autopeer ? " (autopeer on)" : ""),
    );
    for (const peerHex of propagationPeers) {
      rns.transport.requestPath(fromHex(peerHex));
    }
  }

  // ── Periodic: maintenance + persist (per role) ───────────────────────
  const persist = async () => {
    try {
      if (node) {
        const { blobsEvicted, deferredEvicted } = node.tickMaintenance();
        await saveRFedStores(rfedDir, {
          blobStore: node.blobStore,
          subscriptions: node.subscriptions,
          deferred: node.deferred,
          notify: node.notifyRegistry,
        });
        if (blobsEvicted || deferredEvicted) {
          console.log(
            `rfed maintenance: evicted ${blobsEvicted} blob(s), ${deferredEvicted} deferred; persisted.`,
          );
        }
      }
      if (lxmfRouter?.propagationNode) {
        const { aged } = lxmfRouter.propagationNode.tickMaintenance();
        await saveLXMFStore(rfedDir, lxmfRouter.propagationNode.store);
        if (aged > 0) {
          console.log(`lxmf maintenance: pruned ${aged} aged message(s).`);
        }
      }
    } catch (err) {
      console.error(`maintenance/persist failed: ${String(err)}`);
    }
  };
  const maintenanceTimer = setInterval(persist, maintenanceInterval * 1000);

  // ── Periodic: rfed backup push + failover (SPEC §11) ─────────────────
  let backupTimer = null;
  if (node) {
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
    backupTimer = setInterval(backupTick, backupInterval * 1000);
  }

  // ── Periodic: rfed peer sync ─────────────────────────────────────────
  let syncTimer = null;
  if (node && syncPeers.length > 0) {
    const syncOnce = async () => {
      for (const peerHex of syncPeers) {
        try {
          const n = await node.syncWithPeer(fromHex(peerHex));
          if (n > 0) console.log(`rfed sync: ${n} blob(s) from ${peerHex}`);
        } catch (err) {
          console.warn(`rfed sync with ${peerHex} failed: ${String(err)}`);
        }
      }
    };
    syncTimer = setInterval(syncOnce, syncInterval * 1000);
    setTimeout(syncOnce, 5000);
  }

  // ── Periodic: LXMF propagation peer sync ─────────────────────────────
  let lxmfSyncTimer = null;
  if (lxmfRouter && propagationPeers.length > 0) {
    const lxmfSyncOnce = async () => {
      try {
        await lxmfRouter.syncPeers();
      } catch (err) {
        console.warn(`lxmf sync failed: ${String(err)}`);
      }
    };
    lxmfSyncTimer = setInterval(lxmfSyncOnce, syncInterval * 1000);
    setTimeout(lxmfSyncOnce, 5000);
  }

  // ── Shutdown ─────────────────────────────────────────────────────────
  let shuttingDown = false;
  /** @param {string} sig */
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} received — flushing stores and shutting down…`);
    clearInterval(maintenanceTimer);
    if (backupTimer) clearInterval(backupTimer);
    if (syncTimer) clearInterval(syncTimer);
    if (lxmfSyncTimer) clearInterval(lxmfSyncTimer);
    try {
      if (node) {
        node.stop();
        await saveRFedStores(rfedDir, {
          blobStore: node.blobStore,
          subscriptions: node.subscriptions,
          deferred: node.deferred,
          notify: node.notifyRegistry,
        });
      }
      if (lxmfRouter?.propagationNode) {
        await saveLXMFStore(rfedDir, lxmfRouter.propagationNode.store);
      }
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
