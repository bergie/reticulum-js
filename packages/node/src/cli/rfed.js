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
  /** @type {string[]} */
  const syncPeers = values["sync-peer"];
  const iface = values.interface;

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
