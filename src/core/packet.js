/**
 * @file packet.js
 * @description Binary serialization/deserialization for Reticulum packets
 */

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
}

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
  KEEPALIVE: 0x0a, // Often used in Links
  IDENTIFY: 0xfe, // 254: Link identity proof
  CHANNEL: 0x0e,
  LINKCLOSE: 0xfc,
  LRPROOF: 0xff, // 255: Link request proof
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
   * @returns {Promise<Uint8Array>}
   */
  async getHash() {
    // 1. Get the serialized wire-format bytes
    const serialized = this.serialize();

    // 2. Compute SHA-256 digest
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      /** @type {any} */ (serialized),
    );
    return new Uint8Array(hashBuffer);
  }

  _buildFlagsByte() {
    let flags = 0x00;
    // Removed: IFAC flag (0x80) is handled at the interface layer, not here.
    if (this.headerType === HeaderType.HEADER_2) flags |= 0x40;
    if (this.contextFlag) flags |= 0x20;
    if (this.transportType === 1) flags |= 0x10;
    flags |= (this.destinationType & 0x03) << 2;
    flags |= this.packetType & 0x03;
    return flags;
  }

  /**
   * @returns {Uint8Array}
   */
  serialize() {
    const flags = this._buildFlagsByte();
    const DST_LEN = 16; // Standard Reticulum truncated hash length

    // 1. Calculate precise byte length
    let length = 2; // flags (1) + hops (1)

    if (this.headerType === HeaderType.HEADER_2) {
      length += DST_LEN; // transportId
    }
    length += DST_LEN; // destinationHash

    length += 1; // contextByte (Always 1 byte, mirroring Python's unconditional append)

    length += this.payload.length; // ciphertext / data

    // 2. Allocate Buffer
    const buffer = new ArrayBuffer(length);
    const uint8 = new Uint8Array(buffer);

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
