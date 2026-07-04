/**
 * @file packet.js
 * @description Binary serialization/deserialization for Reticulum packets
 */

import { toHex } from "../utils/encoding.js";

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
	 * @param {number} options.headerType
	 * @param {number} options.hops
	 * @param {number} options.transportType
	 * @param {number} options.destinationType
	 * @param {number} options.packetType
	 * @param {boolean} options.contextFlag
	 * @param {Uint8Array} options.destinationHash
	 * @param {Uint8Array} [options.sourceHash]
	 * @param {number} options.contextByte
	 * @param {Uint8Array} options.payload
	 * @param {Uint8Array} [options.ifac]
	 * @param {Uint8Array} [options.transportId]
	 * @param {Uint8Array} [options.raw]
	 */
	constructor(options) {
		this.headerType = options.headerType || HeaderType.HEADER_1;
		this.hops = options.hops || 0;
		this.transportType = options.transportType || 0;
		this.destinationType = options.destinationType || 0;
		this.packetType = options.packetType || PacketType.DATA;
		this.contextFlag = options.contextFlag || false;
		this.destinationHash = options.destinationHash;
		this.sourceHash = options.sourceHash || new Uint8Array(16);
		this.contextByte = options.contextByte || 0x00;
		this.payload = options.payload || new Uint8Array(0);
		this.ifac = options.ifac;
		this.transportId = options.transportId;
		this.raw = options.raw || new Uint8Array(0);
	}

	_buildFlagsByte() {
		let flags = 0x00;
		if (this.ifac) flags |= 0x80;
		if (this.headerType === HeaderType.HEADER_2) flags |= 0x40;
		if (this.contextFlag) flags |= 0x20;
		if (this.transportType === 1) flags |= 0x10;
		// Fix: Mask to 2 bits (0x03) before shifting
		flags |= (this.destinationType & 0x03) << 2;
		// Fix: Mask to 2 bits (0x03) so it doesn't overwrite destinationType
		flags |= this.packetType & 0x03;
		return flags;
	}

	serialize() {
		const flags = this._buildFlagsByte();

		// Calculate total length conditionally
		let length = 2; // flags + hops
		if (this.ifac) length += this.ifac.length;
		if (this.headerType === HeaderType.HEADER_2) length += 16;
		length += 16; // destination_hash
		length += 16; // source_hash

		// Fix: Only add length for contextByte if flag is TRUE
		if (this.contextFlag) length += 1;

		length += this.payload.length;

		const buffer = new ArrayBuffer(length);
		const uint8 = new Uint8Array(buffer);

		uint8[0] = flags;
		uint8[1] = this.hops & 0xff;

		let offset = 2;
		if (this.ifac) {
			uint8.set(this.ifac, offset);
			offset += this.ifac.length;
		}

		if (this.headerType === HeaderType.HEADER_2 && this.transportId) {
			uint8.set(this.transportId, offset);
			offset += 16;
		}

		uint8.set(this.destinationHash, offset);
		offset += 16;

		uint8.set(this.sourceHash, offset);
		offset += 16;

		// Fix: Only write the contextByte if flag is TRUE
		if (this.contextFlag) {
			uint8[offset] = this.contextByte;
			offset += 1;
		}

		uint8.set(this.payload, offset);

		return uint8;
	}

	static deserialize(data, ifacSize = 0) {
		if (data.length < 3) throw new Error("Packet too short");

		const flags = data[0];
		console.log(
			`[FORENSICS] Flags Binary: ${flags.toString(2).padStart(8, "0")}`,
		);
		const ifacFlag = (flags & 0x80) !== 0;
		const headerType =
			(flags & 0x40) !== 0 ? HeaderType.HEADER_2 : HeaderType.HEADER_1;
		const contextFlag = (flags & 0x20) !== 0;
		const transportType = (flags & 0x10) !== 0 ? 1 : 0;
		const destinationType = (flags & 0x0c) >> 2;
		// Fix: Mask to 2 bits
		const packetType = flags & 0x03;

		const hops = data[1];

		let offset = 2;
		let ifac;
		if (ifacFlag) {
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

		const sourceHash = data.slice(offset, offset + 16);
		offset += 16;

		// Fix: Only extract contextByte if flag is TRUE
		let contextByte = 0x00;
		if (contextFlag) {
			contextByte = data[offset];
			offset += 1;
		}

		const payload = data.slice(offset);

		return new Packet({
			headerType,
			hops,
			transportType,
			destinationType,
			packetType,
			contextFlag,
			destinationHash,
			sourceHash,
			contextByte,
			payload,
			ifac: ifac,
			transportId: transportId ?? undefined,
		});
	}
}
