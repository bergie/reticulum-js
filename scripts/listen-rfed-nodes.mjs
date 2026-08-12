// listen-rfed-nodes.mjs — listens for `rfed.node` announces and prints any
// discovered federation nodes (long-running). Temporary diagnostic script.
//
// Usage:
//   node scripts/listen-rfed-nodes.mjs
//
// Environment:
//   RNS_HOST / RNS_PORT   local rnsd TCP interface (default 127.0.0.1:42424)

import { MsgPack, Reticulum, toHex } from "@reticulum/core";
import {
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "@reticulum/node";

async function main() {
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter("./.listen-rfed-storage"),
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

  /** @type {Map<string, {name: string, stampCost: number|null, protocolVersion: number|null, identityHash: string}>} */
  const seen = new Map();

  rns.transport.onAnnounce("rfed", "node", (detail) => {
    const destHex = toHex(detail.destinationHash);
    const identityHash = detail.identity
      ? toHex(detail.identity.identityHash)
      : "unknown";

    let name = "?";
    let stampCost = null;
    let protocolVersion = null;
    const appData = detail.appData;
    if (appData && appData.length > 0) {
      try {
        const decoded = MsgPack.decode(appData);
        // rfed.node app_data = [display_name, stamp_cost|null, protocol_version]
        if (Array.isArray(decoded)) {
          name = decoded[0] ? new TextDecoder().decode(decoded[0]) : "?";
          stampCost = decoded[1] ?? null;
          protocolVersion = decoded[2] ?? null;
        }
      } catch {
        // ignore invalid app_data
      }
    }

    const isNew = !seen.has(destHex);
    seen.set(destHex, { name, stampCost, protocolVersion, identityHash });

    const stamp = new Date().toISOString();
    if (isNew) {
      console.log(
        `\n[${stamp}] NEW rfed.node discovered!\n` +
          `  destination hash: ${destHex}\n` +
          `  identity hash:    ${identityHash}\n` +
          `  name:             ${name}\n` +
          `  stamp cost:       ${stampCost ?? "disabled"}\n` +
          `  protocol:         v${protocolVersion ?? "?"}`,
      );
      console.log(`Total rfed.node instances known: ${seen.size}`);
    } else {
      console.log(`[${stamp}] re-announce from ${name} (${destHex})`);
    }
  });

  console.log("Listening for rfed.node announces. Ctrl+C to quit.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
