import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Destination,
  DestType,
  fromHex,
  Identity,
  LXMessage,
  LXMRouter,
  Reticulum,
  TCPClientInterface,
  toHex,
} from "../src/index.js";

// The LXMF destination hash this script will try to talk to.
// Override at runtime with the `LXMF_TARGET` environment variable.
const TARGET_HASH_HEX =
  process.env.LXMF_TARGET ?? "178b9ff0b5463650cec7124d05ac5cc9";

// A simple Node.js file storage adapter for the sender's private key
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
 * Waits until the identity for a destination hash has been learned (typically
 * from an announce). Opportunistic delivery needs the recipient's public key
 * to encrypt the single delivery packet.
 *
 * @param {Uint8Array} destinationHash
 * @param {number} timeoutMs
 * @returns {Promise<import("../src/core/identity.js").Identity|null>}
 */
async function waitForKnownIdentity(destinationHash, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await Destination.recall(destinationHash);
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

async function startSender() {
  const targetHash = fromHex(TARGET_HASH_HEX);
  console.log(`Starting LXMF Sender -> ${TARGET_HASH_HEX}`);

  // Initialize the Core RNS Engine
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter("./sender-identity.key"),
  });

  // Connect to the local Reticulum mesh daemon via TCP
  const tcpInterface = new TCPClientInterface({
    host: "127.0.0.1",
    port: 42424,
  });
  await tcpInterface.connect();
  rns.addInterface(tcpInterface, true);

  // Load or generate the Sender's Ed25519 Identity
  const senderIdentity = await Identity.loadOrGenerate(rns.storage);
  console.log(`Sender Identity Hash: ${toHex(senderIdentity.identityHash)}`);

  const { default: data } = await import("../package.json", {
    with: { type: "json" },
  });
  senderIdentity.setAppData(`JS LXMF sender (${data.version})`);

  // Bind the LXMF Router to our Identity and Network Core
  const lxmf = new LXMRouter(senderIdentity, rns);
  await lxmf.init();
  console.log(
    `Sender Destination Hash: ${toHex(lxmf.deliveryDest.destinationHash)}`,
  );

  // Announce ourselves so the peer knows who we are
  await lxmf.deliveryDest.announce();
  console.log("Sender announced to the mesh.");

  // If the peer replies, just log it for visibility
  lxmf.addEventListener("message", (event) => {
    const message = event.detail.message;
    console.log(
      `\n[+] Reply from ${toHex(message.sourceHash)}: ${message.content}`,
    );
  });

  // We need the recipient's identity before we can do anything useful.
  console.log(
    `\nWaiting to learn the identity of ${TARGET_HASH_HEX} (from an announce)...`,
  );
  const peerIdentity = await waitForKnownIdentity(targetHash);
  if (!peerIdentity) {
    console.error(
      `[!] Identity for ${TARGET_HASH_HEX} is still unknown after timeout.\n` +
        "    Make sure the peer is online and has announced.",
    );
    return;
  }
  console.log("Learned peer identity. Ready to send.\n");

  // --------------------------------------------------------------------------
  // Method 1: Opportunistic delivery
  //
  // A single encrypted Reticulum DATA packet addressed directly to the
  // recipient's lxmf.delivery destination. No Link is established. Best suited
  // for short messages that fit within a single packet (LXMF.md §5.1).
  // --------------------------------------------------------------------------
  await sendOpportunistic(lxmf, senderIdentity, targetHash);

  // --------------------------------------------------------------------------
  // Method 2: Direct delivery over a Link the script initiates
  //
  // The sender opens a Reticulum Link to the recipient and sends the full
  // signed LXMF body over it. The Link provides transport encryption and a
  // larger per-packet MDU than opportunistic delivery (LXMF.md §5.2).
  // --------------------------------------------------------------------------
  await sendDirectOverLink(rns, lxmf, senderIdentity, targetHash, peerIdentity);

  // --------------------------------------------------------------------------
  // Method 3: Delivery over a propagation node (TODO)
  //
  // Submit the message to an LXMF propagation node for store-and-forward
  // delivery when the recipient is offline (LXMF.md §5.8). Not implemented yet.
  // --------------------------------------------------------------------------
  // await sendViaPropagationNode(rns, lxmf, senderIdentity, targetHash);

  console.log("\nAll delivery attempts finished.");
}

/**
 * Sends a short message as a single opportunistic Reticulum packet.
 *
 * @param {LXMRouter} lxmf
 * @param {import("../src/core/identity.js").Identity} senderIdentity
 * @param {Uint8Array} targetHash
 */
async function sendOpportunistic(lxmf, senderIdentity, targetHash) {
  console.log("--- Method 1: Opportunistic delivery ---");
  try {
    const message = new LXMessage({
      sourceHash: lxmf.deliveryDest.destinationHash,
      destinationHash: targetHash,
      title: "Hello (opportunistic)",
      content: "Hi! This message was delivered as a single RNS packet.",
    });
    await lxmf.send(message, senderIdentity);
    console.log("[->] Opportunistic message sent.");
  } catch (error) {
    console.error("[!] Opportunistic delivery failed:", error.message);
  }
}

/**
 * Opens a Link to the recipient and delivers the message over it.
 *
 * @param {Reticulum} rns
 * @param {LXMRouter} lxmf
 * @param {import("../src/core/identity.js").Identity} senderIdentity
 * @param {Uint8Array} targetHash
 * @param {import("../src/core/identity.js").Identity} peerIdentity
 */
async function sendDirectOverLink(
  rns,
  lxmf,
  senderIdentity,
  targetHash,
  peerIdentity,
) {
  console.log("\n--- Method 2: Direct delivery over an initiated Link ---");
  try {
    // Build the OUT destination for the peer's lxmf.delivery endpoint
    const peerDestination = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      peerIdentity,
      rns,
    );

    console.log("[*] Opening Link to peer...");
    const link = await peerDestination.createLink();
    console.log(`[*] Link established (link_id: ${toHex(link.linkId)})`);

    // CRITICAL: Identify ourselves over the link before sending any data.
    // Python's LXMRouter (and ours) won't process incoming link messages
    // until LINKIDENTIFY has been received — sending earlier would have the
    // message parked or silently dropped. See LINKS.md §6.7.6.
    console.log("[*] Sending LINKIDENTIFY...");
    await link.identify(senderIdentity);

    const message = new LXMessage({
      sourceHash: lxmf.deliveryDest.destinationHash,
      destinationHash: targetHash,
      title: "Hello (direct link)",
      content: "Hi! This message was delivered over an established Link.",
    });
    await lxmf.send(message, senderIdentity, link.linkId);
    console.log("[->] Direct-link message sent.");
  } catch (error) {
    console.error("[!] Direct-link delivery failed:", error.message);
  }
}

// Execute the sender
startSender().catch(console.error);
