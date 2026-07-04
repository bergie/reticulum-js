// src/transport/transport.js

import { Destination } from "../core/destination.js";
import { PacketType } from "../core/packet.js";
import { RoutingTable } from "./router.js";

/**
 * @param {Uint8Array} buf
 * @returns {string}
 */
function bufToHex(buf) {
	return Array.from(buf)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * The central network router for the Reticulum node.
 * Routes packets emitted by Interfaces.
 */
export class TransportCore extends EventTarget {
	constructor() {
		super();
		this.interfaces = new Set();
		this.localDestinations = new Map();
		this.activeLinks = new Map();
		this.routingTable = new RoutingTable();
		this.defaultInterface = null;
	}

	/**
	 * Attaches an interface that emits "packet" events.
	 * @param {import("../interfaces/base.js").Interface} iface
	 * @param {boolean} isDefault
	 */
	addInterface(iface, isDefault = false) {
		this.interfaces.add(iface);
		if (isDefault) this.defaultInterface = iface;

		// 1. Hook into the Interface's existing outbound Framer
		// Since iface.writable is the input to the RNSFramerStream, we just get a writer for it
		if (!iface._packetWriter) {
			iface._packetWriter = iface.writable.getWriter();
		}

		// 2. Listen to the Interface's inbound Packet loop
		iface.addEventListener("packet", async (event) => {
			await this._routeIncomingPacket(event.detail.packet, iface);
		});

		// 3. Handle graceful teardown
		iface.addEventListener("closed", () => this.removeInterface(iface));
		iface.addEventListener("error", (e) =>
			console.error(`[!] Interface ${iface.name} error:`, e.detail),
		);

		console.log(`[+] Transport bound to interface: ${iface.name}`);
	}

	/**
	 * @param {import("../interfaces/base.js").Interface} iface
	 */
	removeInterface(iface) {
		if (iface._packetWriter) {
			iface._packetWriter.releaseLock();
		}
		this.interfaces.delete(iface);
		this.routingTable.dropInterface(iface);
		if (this.defaultInterface === iface) this.defaultInterface = null;
		console.warn(`[-] Interface removed: ${iface.name}`);
	}

	/**
	 * @param {Uint8Array} destinationHash
	 * @param {import("./link.js").Link} link
	 */
	addLink(destinationHash, link) {
		const hex = bufToHex(destinationHash);
		this.activeLinks.set(hex, link);
	}

	/**
	 * @param {Uint8Array} destinationHash
	 */
	removeLink(destinationHash) {
		const hex = bufToHex(destinationHash);
		this.activeLinks.delete(hex);
		console.log(`[-] Link closed for ${hex}`);
	}

	bindLocalDestination(destination) {
		const destHex = Buffer.from(destination.destinationHash).toString("hex");
		this.localDestinations.set(destHex, destination);
	}

	/**
	 * @param {import("../core/packet.js").Packet} packet
	 * @param {import("../interfaces/base.js").Interface} receivingInterface
	 */
	async _routeIncomingPacket(packet, receivingInterface) {
		if (packet.packetType === PacketType.ANNOUNCE) {
			this.routingTable.addOrUpdateRoute(
				packet.destinationHash,
				receivingInterface,
				packet.hops,
			);

			// Harvest the Identity Proof
			if (packet.payload && packet.payload.length >= 148) {
				const pubKey = packet.payload.slice(0, 64);
				const appData = packet.payload.slice(148);

				const packetHashBuffer = await globalThis.crypto.subtle.digest(
					"SHA-256",
					packet.serialize(),
				);
				const packetHash = new Uint8Array(packetHashBuffer).subarray(0, 16);

				console.log(
					`Received announce for ${packet.destinationHash} (${appData}`,
				);
				await Destination.remember(
					packetHash,
					packet.destinationHash,
					pubKey,
					appData,
				);
			}
			return;
		}

		if (packet.packetType === 0x00) {
			console.log(
				`\n\n[!!!] DATA PACKET RECEIVED: ${packet.payload.length} bytes [!!!]\n\n`,
			);
		} else if (packet.packetType === 0x02) {
			console.log(
				`\n\n[!!!] LINK REQUEST RECEIVED: Handshake incoming [!!!]\n\n`,
			);
		}
		const appPackets = [
			PacketType.DATA,
			PacketType.LINKREQUEST,
			PacketType.LINKRESPONSE,
			PacketType.PROOF,
		];

		if (appPackets.includes(packet.packetType)) {
			const destHex = Buffer.from(packet.destinationHash).toString("hex");

			if (this.localDestinations.has(destHex)) {
				const destination = this.localDestinations.get(destHex);
				await destination.receive(packet, receivingInterface);
				return;
			}
		}
	}

	broadcast(packet, sourceInterface = null) {
		for (const iface of this.interfaces) {
			if (iface === sourceInterface || !iface._packetWriter) continue;

			// Write the Packet object directly. The interface's Framer turns it into bytes.
			iface._packetWriter.write(packet).catch((err) => {
				console.error(`[!] Broadcast failed on ${iface.name}:`, err);
			});
		}
	}

	async sendPacket(packet) {
		const destHex = Buffer.from(packet.destinationHash).toString("hex");
		const nextHopInterface =
			this.routingTable.lookup(destHex) || this.defaultInterface;

		if (nextHopInterface && nextHopInterface._packetWriter) {
			await nextHopInterface._packetWriter.write(packet);
		} else {
			throw new Error(`No route to host: ${destHex}`);
		}
	}
}
