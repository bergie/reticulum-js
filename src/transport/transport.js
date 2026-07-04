/**
 * @file transport.js
 * @description Basic Transport implementation for managing interfaces and framing
 */

import { Packet, PacketType } from "../core/packet.js";
import { createRNSFramerStream, createRNSUnframerStream } from "./framer.js";
import { RoutingTable } from "./router.js";

/**
 * A basic Transport implementation that manages an Interface and handles framing.
 */
export class Transport extends EventTarget {
	/**
	 * @param {import('../interfaces/base.js').Interface} iface - The underlying interface.
	 */
	constructor(iface) {
		super();
		this.interface = iface;
		this.destinations = new Map(); // destination_hash -> Destination

		// Setup inbound stream: interface (bytes) -> framer (Packets)
		const readable = this.interface.readable;
		if (!readable)
			throw new Error("Interface readable stream is not available");
		this.unframer = createRNSUnframerStream(Packet);
		this.inboundReader = readable.pipeThrough(this.unframer).getReader();

		// Setup outbound stream: Packets -> framer (bytes) -> interface (bytes)
		const writable = this.interface.writable;
		if (!writable)
			throw new Error("Interface writable stream is not available");
		this.outboundFramer = createRNSFramerStream(Packet);
		this.outboundWriter = this.outboundFramer.writable.getWriter();
		this.outboundFramer.readable.pipeTo(writable);

		this._startInboundLoop();
	}

	/**
	 * Starts the loop that reads from the inbound stream.
	 * @private
	 */
	async _startInboundLoop() {
		try {
			while (true) {
				const { value: packet, done } = await this.inboundReader.read();
				if (done) break;
				await this.handleInboundPacket(packet);
			}
		} catch (e) {
			this.dispatchEvent(new CustomEvent("error", { detail: e }));
		}
	}

	/**
	 * Registers a destination to receive events from this transport.
	 * @param {import('../core/destination.js').Destination} destination
	 */
	registerDestination(destination) {
		this.destinations.set(destination.destinationHash, destination);
	}

	/**
	 * The stream of incoming packets.
	 * @type {ReadableStream<import('../core/packet.js').Packet>}
	 */
	get inboundStream() {
		const transport = this;
		return new ReadableStream({
			async pull(controller) {
				const { value, done } = await transport.inboundReader.read();
				if (done) {
					controller.close();
					return;
				}
				controller.enqueue(value);
			},
			cancel() {
				transport.inboundReader.cancel();
			},
		});
	}

	/**
	 * The stream of outgoing packets.
	 * @type {WritableStream<import('../core/packet.js').Packet>}
	 */
	get outboundStream() {
		const transport = this;
		return new WritableStream({
			async write(packet) {
				await transport.sendPacket(packet);
			},
		});
	}

	/**
	 * Sends a packet through the interface.
	 * @param {import('../core/packet.js').Packet} packet
	 */
	async sendPacket(packet) {
		await this.outboundWriter.write(packet);
	}

	/**
	 * Handles an incoming packet from the interface.
	 * @param {import('../core/packet.js').Packet} packet
	 * @private
	 */
	async handleInboundPacket(packet) {
		// Dispatch to destination if it's a link request, response or proof
		if (
			packet.packetType === PacketType.LINKREQUEST ||
			packet.packetType === PacketType.LINKRESPONSE ||
			packet.packetType === PacketType.PROOF
		) {
			const destination = this.destinations.get(packet.destinationHash);
			if (destination) {
				const eventName =
					packet.packetType === PacketType.LINKREQUEST
						? "linkrequest"
						: packet.packetType === PacketType.LINKRESPONSE
							? "link_response"
							: "linkproof";
				destination.dispatchEvent(
					new CustomEvent(eventName, {
						detail: { packet },
					}),
				);
			}
		}
	}
}

// src/transport/transport.js
export class TransportCore {
	constructor() {
		this.interfaces = new Set();
		this.routingTable = new RoutingTable();
		// A "catch-all" interface for destinations not in the routing table
		this.defaultInterface = null;
	}

	addInterface(rnsInterface, isDefault = false) {
		this.interfaces.add(rnsInterface);

		if (isDefault) {
			this.defaultInterface = rnsInterface;
		}

		// 1. Ingest packets from the interface
		rnsInterface.addEventListener("packet", (event) => {
			this._handleIncomingPacket(event.detail.packet, rnsInterface);
		});

		// 2. The Failover Trigger: Interface Disconnection
		rnsInterface.addEventListener("closed", () => {
			console.warn(
				`Interface ${rnsInterface.name} closed. Triggering failover.`,
			);
			this.interfaces.delete(rnsInterface);

			if (this.defaultInterface === rnsInterface) {
				this.defaultInterface = null; // We lost our default gateway
			}

			// Immediately scrub the routing table.
			// Subsequent packets will automatically seek alternative routes.
			this.routingTable.dropInterface(rnsInterface);
		});
	}

	_handleIncomingPacket(packet, receivingInterface) {
		// If this is an Announce packet (Packet Type 0x01)
		if (packet.type === PACKET_TYPE_ANNOUNCE) {
			// Note: In a real implementation, you increment packet.hops by 1 here
			this.routingTable.addOrUpdateRoute(
				packet.destinationHash,
				receivingInterface,
				packet.hops,
			);
		}
		// ... handle data packets ...
	}
}
