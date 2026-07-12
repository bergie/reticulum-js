/**
 * @file packet.js
 * @description Binary serialization/deserialization for Reticulum packets
 */

/**
 * Returns the key name for a given value in an enum object.
 * @param {Record<string, any>} enumObj
 * @param {number} value
 * @returns {string}
 */
export function getEnumName(enumObj, value) {
  return Object.keys(enumObj).find((key) => enumObj[key] === value) || value.toString();
}

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
 * Transport types
 * @enum {number}
 */
export const TransportType = {
  BROADCAST: 0x00,
  TRANSPORT: 0x01,
  RELAY: 0x02,
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
  RESOURCE_ADV: 0x02,
  RESOURCE_REQ: 0x03,
  RESOURCE_HMU: 0x04,
  RESOURCE_PRF: 0x05,
  RESOURCE_ICL: 0x06,
  RESOURCE_RCL: 0x07,
  CACHE_REQUEST: 0x08,
  REQUEST: 0x09,
  RESPONSE: 0x0a,
  PATH_RESPONSE: 0x0b,
  COMMAND: 0x0c,
  COMMAND_STATUS: 0x0d,
  CHANNEL: 0x0e,
  KEEPALIVE: 0xfa,
  LINKIDENTIFY: 0xfb,
  LINKCLOSE: 0xfc,
  LINKPROOF: 0xfd,
  LRRTT: 0xfe,
  LRPROOF: 0xff,
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
   * @param {HeaderType} [options.headerType]
   * @param {number} [options.hops]
   * @param {number} [options.transportType]
   * @param {DestType} [options.destinationType]
   * @param {PacketType} options.packetType
   * @param {boolean} [options.contextFlag]
   * @param {Uint8Array} options.destinationHash
   * @param {number} [options.contextByte]
   * @param {Uint8Array} [options.payload]
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
    this.contextByte = options.contextByte || ContextType.NONE;
    this.payload = options.payload || new Uint8Array(0);
    this.transportId = options.transportId;
    this.raw = options.raw || new Uint8Array(0);
  }

  /**
   * @returns {Uint8Array}
   */
  getHashablePart() {
    if (!this.raw || this.raw.length === 0) {
      this.raw = this.serialize();
    }
    // 1. Get flags byte and mask it (0x0F)
    const flags = this.raw[0] & 0x0f;

    // 2. Determine offset based on header_type
    // HEADER_2 (Type 2) is 32 bytes (16 dest + 16 transport)
    // HEADER_1 (Type 1) is 16 bytes (16 dest)
    // Note: The indexing logic depends on your framing.
    // In Python, it looks like it assumes a specific starting point.

    let sliceOffset;
    if (this.headerType === HeaderType.HEADER_2) {
      sliceOffset = 18;
    } else {
      // HEADER_1: 2 bytes (flags/hops) + 16 bytes dest = 18?
      // Your Python snippet uses [2:], let's follow that.
      sliceOffset = 2;
    }

    const payloadPart = this.raw.slice(sliceOffset);

    const hashablePart = new Uint8Array(1 + payloadPart.length);
    hashablePart[0] = flags;
    hashablePart.set(payloadPart, 1);

    return hashablePart;
  }

  /**
   * @returns {Promise<Uint8Array>}
   */
  async getHash() {
    const hashablePart = this.getHashablePart();
    const hashBuffer = await crypto.subtle.digest("SHA-256", hashablePart);
    return new Uint8Array(hashBuffer);
  }

  _buildFlagsByte() {
    let flags = 0x00;

    if (this.headerType === HeaderType.HEADER_2) flags |= 0x40;

    if (this.contextFlag) flags |= 0x20;

    if (this.transportType === 1) flags |= 0x10;

    if (this.contextByte === ContextType.LRPROOF) {
      flags |= DestType.LINK << 2;
    } else {
      flags |= (this.destinationType & 0x03) << 2;
    }
    flags |= this.packetType & 0x03;

    return flags;
  }

  /**
   * Serializes the Packet into the exact Reticulum wire format.
   * @returns {Uint8Array}
   */
  serialize() {
    const DST_LEN = 16;
    const flags = this._buildFlagsByte();

    // 1. Calculate precise byte length
    let length = 2; // flags (1) + hops (1)

    if (this.headerType === HeaderType.HEADER_2) {
      length += DST_LEN; // transportId
    }

    length += DST_LEN; // destinationHash

    // UNCONDITIONAL CONTEXT BYTE (Mirroring deserialize)
    length += 1;

    length += this.payload.length;

    // 2. Allocate Buffer
    const uint8 = new Uint8Array(length);

    // 3. Write Header
    uint8[0] = flags;
    uint8[1] = this.hops & 0xff;

    let offset = 2;

    if (this.headerType === HeaderType.HEADER_2) {
      if (!this.transportId)
        throw new Error("Header type 2 requires a transportId");
      uint8.set(this.transportId.subarray(0, 16), offset);
      offset += DST_LEN;
    }

    uint8.set(this.destinationHash.subarray(0, 16), offset);
    offset += DST_LEN;

    // 4. Write Context (Unconditional)
    uint8[offset] = this.contextByte || 0x00;
    offset += 1;

    // 5. Write Payload
    uint8.set(this.payload, offset);

    return uint8;
  }

  /**
   * @param {Uint8Array} data
   * @returns {Packet}
   */
  static deserialize(data) {
    const DST_LEN = 16; // Standard Reticulum truncated hash length (128 bits)

    // Minimum packet length: flags(1) + hops(1) + destHash(16) + context(1) = 19 bytes
    if (data.length < 19) throw new Error("Packet too short");

    const flags = data[0];
    const hops = data[1];

    // Bitwise extraction matching Python logic
    const isHeader2 = (flags & 0x40) !== 0;
    const headerType = isHeader2 ? HeaderType.HEADER_2 : HeaderType.HEADER_1;
    const contextFlag = (flags & 0x20) !== 0;
    const transportType = (flags & 0x10) !== 0 ? 1 : 0;
    const destinationType = (flags & 0x0c) >> 2;
    const packetType = flags & 0x03;

    let offset = 2;

    let transportId = null;
    if (isHeader2) {
      transportId = data.slice(offset, offset + DST_LEN);
      offset += DST_LEN;
    }

    const destinationHash = data.slice(offset, offset + DST_LEN);
    offset += DST_LEN;

    // The context byte is extracted unconditionally, mirroring Python's fixed slicing
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
      transportId: transportId ?? undefined,
      raw: data,
    });
  }
}
