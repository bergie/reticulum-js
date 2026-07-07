/**
 * @file resource.js
 * @description Resource chunking and reassembly API
 */

import { ContextType, Packet } from "../core/packet.js";
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
  ASSEMBLING: 9,
};

/**
 * @typedef {Object} Bzip2
 * @property {function(Uint8Array): Uint8Array} compress
 * @property {function(Uint8Array, number): Uint8Array} decompress
 */

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
   * @param {boolean} [options.autoAdvertise=true] - Whether to automatically advertise the resource.
   * @param {boolean} [options.autoCompress=true] - Whether to auto-compress the resource.
   * @param {Function} [options.callback] - Callback when transfer concludes.
   * @param {Function} [options.progressCallback] - Callback for progress updates.
   * @param {number} [options.timeout] - Timeout for the transfer.
   * @param {number} [options.segmentIndex=1] - The segment index (for split resources).
   * @param {Uint8Array} [options.originalHash] - The hash of the original resource.
   * @param {Uint8Array} [options.requestId] - The ID of the associated request.
   * @param {boolean} [options.isResponse=false] - Whether this is a response resource.
   * @param {number} [options.sentMetadataSize=0] - Size of metadata sent with the first segment.
   * @param {Bzip2} [options.bz2] - Bzip2 implementation.
   */
  constructor(options = {}) {
    super();
    /** @type {Uint8Array|ReadableStream|undefined} */
    this.data = options.data || undefined;
    /** @type {import("../transport/link.js").Link|undefined} */
    this.link = options.link || undefined;
    /** @type {boolean} */
    this.autoAdvertise = options.autoAdvertise ?? true;
    /** @type {boolean} */
    this.autoCompress = options.autoCompress ?? true;
    /** @type {Function|undefined} */
    this.callback = options.callback || undefined;
    /** @type {Function|undefined} */
    this.progressCallback = options.progressCallback || undefined;
    /** @type {number|undefined} */
    this.timeout = options.timeout || undefined;
    /** @type {number} */
    this.segmentIndex = options.segmentIndex || 1;
    /** @type {Uint8Array|undefined} */
    this.originalHash = options.originalHash || undefined;
    /** @type {Uint8Array|undefined} */
    this.requestId = options.requestId || undefined;
    /** @type {boolean} */
    this.isResponse = options.isResponse || false;
    /** @type {number} */
    this.sentMetadataSize = options.sentMetadataSize || 0;
    /** @type {Bzip2|undefined} */
    this.bz2 = options.bz2 || undefined;
    /** @type {number} */
    this.uncompressedSize = 0;

    /** @type {number} */
    this.status = ResourceStatus.NONE;
    /** @type {(Uint8Array|null)[]} */
    this.parts = [];
    /** @type {number} */
    this.receivedCount = 0;
    /** @type {number} */
    this.outstandingParts = 0;
    /** @type {number} */
    this.totalParts = 0;
    /** @type {number} */
    this.totalSize = 0;
    /** @type {number} */
    this.size = 0; // Transfer size
    /** @type {Uint8Array|undefined} */
    this.hash = undefined;
    /** @type {Uint8Array|undefined} */
    this.randomHash = undefined;
    /** @type {boolean} */
    this.compressed = false;
    /** @type {boolean} */
    this.encrypted = false;
    /** @type {boolean} */
    this.split = false;
    /** @type {boolean} */
    this.hasMetadata = false;
    /** @type {Uint8Array|undefined} */
    this.metadata = undefined;

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
      let data = this.data;
      const original_len = data.length;

      if (this.autoCompress && this.bz2) {
        data = this.bz2.compress(data);
        this.data = data;
        this.compressed = true;
      }

      this.uncompressedSize = original_len;
      const total_len = data.length;
      this.totalSize = total_len;
      this.totalParts = Math.ceil(total_len / sdu);
      this.size = this.totalParts;

      for (let i = 0; i < this.totalParts; i++) {
        const start = i * sdu;
        const end = Math.min(start + sdu, total_len);
        this.parts.push(data.slice(start, end));
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
    if (this.status !== ResourceStatus.NONE)
      throw new Error("Resource already advertised or in progress");

    this.status = ResourceStatus.QUEUED;

    // 1. Create ResourceAdvertisement
    let f = 0;
    if (this.hasMetadata) f |= 1 << 5;
    if (this.isResponse) f |= 1 << 4;
    if (this.split) f |= 1 << 2;
    if (this.compressed) f |= 1 << 1;
    if (this.encrypted) f |= 1 << 0;

    const adv = new ResourceAdvertisement({
      t: this.totalSize,
      d: this.uncompressedSize,
      n: this.totalParts,
      h: this.hash || new Uint8Array(32),
      r: this.randomHash || new Uint8Array(16),
      o: this.originalHash || new Uint8Array(32),
      i: this.segmentIndex,
      l: this.totalParts,
      q: this.requestId,
      f: f,
      m: new Uint8Array(0),
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
      destinationHash: this.link.linkId,
      payload: advPayload,
    });

    try {
      await this.link.send(packet);
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
   * @param {Object} [options] - Optional configuration for the resource.
   * @param {Bzip2} [options.bz2] - Bzip2 implementation for decompression.
   * @returns {Resource|null}
   */
  static accept(link, advertisementPacket, options = {}) {
    try {
      const adv = ResourceAdvertisement.unpack(advertisementPacket.payload);

      const resource = new Resource({
        link: link,
        requestId: adv.q,
        isResponse: true,
        bz2: options.bz2,
      });

      resource.status = ResourceStatus.TRANSFERRING;
      resource.totalSize = adv.t;
      resource.totalParts = adv.n;
      resource.hash = adv.h;
      resource.randomHash = adv.r;
      resource.originalHash = adv.o;
      resource.segmentIndex = adv.i;
      resource.split = adv.s;
      resource.hasMetadata = adv.x;
      resource.compressed = adv.c;
      resource.encrypted = adv.e;
      resource.uncompressedSize = adv.d;

      if (resource.isResponse) {
        resource.parts = new Array(resource.totalParts).fill(null);
        resource.receivedCount = 0;
        resource.outstandingParts = resource.totalParts;
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
    if (
      this.status !== ResourceStatus.TRANSFERRING &&
      this.status !== ResourceStatus.ADVERTISED
    ) {
      return;
    }

    // For a response, parts are identified by their index in the hashmap or similar.
    // In this simplified implementation, we assume parts arrive in order for now.
    // A real implementation would use the hashmap to place parts correctly.

    const partData = packet.payload;
    this.parts.push(partData);
    this.receivedCount++;
    this.outstandingParts--;

    if (this.receivedCount === this.totalParts) {
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
      let assembledData = this._concatenateParts(this.parts);

      if (this.compressed && this.bz2) {
        assembledData = this.bz2.decompress(
          assembledData,
          this.uncompressedSize,
        );
      }

      // In a real implementation, we would verify the hash here.

      this.data = assembledData || undefined;
      this.status = ResourceStatus.COMPLETE;

      if (this.callback) {
        this.callback(this);
      }
      if (this.progressCallback) {
        this.progressCallback(this);
      }
    } catch (e) {
      this.status = ResourceStatus.CORRUPT;
      console.error("Failed to assemble resource:", e);
    }
  }

  /**
   * Concatenates an array of Uint8Arrays.
   * @param {(Uint8Array|null)[]} parts
   * @returns {Uint8Array}
   * @private
   */
  _concatenateParts(parts) {
    /** @type {Uint8Array[]} */
    const validParts = [];
    for (const part of parts) {
      if (part !== null) {
        validParts.push(part);
      }
    }
    const totalLength = validParts.reduce((acc, part) => acc + part.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of validParts) {
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
    if (this.totalParts === 0) return 0;
    return this.receivedCount / this.totalParts;
  }
}
