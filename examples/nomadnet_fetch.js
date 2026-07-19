/**
 * NomadNet page fetcher (PROTOCOL-SPEC.md §11.6).
 *
 * Connects to the Reticulum mesh, establishes a Link to a remote
 * `nomadnetwork.node` destination, issues a §11 REQUEST for `/page/index.mu`,
 * and prints the raw micron markup — no rendering.
 *
 * The target node must be reachable through the configured interface and must
 * have announced (or otherwise had its identity learned) so a Link can be
 * established. A path request is sent up front to speed that up.
 *
 *   node examples/nomadnet_fetch.js
 *   NN_TARGET=d6d0cc236a9ecb80303c4e148c23d22e RNS_HOST=127.0.0.1 RNS_PORT=42424 \
 *     node examples/nomadnet_fetch.js
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Destination,
  DestType,
  fromHex,
  Identity,
  Reticulum,
  toHex,
} from "../src/index.js";
import { LocalClientInterface } from "../src/interfaces/local_client.js";
import { TCPClientInterface } from "../src/interfaces/tcp.js";

// The NomadNet node to fetch from: a 16-byte destination hash (32 hex chars).
const TARGET_HASH_HEX =
  process.env.NN_TARGET ?? "d6d0cc236a9ecb80303c4e148c23d22e";
// Which page to request (§11.6.1 — `/page/index.mu` is the Browser default).
const PAGE_PATH = process.env.NN_PAGE ?? "/page/index.mu";
// Interface to the mesh (a local rnsd by default).
const RNS_HOST = process.env.RNS_HOST ?? "127.0.0.1";
const RNS_PORT = Number(process.env.RNS_PORT ?? 42424);

/** Simple file-backed storage adapter for our own identity key. */
class FileStorageAdapter {
  constructor(path) {
    this.path = path;
  }
  async loadKey() {
    return existsSync(this.path) ? readFileSync(this.path) : null;
  }
  async saveKey(keyData) {
    writeFileSync(this.path, keyData);
  }
}

/**
 * Waits until the identity for a destination hash has been learned (from an
 * announce or a path response). A Link needs the peer's public key for ECDH.
 * @param {import("../src/core/reticulum.js").Reticulum} rns
 * @param {Uint8Array} destinationHash
 * @param {number} timeoutMs
 * @returns {Promise<import("../src/core/identity.js").Identity|null>}
 */
async function waitForKnownIdentity(rns, destinationHash, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  // Actively probe for the path/identity up front, then poll.
  try {
    await rns.transport.requestPath(destinationHash);
  } catch (err) {
    console.warn("[!] path request failed:", String(err).slice(0, 80));
  }
  while (Date.now() < deadline) {
    const identity = await Destination.recall(destinationHash);
    if (identity) return identity;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function main() {
  const targetHash = fromHex(TARGET_HASH_HEX);
  console.log(`NomadNet fetch -> ${TARGET_HASH_HEX}${PAGE_PATH}`);

  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter("./nomadnet-fetch-identity.key"),
  });

  // Prefer the local shared instance (auto-discovered from
  // ~/.reticulum/config); fall back to the explicit RNS_HOST:RNS_PORT TCP
  // interface when no shared instance is reachable.
  const shared = await LocalClientInterface.connectToSharedInstance();
  if (shared) {
    rns.addInterface(shared, true);
    console.log("Connected via local shared instance");
  } else {
    const tcp = new TCPClientInterface({ host: RNS_HOST, port: RNS_PORT });
    await tcp.connect();
    rns.addInterface(tcp, true);
    console.log(`Connected to ${RNS_HOST}:${RNS_PORT}`);
  }

  const myIdentity = await Identity.loadOrGenerate(rns.storage);
  console.log(`Our identity hash: ${toHex(myIdentity.identityHash)}`);

  console.log(`\nLearning the identity of ${TARGET_HASH_HEX} ...`);
  const nodeIdentity = await waitForKnownIdentity(rns, targetHash);
  if (!nodeIdentity) {
    console.error(
      `[!] Could not learn an identity for ${TARGET_HASH_HEX}.\n` +
        "    Is the node reachable and has it announced?",
    );
    process.exit(1);
  }
  console.log("Learned node identity. Establishing Link...");

  // Build the OUT destination for the node's nomadnetwork.node aspect and open
  // a Link. createLink() resolves once the handshake completes (ACTIVE).
  const nodeDest = await Destination.OUT(
    "nomadnetwork.node",
    DestType.SINGLE,
    nodeIdentity,
    rns,
  );
  const link = await nodeDest.createLink();
  console.log(`Link ACTIVE (link_id: ${toHex(link.linkId)})`);

  console.log(`\nREQUEST ${PAGE_PATH} ...`);
  const response = await link.request(PAGE_PATH, null, { timeout: 30000 });

  // NomadNet page handlers return the raw .mu file bytes, which msgpack
  // carries as `bin` → Uint8Array. Large pages arrive via the §10 Resource
  // pipeline, transparent to the caller.
  let /** @type {string} */ text;
  if (response instanceof Uint8Array) {
    text = new TextDecoder().decode(response);
  } else if (typeof response === "string") {
    text = response;
  } else {
    text = JSON.stringify(response);
  }

  console.log(`\n----- ${PAGE_PATH} (${text.length} chars) -----`);
  console.log(text);
  console.log(`----- end -----`);

  // A graceful close lets the peer tear down cleanly.
  await link.teardown();
  process.exit(0);
}

main().catch((err) => {
  console.error("[!] Fatal:", err);
  process.exit(1);
});
