/**
 * @file transport.js
 * @description Basic Transport implementation for managing interfaces and framing
 */

import { createRNSFramerStream, createRNSUnframerStream } from './framer.js';
import { Packet, PacketType } from '../core/packet.js';

/**
 * A basic Transport implementation that manages an Interface and handles framing.
 */
export class Transport extends EventTarget {
    /**
     * @param {import('../interfaces/base.js').Interface} interface - The underlying interface.
     */
    constructor(interface) {
        super();
        this.interface = interface;
        this.destinations = new Map(); // destination_hash -> Destination

        // Setup inbound stream: interface (bytes) -> framer (Packets)
        this.unframer = createRNSUnframerStream(Packet);
        this.inboundReader = this.interface.readable
            .pipeThrough(this.unframer)
            .getReader();

        // Setup outbound stream: Packets -> framer (bytes) -> interface (bytes)
        this.outboundFramer = createRNSFramerStream(Packet);
        this.outboundWriter = this.outboundFramer.writable.getWriter();
        this.outboundFramer.readable.pipeTo(this.interface.writable);

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
            this.dispatchEvent(new CustomEvent('error', { detail: e }));
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
        // Dispatch to destination if it's a link request or proof
        if (packet.packetType === PacketType.LINKREQUEST || packet.packetType === PacketType.PROOF) {
            const destination = this.destinations.get(packet.destinationHash);
            if (destination) {
                const eventName = packet.packetType === PacketType.LINKREQUEST ? 'linkrequest' : 'linkproof';
                destination.dispatchEvent(new CustomEvent(eventName, {
                    detail: { packet }
                }));
            }
        }
    }
}
