import {
  Destination,
  DestType,
  fromHex,
  Identity,
  LXMessage,
  LXMRouter,
  Reticulum,
  toHex,
} from "@reticulum/core";
import {
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "@reticulum/node";

// The LXMF destination hash this script will try to talk to.
// Override at runtime with the `LXMF_TARGET` environment variable.
const TARGET_HASH_HEX =
  process.env.LXMF_TARGET ?? "178b9ff0b5463650cec7124d05ac5cc9";

// A Node.js file-backed storage adapter: persists the sender's private key
// plus the peers/ratchets/paths we communicate with across restarts.

/**
 * Waits until the identity for a destination hash has been learned (typically
 * from an announce). Opportunistic delivery needs the recipient's public key
 * to encrypt the single delivery packet.
 *
 * @param {Uint8Array} destinationHash
 * @param {number} timeoutMs
 * @returns {Promise<import("@reticulum/core/src/core/identity.js").Identity|null>}
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
    storageAdapter: new FileStorageAdapter("./sender-storage"),
  });

  // Prefer the local shared instance (a running rnsd, or our own daemon): it
  // already owns the mesh interfaces, so we attach to it over the shared-
  // instance socket (auto-discovered from ~/.reticulum/config) instead of
  // opening our own. Falls back to a direct TCP interface when no shared
  // instance is reachable.
  const shared = await LocalClientInterface.connectToSharedInstance();
  if (shared) {
    rns.addInterface(shared, true);
  } else {
    const tcpInterface = new TCPClientInterface({
      host: "127.0.0.1",
      port: 42424,
    });
    await tcpInterface.connect();
    rns.addInterface(tcpInterface, true);
  }

  // Load or generate the Sender's Ed25519 Identity
  const senderIdentity = await Identity.loadOrGenerate(rns.storage);
  console.log(`Sender Identity Hash: ${toHex(senderIdentity.identityHash)}`);

  // Read our version string for the announce display name (§4.3 app_data).
  const { default: data } = await import("../packages/core/package.json", {
    with: { type: "json" },
  });

  // Bind the LXMF Router to our Identity and Network Core
  const lxmf = new LXMRouter(senderIdentity, rns);
  await lxmf.init();
  console.log(
    `Sender Destination Hash: ${toHex(lxmf.deliveryDest.destinationHash)}`,
  );

  // Announce ourselves so the peer knows who we are. LXMRouter.announce
  // attaches the §4.3 msgpack app_data (display name as bin8 + stamp cost +
  // capability list) for peer-name interop.
  await lxmf.announce(`JS LXMF sender (${data.version})`);
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
  // Method 3: Delivery via a propagation node (store-and-forward)
  //
  // Submit the message to an LXMF propagation node. The node stores it
  // encrypted until the recipient syncs — enabling delivery to offline peers
  // (LXMF.md §5.8). Set LXMF_PROPAGATION_NODE to the node's `lxmf.propagation`
  // destination hash to enable; otherwise this step is skipped.
  // --------------------------------------------------------------------------
  await sendViaPropagationNode(lxmf, senderIdentity, targetHash);

  console.log("\nAll delivery attempts finished.");
}

/**
 * Sends a short message as a single opportunistic Reticulum packet.
 *
 * @param {LXMRouter} lxmf
 * @param {import("@reticulum/core/src/core/identity.js").Identity} senderIdentity
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
 * Submits the message to an LXMF propagation node for store-and-forward
 * delivery. Enabled by setting `LXMF_PROPAGATION_NODE` to the node's
 * `lxmf.propagation` destination hash; skipped otherwise.
 *
 * @param {LXMRouter} lxmf
 * @param {import("@reticulum/core/src/core/identity.js").Identity} senderIdentity
 * @param {Uint8Array} targetHash
 */
async function sendViaPropagationNode(lxmf, senderIdentity, targetHash) {
  const propagationNodeHex = process.env.LXMF_PROPAGATION_NODE;
  if (!propagationNodeHex) {
    console.log(
      "\n--- Method 3: Propagation node delivery (skipped; set LXMF_PROPAGATION_NODE) ---",
    );
    return;
  }
  console.log("\n--- Method 3: Propagation node delivery ---");
  try {
    lxmf.setOutboundPropagationNode(fromHex(propagationNodeHex));
    const message = new LXMessage({
      sourceHash: lxmf.deliveryDest.destinationHash,
      destinationHash: targetHash,
      title: "Hello (propagation)",
      content:
        "Hi! This message was stored on a propagation node for offline delivery.",
    });
    const { transientId, stampCost } = await lxmf.submitToPropagationNode(
      message,
      senderIdentity,
    );
    console.log(
      `[->] Submitted to propagation node (stamp cost ${stampCost}, ` +
        `transient_id ${toHex(transientId).slice(0, 16)}…).`,
    );
  } catch (error) {
    console.error("[!] Propagation delivery failed:", error.message);
  }
}

/**
 * Opens a Link to the recipient and delivers the message over it.
 *
 * @param {Reticulum} rns
 * @param {LXMRouter} lxmf
 * @param {import("@reticulum/core/src/core/identity.js").Identity} senderIdentity
 * @param {Uint8Array} targetHash
 * @param {import("@reticulum/core/src/core/identity.js").Identity} peerIdentity
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

    // lxmf.send() identifies on the initiator link once (tracked internally)
    // before the message DATA — Python's LXMRouter otherwise drops packets
    // that arrive before LINKIDENTIFY (LINKS.md §6.7.6).
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
