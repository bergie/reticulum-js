/**
 * @file packet.js
 * @description Binary serialization/deserialization
 */

import { Destination } from "./destination.js";

/**
 * Packet types.
 * @enum {number}
 */
export const PacketType = {
	DATA: 0x00,
	ANNOUNCE: 0x01,
	LINKREQUEST: 0x02,
	LINKRESPONSE: 0x04,
	PROOF: 0x03,
};

/**
 * Header types.
 * @enum {number}
 */
export const HeaderType = {
	HEADER_1: 0x00,
	HEADER_2: 0x01,
};

/**
 * Context types.
 * @enum {number}
 */
export const ContextType = {
	NONE: 0x00,
	RESOURCE: 0x01,
	REQUEST: 0x02,
	RESPONSE: 0x03,
	RESOURCE_ADV: 0x04,
	RESOURCE_REQ: 0x05,
	RESOURCE_HMU: 0x06,
	RESOURCE_ICL: 0x07,
	RESOURCE_RCL: 0x08,
	RESOURCE_PRF: 0x09,
};

/**
 * Destination types.
 * @enum {number}
 */
export const DestType = {
	SINGLE: 0x00,
	GROUP: 0x01,
	PLAIN: 0x02,
	LINK: 0x03,
};

/**
 * Represents a Reticulum packet.
 */
export class Packet {
	/**
	 * @param {Object} options
	 * @param {number} options.headerType - HEADER_1 or HEADER_2
	 * @param {number} options.hops - Hop count
	 * @param {number} options.transportType - BROADCAST or TRANSPORT
	 * @param {number} options.destinationType - SINGLE, GROUP, PLAIN, or LINK
	 * @param {number} options.packetType - DATA, ANNOUNCE, LINKREQUEST, or PROOF
	 * @param {boolean} options.contextFlag - if true, context byte is present
	 * @param {Uint8Array} options.destinationHash - 16-byte destination hash
	 * @param {number} options.contextByte - 1-byte context
	 * @param {Uint8Array} options.payload - payload bytes
	 * @param {Uint8Array} [options.ifac] - Optional IFAC field
	 * @param {Uint8Array} [options.transportId] - 16-byte transport identity hash (for HEADER_2)
	 */
	constructor(options) {
		this.headerType = options.headerType || HeaderType.HEADER_1;
		this.hops = options.hops || 0;
		this.transportType = options.transportType || 0;
		this.destinationType = options.destinationType || DestType.SINGLE;
		this.packetType = options.packetType || PacketType.DATA;
		this.contextFlag = options.contextFlag || false;
		this.destinationHash = options.destinationHash;
		this.contextByte = options.contextByte || 0x00;
		this.payload = options.payload || new Uint8Array(0); // Default to empty buffer;
		this.ifac = options.ifac;
		this.transportId = options.transportId;
	}

	/**
	 * Builds the flags byte (Byte 0).
	 * @private
	 * @returns {number}
	 */
	_buildFlagsByte() {
		let flags = 0x00;
		if (this.ifac) flags |= 0x80;
		if (this.headerType === HeaderType.HEADER_2) flags |= 0x40;
		if (this.contextFlag) flags |= 0x20;
		if (this.transportType === 1) flags |= 0x10; // 1 = TRANSPORT
		flags |= (this.destinationType & 0x03) << 2;
		flags |= this.packetType & 0x0f;
		return flags;
	}

	/**
	 * Serializes the packet to a Uint8Array.
	 * @returns {Uint8Array}
	 */
	serialize() {
		const flags = this._buildFlagsByte();

		// Calculate total length
		let length = 2; // flags + hops
		if (this.ifac) {
			length += this.ifac.length;
		}
		if (this.headerType === HeaderType.HEADER_2) {
			length += 16; // transport_id
		}
		length += 16; // destination_hash
		length += 1; // contextByte
		length += this.payload.length;

		const buffer = new ArrayBuffer(length);
		const uint8 = new Uint8Array(buffer);

		uint8[0] = flags;
		uint8[1] = this.hops & 0xff;

		let offset = 2;
		if (this.ifac) {
			/** @type {any} */
			const ifac = this.ifac;
			uint8.set(ifac, offset);
			offset += ifac.length;
		}

		if (this.headerType === HeaderType.HEADER_2 && this.transportId) {
			/** @type {any} */
			const tid = this.transportId;
			uint8.set(tid, offset);
			offset += 16;
		}

		/** @type {any} */
		const dHash = this.destinationHash;
		uint8.set(dHash, offset);
		offset += 16;

		uint8[offset] = this.contextByte;
		offset += 1;

		/** @type {any} */
		const pLoad = this.payload;
		uint8.set(pLoad, offset);

		return uint8;
	}

	/**
	 * Deserializes a packet from a Uint8Array.
	 * @param {Uint8Array} data
	 * @param {number} [ifacSize] - Optional size of the IFAC field if present
	 * @returns {Packet}
	 */
	static deserialize(data, ifacSize = 0) {
		if (data.length < 3) throw new Error("Packet too short");

		const flags = data[0];
		const ifacFlag = (flags & 0x80) !== 0;
		const headerType =
			(flags & 0x40) !== 0 ? HeaderType.HEADER_2 : HeaderType.HEADER_1;
		const contextFlag = (flags & 0x20) !== 0;
		const transportType = (flags & 0x10) !== 0 ? 1 : 0;
		const destinationType = (flags & 0x0c) >> 2;
		const packetType = flags & 0x0f;

		const hops = data[1];

		let offset = 2;
		let ifac;
		if (ifacFlag) {
			if (ifacSize === 0) {
				throw new Error("ifacSize must be provided when ifacFlag is set");
			}
			ifac = data.slice(offset, offset + ifacSize);
			offset += ifacSize;
		}

		let transportId = null;
		if (headerType === HeaderType.HEADER_2) {
			transportId = data.slice(offset, offset + 16);
			offset += 16;
		}

		const destinationHash = data.slice(offset, offset + 16);
		offset += 16;

		const contextByte = data[offset];
		offset += 1;

		const payload = data.slice(offset);

		return new Packet({
			headerType,
			hops,
			transportType,
			destinationType,
			packetType,
			contextFlag,
			destinationHash,
			contextByte,
			payload,
			ifac: ifac,
			transportId: transportId ?? undefined,
		});
	}
}
