/**
 * @file resource.js
 * @description Resource chunking and reassembly API
 */

import { Packet, ContextType } from "../core/packet.js";
import { ResourceAdvertisement } from "./resource_advertisement.js";

/**
 * @enum {number}
 */
export const ResourceStatus = {
	NONE: 0,
	QUEUED: 1,
	ADVERTISED: 2,
	TRANSFERRING: 3,
	AWAITING_PROOF: 4,
	COMPLETE: 5,
	FAILED: 6,
	CORRUPT: 7,
	REJECTED: 8,
};

/**
 * Represents a Reticulum Resource.
 * A Resource allows for transferring arbitrary amounts of data over a link,
 * handling chunking, sequencing, and reassembly.
 */
export class Resource extends EventTarget {
	/**
	 * @param {Object} options
	 * @param {Uint8Array|ReadableStream|null} [options.data] - The data to be transferred.
	 * @param {import("../transport/link.js").Link} [options.link] - The link to use.
	 * @param {boolean} [options.advertise=true] - Whether to automatically advertise the resource.
	 * @param {boolean} [options.auto_compress=true] - Whether to auto-compress the resource.
	 * @param {Function} [options.callback] - Callback when transfer concludes.
	 * @param {Function} [options.progress_callback] - Callback for progress updates.
	 * @param {number} [options.timeout] - Timeout for the transfer.
	 * @param {number} [options.segment_index=1] - The segment index (for split resources).
	 * @param {Uint8Array} [options.original_hash] - The hash of the original resource.
	 * @param {Uint8Array} [options.request_id] - The ID of the associated request.
	 * @param {boolean} [options.is_response=false] - Whether this is a response resource.
	 * @param {number} [options.sent_metadata_size=0] - Size of metadata sent with the first segment.
	 */
	constructor(options = {}) {
		super();
		this.data = options.data || null;
		this.link = options.link || null;
		this.advertise = options.advertise ?? true;
		this.auto_compress = options.auto_compress ?? true;
		this.callback = options.callback || null;
		this.progress_callback = options.progress_callback || null;
		this.timeout = options.timeout || null;
		this.segment_index = options.segment_index || 1;
		this.original_hash = options.original_hash || null;
		this.request_id = options.request_id || null;
		this.is_response = options.is_response || false;
		this.sent_metadata_size = options.sent_metadata_size || 0;

		this.status = ResourceStatus.NONE;
		this.parts = [];
		this.received_count = 0;
		this.outstanding_parts = 0;
		this.total_parts = 0;
		this.total_size = 0;
		this.size = 0; // Transfer size
		this.hash = null;
		this.random_hash = null;
		this.compressed = false;
		this.encrypted = false;
		this.split = false;
		this.has_metadata = false;
		this.metadata = null;

		if (this.data) {
			this._prepareSender();
		}
	}

	/**
	 * Prepares the resource for sending.
	 * @private
	 */
	_prepareSender() {
		if (!this.data) return;

		// Determine SDU size (Maximum Data Unit)
		const mdu = this.link?.mtu || 1024; 
		const sdu = mdu - 128; // Leave room for headers

		if (this.data instanceof Uint8Array) {
			const total_len = this.data.length;
			this.total_size = total_len;
			this.total_parts = Math.ceil(total_len / sdu);
			this.size = this.total_parts;

			for (let i = 0; i < this.total_parts; i++) {
				const start = i * sdu;
				const end = Math.min(start + sdu, total_len);
				this.parts.push(this.data.slice(start, end));
			}
		} else {
			throw new Error("Unsupported data type for resource preparation");
		}
	}

