// rfed_client.js — a small rfed (Reticulum Federation) channel client.
//
// Connects to the local Reticulum instance, discovers a rfed node, subscribes
// to a public channel, and prints any messages that arrive over live fanout.
// Pass a message argument to also publish one.
//
// Usage:
//   node examples/rfed_client.js [channel] [message]
//
//   node examples/rfed_client.js                        # listen on public.test
//   node examples/rfed_client.js public.test            # listen on public.test
//   node examples/rfed_client.js public.test "hi"       # listen + publish "hi"
//
// Environment:
//   RFED_NODE   hex destination hash of the node's `rfed.node` destination
//               (default: the "Lille Oe" node rfed.node hash)
//   RNS_HOST / RNS_PORT   local rnsd TCP interface (default 127.0.0.1:42424)

import {
  Destination,
  fromHex,
  Identity,
  Reticulum,
  toHex,
} from "@reticulum/core";
import { LXMessage } from "@reticulum/core/src/lxmf/index.js";
import { RFedClient } from "@reticulum/core/src/rfed/index.js";
import {
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "@reticulum/node";

// Default target: the "Lille Oe" rfed node's `rfed.node` destination. All
// rfed.* destinations share one identity, so recalling this hash yields the
// identity used to build rfed.channel.subscribe / .publish / .pull.
const DEFAULT_NODE_HASH = "efaf5d16800b72cf33f2780f01bd2709";

const channelName = process.argv[2] ?? "public.test";
const publishContent = process.argv[3] ?? null;
const nodeHashHex = process.env.RFED_NODE ?? DEFAULT_NODE_HASH;

/** Polls fn every `intervalMs` until it returns truthy or `timeoutMs` elapses. */
async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  console.log(`rfed client — channel: ${channelName}`);

  // ── Reticulum core + network interface ─────────────────────────────────
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter("./rfed-storage"),
  });

  // Prefer the local shared rnsd instance; fall back to a direct TCP interface.
  const shared = await LocalClientInterface.connectToSharedInstance();
  if (shared) {
    rns.addInterface(shared, true);
    console.log("Attached to local shared Reticulum instance.");
  } else {
    const tcp = new TCPClientInterface({
      host: process.env.RNS_HOST ?? "127.0.0.1",
      port: Number(process.env.RNS_PORT ?? 42424),
    });
    await tcp.connect();
    rns.addInterface(tcp, true);
    console.log(`Connected to rnsd at ${tcp.host}:${tcp.port}.`);
  }

  // ── Persistent client identity (owns rfed.delivery) ────────────────────
  const identity = await Identity.loadOrGenerate(rns.storage);
  console.log(`Client identity:    ${toHex(identity.identityHash)}`);

  const client = new RFedClient({ identity, rns });

  // ── Discover the rfed node ─────────────────────────────────────────────
  // Request a path to rfed.node; the path-response/announce caches the node's
  // shared identity under its destination hash, which RFedClient recalls.
  const nodeHash = fromHex(nodeHashHex);
  console.log(`Looking for rfed.node ${nodeHashHex} ...`);
  rns.transport.requestPath(nodeHash);

  const nodeIdentity = await waitFor(() => Destination.recall(nodeHash), 30000);
  if (!nodeIdentity) {
    console.error(
      `Could not learn the rfed node's identity within 30s. Is the node online and announcing?`,
    );
    process.exit(1);
  }
  console.log(
    `Found rfed node — identity hash ${toHex(nodeIdentity.identityHash)}`,
  );

  // Paths in Reticulum are per-destination-hash: a path to rfed.node does
  // NOT give a path to rfed.channel.subscribe/publish/pull. The node shares
  // one identity across all of them, so derive each service destination hash
  // and request a path to the ones this client opens links to / sends to.
  // Hearing each announce also caches the identity under that hash.
  for (const name of [
    "rfed.channel.subscribe",
    "rfed.channel.publish",
    "rfed.channel.pull",
  ]) {
    const dest = await Destination.OUT(
      name,
      1 /* DestType.SINGLE */,
      nodeIdentity,
    );
    rns.transport.requestPath(dest.destinationHash);
  }
  console.log("Requested paths to the rfed channel service destinations.");

  // Wait until the link target is reachable (its announce/path-response has
  // populated both the identity cache and the path table).
  const subscribeDest = await Destination.OUT(
    "rfed.channel.subscribe",
    1 /* DestType.SINGLE */,
    nodeIdentity,
  );
  const ready = await waitFor(
    () => Destination.recall(subscribeDest.destinationHash),
    30000,
  );
  if (!ready) {
    console.error("Path to rfed.channel.subscribe did not arrive in 30s.");
    process.exit(1);
  }
  console.log("Path to rfed.channel.subscribe established.");

  // ── Listen for fanout deliveries BEFORE subscribing, so we don't race ──
  const deliveryHash = await client.listen((decoded) => {
    const sender = toHex(decoded.sourceHash);
    const ok = decoded.signatureValid ? "verified" : "UNVERIFIED";
    console.log(
      `\n[<] ${decoded.channelName} (from ${sender}, ${ok})` +
        (decoded.message.title ? `\n    ${decoded.message.title}` : "") +
        `\n    ${decoded.message.content}`,
    );
  });
  console.log(`Delivery destination: ${toHex(deliveryHash)} (announced)`);

  // ── Subscribe (caches the node's advertised stamp cost) ────────────────
  const sub = await client.subscribe(nodeHash, channelName);
  if (!sub.ok) {
    console.error(`Subscribe rejected by the node.`);
    process.exit(1);
  }
  console.log(
    `Subscribed to ${channelName} (stamp cost: ${sub.stampCost ?? "disabled"})`,
  );

  // ── Optionally publish ─────────────────────────────────────────────────
  if (publishContent) {
    // Give the delivery announce time to reach the node so live fanout can
    // route back to us; otherwise the node defers (and we rely on PULL).
    console.log("Waiting 5s for the delivery announce to propagate...");
    await new Promise((r) => setTimeout(r, 5000));
    // RFedClient.publish forces the correct LXMF addressing (channel delivery
    // hash + sender delivery hash) via the Phase-0 wrapper, so a plain content
    // message is all that's needed here.
    const message = new LXMessage({
      content: publishContent,
      title: "rfed.js",
    });
    await client.publish(nodeHash, channelName, message);
    console.log(`[>] Published: ${publishContent}`);
  }

  // Keep the node's path to our rfed.delivery fresh (re-announce periodically)
  // so live fanout can reach us. Without this, transit relays evict the path
  // and the node defers our blobs for later PULL instead.
  setInterval(() => {
    client.deliveryDest?.announce().catch(() => {});
  }, 60000);

  // Fanout may be deferred if the node lacked a path to us at publish time.
  // Drain the deferred queue for this channel a few seconds after publishing,
  // and again every 30 s, so we still see those messages.
  const drainDeferred = async (label) => {
    try {
      const pulled = await client.pull(nodeHash, channelName);
      if (pulled.items.length > 0) {
        console.log(
          `[~] ${label}: pulled ${pulled.items.length} deferred blob(s)` +
            ` (morePending=${pulled.morePending})`,
        );
      }
    } catch (err) {
      console.error(`[~] ${label}: pull failed: ${err.message}`);
    }
  };
  if (publishContent) setTimeout(() => drainDeferred("post-publish"), 3000);
  setInterval(() => drainDeferred("periodic"), 30000);

  console.log("\nListening for channel messages. Ctrl+C to quit.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
