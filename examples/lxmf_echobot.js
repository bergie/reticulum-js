import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	Identity,
	LXMRouter,
	Reticulum,
	TCPClientInterface,
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

	// 1. Initialize the Core RNS Engine
	const rns = new Reticulum({
		storageAdapter: new FileStorageAdapter("./bot-identity.key"),
	});

	// 2. Connect to the local Reticulum mesh daemon via TCP
	const tcpInterface = new TCPClientInterface({
		//host: "127.0.0.1",
		//port: 42424,
		host: "192.168.2.138",
		port: 4242,
	});
	// Wait for the TCP connection to establish before proceeding
	await tcpInterface.connect();
	rns.addInterface(tcpInterface);
	console.log("Connected to local RNS transport node.");

	// 3. Load or generate the Bot's Ed25519 Identity
	const botIdentity = await Identity.loadOrGenerate(rns.storage);
	console.log(
		`Bot Identity Hash: ${Buffer.from(botIdentity.identityHash).toString("hex")}`,
	);
	// Set the metadata
	const metadata = {
		name: "JS Echo Bot",
		version: "1.0.0",
		capabilities: ["echo", "lxmf"],
	};

	// Convert to bytes
	botIdentity.appData = new TextEncoder().encode(
		`${metadata.name} (${metadata.version})`,
	);

	// 4. Bind the LXMF Router to our Identity and Network Core
	// This automatically registers the 'lxmf.delivery' destination
	const lxmf = new LXMRouter(botIdentity, rns);
	await lxmf.init();
	console.log(
		`Bot Destination Hash: ${Buffer.from(lxmf.deliveryDest.destinationHash).toString("hex")}`,
	);

	// Announce the bot's presence to the mesh so clients know it's online
	await lxmf.deliveryDest.announce();
	console.log("Bot announced to the mesh. Listening for messages...");

	// 5. Handle Incoming Messages
	lxmf.addEventListener("message", async (event) => {
		const { source, title, content } = event.detail;

		const senderHashHex = Buffer.from(source.hash).toString("hex");
		const textContent = new TextDecoder().decode(content);

		console.log(`\n[+] Received message from ${senderHashHex}`);
		console.log(`    Title: ${title}`);
		console.log(`    Body:  ${textContent}`);

		// 6. Construct and Send the Echo Reply
		try {
			const replyText = `Echo: ${textContent}`;
			const replyBytes = new TextEncoder().encode(replyText);
			const replyTitle = title.startsWith("Re:") ? title : `Re: ${title}`;

			// Send the message back to the sender's destination hash
			await lxmf.send(source.hash, replyBytes, replyTitle);

			console.log(`[->] Echo sent back successfully.`);
		} catch (error) {
			console.error(`[!] Failed to route echo reply:`, error);
		}
	});
}

// Execute the bot
startEchoBot().catch(console.error);
