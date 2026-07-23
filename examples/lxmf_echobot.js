import {
  fromHex,
  Identity,
  LXMessage,
  LXMRouter,
  Reticulum,
  toHex,
} from "reticulum-js";
import {
  FileStorageAdapter,
  LocalClientInterface,
  TCPClientInterface,
} from "reticulum-js-node";

async function startEchoBot() {
  console.log("Starting LXMF Echo Bot...");

  // Initialize the Core RNS Engine
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter("./echobot-storage"),
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

  // Load or generate the Bot's Ed25519 Identity
  const botIdentity = await Identity.loadOrGenerate(rns.storage);
  console.log(`Bot Identity Hash: ${toHex(botIdentity.identityHash)}`);

  // Read our version string for the announce display name (§4.3 app_data).
  const { default: data } = await import("../package.json", {
    with: { type: "json" },
  });

  // Bind the LXMF Router to our Identity and Network Core
  // This automatically registers the 'lxmf.delivery' destination
  const lxmf = new LXMRouter(botIdentity, rns);
  await lxmf.init();
  console.log(
    `Bot Destination Hash: ${toHex(lxmf.deliveryDest.destinationHash)}`,
  );

  // Announce the bot's presence to the mesh. LXMRouter.announce attaches the
  // §4.3 msgpack app_data (display name as bin8 + stamp cost + capability
  // list) so peers like Sideband/Nomadnet display our name correctly.
  await lxmf.announce(`JS echo bot (${data.version})`);
  console.log("Bot announced to the mesh. Listening for messages...");

  // --------------------------------------------------------------------------
  // Propagation node role (store-and-forward, LXMF.md §5.8)
  //
  // The bot also acts as a propagation node: it stores encrypted messages for
  // offline peers and serves them over `/get`. The node runs with stamp cost 0
  // (open node) so no proof-of-work is required to submit.
  // --------------------------------------------------------------------------
  await lxmf.enablePropagation({
    stampCost: 0,
    stampCostFlexibility: 0,
    name: "JS echo PN",
  });
  await lxmf.announcePropagationNode();
  console.log(
    `Propagation node enabled: ${toHex(lxmf.propagationDest.destinationHash)}`,
  );

  // --------------------------------------------------------------------------
  // Optional: periodically sync our own messages from an upstream propagation
  // node (set LXMF_SYNC_NODE to its `lxmf.propagation` hash).
  // --------------------------------------------------------------------------
  const upstreamHex = process.env.LXMF_SYNC_NODE;
  if (upstreamHex) {
    lxmf.setOutboundPropagationNode(fromHex(upstreamHex));
    console.log(`Will sync from upstream node ${upstreamHex} every 60s.`);
    setInterval(async () => {
      try {
        const res = await lxmf.syncFromPropagationNode(botIdentity);
        if (res.received > 0) {
          console.log(
            `[sync] Downloaded ${res.received} message(s) from propagation node.`,
          );
        }
      } catch (err) {
        console.error("[sync] sync failed:", err.message);
      }
    }, 60000);
  }

  // Handle Incoming Messages
  lxmf.addEventListener("message", async (event) => {
    const message = event.detail.message;
    const link = event.detail.link;
    const senderHashHex = toHex(message.sourceHash);

    console.log(`\n[+] Received message from ${senderHashHex}`);
    if (message.title) {
      console.log(`    Title: ${message.title}`);
    }
    console.log(`    Body:  ${message.content}`);

    // Construct and Send the Echo Reply
    try {
      const reply = new LXMessage({
        sourceHash: lxmf.deliveryDest.destinationHash,
        destinationHash: message.sourceHash,
        content: `Echo: ${message.content}`,
        title: message.title.startsWith("Re:")
          ? message.title
          : `Re: ${message.title}`,
      });

      // Send the message back to the sender's destination hash
      await lxmf.send(reply, botIdentity, link);
      console.log(`[->] Echo sent back successfully.`);
    } catch (error) {
      console.error(`[!] Failed to route echo reply:`, error);
    }
  });
}

// Execute the bot
startEchoBot().catch(console.error);
