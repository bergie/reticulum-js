import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Identity,
  LXMessage,
  LXMRouter,
  Reticulum,
  TCPClientInterface,
  toHex,
} from "../src/index.js";

// A simple Node.js file storage adapter for the bot's private key
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

async function startEchoBot() {
  console.log("Starting LXMF Echo Bot...");

  // Initialize the Core RNS Engine
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter("./bot-identity.key"),
  });

  // Connect to the local Reticulum mesh daemon via TCP
  const tcpInterface = new TCPClientInterface({
    host: "127.0.0.1",
    port: 42424,
  });
  // Wait for the TCP connection to establish before proceeding
  await tcpInterface.connect();
  rns.addInterface(tcpInterface, true);

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