	/**
	 * Advertises the resource to the link.
	 * @async
	 */
	async advertise() {
		if (!this.link) throw new Error("Link is required for advertisement");
		if (this.status !== ResourceStatus.NONE) throw new Error("Resource already advertised or in progress");

		this.status = ResourceStatus.QUEUED;

		// 1. Create ResourceAdvertisement
		const adv = new ResourceAdvertisement({
			t: this.total_size,
			d: this.total_size,
			n: this.total_parts,
			h: this.hash || new Uint8Array(32),
			r: this.random_hash || new Uint8Array(16),
			o: this.original_hash || new Uint8Array(32),
			i: this.segment_index,
			l: this.total_parts,
			q: this.request_id,
			f: 0, // flags
		});

		const advPayload = adv.pack();

		// 2. Send via Link with CONTEXT_RESOURCE_ADV
		const packet = new Packet({
			headerType: 0, // HEADER_1
			hops: 0,
			transportType: 0,
			destinationType: 3, // LINK
			packetType: 0, // DATA
			contextFlag: true,
			contextByte: ContextType.RESOURCE_ADV,
			destinationHash: this.link.destinationHash,
			payload: advPayload,
		});

		try {
			const writer = this.link.writable.getWriter();
			await writer.write(packet);
			writer.releaseLock();
			this.status = ResourceStatus.ADVERTISED;
		} catch (e) {
			this.status = ResourceStatus.FAILED;
			throw e;
		}
	}

	/**
	 * Handles an incoming resource advertisement.
	 * @param {import("../transport/link.js").Link} link
	 * @param {Packet} advertisementPacket
	 * @returns {Resource|null}
	 */
	static accept(link, advertisementPacket) {
		try {
			const adv = ResourceAdvertisement.unpack(advertisementPacket.payload);

			const resource = new Resource({
				link: link,
				request_id: adv.q,
				is_response: true,
			});

			resource.status = ResourceStatus.TRANSFERRING;
			resource.total_size = adv.t;
			resource.total_parts = adv.n;
			resource.hash = adv.h;
			resource.random_hash = adv.r;
			resource.original_hash = adv.o;
			resource.segment_index = adv.i;
			resource.split = adv.s;
			resource.has_metadata = adv.x;
			resource.compressed = adv.c;
			resource.encrypted = adv.e;

			if (resource.is_response) {
				resource.parts = new Array(resource.total_parts).fill(null);
				resource.received_count = 0;
				resource.outstanding_parts = resource.total_parts;
			}

			// Register with the link
			link.register_incoming_resource(resource);

			return resource;
		} catch (e) {
			console.error("Failed to accept resource advertisement:", e);
			return null;
		}
	}

	/**
	 * Processes an incoming resource part.
	 * @param {Packet} packet
	 */
	receivePart(packet) {
		if (this.status !== ResourceStatus.TRANSFERRING && this.status !== ResourceStatus.ADVERTISED) {
			return;
		}

		// For a response, parts are identified by their index in the hashmap or similar.
		// In this simplified implementation, we assume parts arrive in order for now.
		// A real implementation would use the hashmap to place parts correctly.
		
		const partData = packet.payload;
		this.parts.push(partData);
		this.received_count++;
		this.outstanding_parts--;

		if (this.received_count === this.total_parts) {
			this._assemble();
		}
	}

	/**
	 * Assembles the received parts.
	 * @private
	 */
	async _assemble() {
		this.status = ResourceStatus.ASSEMBLING;
		try {
			const assembledData = this._concatenateParts(this.parts);
			// In a real implementation, we would verify the hash here.
			
			this.data = assembledData;
			this.status = ResourceStatus.COMPLETE;

			if (this.callback) {
				this.callback(this);
			}
			if (this.progress_callback) {
				this.progress_callback(this);
			}
		} catch (e) {
			this.status = ResourceStatus.CORRUPT;
			console.error("Failed to assemble resource:", e);
		}
	}

	/**
	 * Concatenates an array of Uint8Arrays.
	 * @param {Uint8Array[]} parts
	 * @returns {Uint8Array}
	 * @private
	 */
	_concatenateParts(parts) {
		const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const part of parts) {
			result.set(part, offset);
			offset += part.length;
		}
		return result;
	}

	/**
	 * Gets the current progress of the resource transfer as a float between 0.0 and 1.0.
	 * @returns {number}
	 */
	getProgress() {
		if (this.total_parts === 0) return 0;
		return this.received_count / this.total_parts;
	}
}
