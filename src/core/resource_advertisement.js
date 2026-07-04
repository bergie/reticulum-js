/**
 * @file resource_advertisement.js
 * @description Resource advertisement encoding/decoding
 */

import { MicroMsgPack } from "../utils/msgpack.js";

/**
 * @enum {number}
 */
export const ResourceAdvertisementStatus = {
	NONE: 0x00,
	QUEUED: 0x01,
	ADVERTISED: 0x02,
	TRANSFERRING: 0x03,
	AWAITING_PROOF: 0x04,
	COMPLETE: 0x05,
	FAILED: 0x06,
	CORRUPT: 0x07,
	REJECTED: 0x00,
};

/**
 * Constants for Resource Advertisement.
 */
export const ResourceAdvertisementConstants = {
	HASHMAP_MAX_LEN: 10, // Placeholder, should be calculated based on MTU
	COLLISION_GUARD_SIZE: 20, // Placeholder
};

/**
 * Represents a Resource Advertisement.
 * This class handles the packing and unpacking of resource advertisement data.
 *
 * NOTE: The Python implementation uses MessagePack (umsgpack).
 */
export class ResourceAdvertisement {
	/**
	 * @param {Object} options
	 * @param {number} [options.t] - Transfer size
	 * @param {number} [options.d] - Total uncompressed data size
	 * @param {number} [options.n] - Number of parts
	 * @param {Uint8Array} [options.h] - Resource hash
	 * @param {Uint8Array} [options.r] - Resource random hash
	 * @param {Uint8Array} [options.o] - Original hash (first-segment hash)
	 * @param {number} [options.i] - Segment index
	 * @param {number} [options.l] - Total segments
	 * @param {Uint8Array} [options.q] - Associated request ID
	 * @param {number} [options.f] - Resource flags
	 * @param {Uint8Array} [options.m] - Resource hashmap
	 * @param {boolean} [options.u] - Is request flag
	 * @param {boolean} [options.p] - Is response flag
	 * @param {boolean} [options.x] - Has metadata flag
	 * @param {boolean} [options.c] - Compression flag
	 * @param {boolean} [options.e] - Encryption flag
	 * @param {boolean} [options.s] - Split flag
	 */
	constructor(options = {}) {
		this.t = options.t || 0;
		this.d = options.d || 0;
		this.n = options.n || 0;
		this.h = options.h || new Uint8Array(0);
		this.r = options.r || new Uint8Array(0);
		this.o = options.o || new Uint8Array(0);
		this.i = options.i || 0;
		this.l = options.l || 0;
		this.q = options.q || undefined;
		this.f = options.f || 0;
		this.m = options.m || new Uint8Array(0);

		// Flags decoded from 'f'
		this.x = !!((this.f >> 5) & 0x01); // has_metadata
		this.p = !!((this.f >> 4) & 0x01); // is_response
		this.u = !!((this.f >> 3) & 0x01); // is_request
		this.s = !!((this.f >> 2) & 0x01); // is_split
		this.c = !!((this.f >> 1) & 0x01); // is_compressed
		this.e = !!(this.f & 0x01); // is_encrypted
	}

	/**
	 * Pack the advertisement into a Uint8Array.
	 *
	 * @returns {Uint8Array}
	 */
	pack() {
		const dict = {
			t: this.t,
			d: this.d,
			n: this.n,
			h: Array.from(this.h),
			r: Array.from(this.r),
			o: Array.from(this.o),
			i: this.i,
			l: this.l,
			q: this.q ? Array.from(this.q) : null,
			f: this.f,
			m: Array.from(this.m),
		};
		return MicroMsgPack.encode(dict);
	}

	/**
	 * Unpack an advertisement from a Uint8Array.
	 *
	 * @param {Uint8Array} data
	 * @returns {ResourceAdvertisement}
	 */
	static unpack(data) {
		/** @type {any} */
		const dict = MicroMsgPack.decode(data);

		return new ResourceAdvertisement(
			/** @type {any} */ ({
				t: dict.t,
				d: dict.d,
				n: dict.n,
				h: new Uint8Array(dict.h),
				r: new Uint8Array(dict.r),
				o: new Uint8Array(dict.o),
				i: dict.i,
				l: dict.l,
				q: dict.q ? new Uint8Array(dict.q) : undefined,
				f: dict.f,
				m: new Uint8Array(dict.m),
			}),
		);
	}

	/**
	 * Check if the advertisement is a request.
	 * @param {ResourceAdvertisement} adv
	 * @returns {boolean}
	 */
	static isRequest(adv) {
		return adv.u;
	}

	/**
	 * Check if the advertisement is a response.
	 * @param {ResourceAdvertisement} adv
	 * @returns {boolean}
	 */
	static isResponse(adv) {
		return adv.p;
	}
}
