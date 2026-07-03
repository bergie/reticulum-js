/**
 * @file msgpack.js
 * @description A minimal, zero-dependency MessagePack encoder/decoder.
 * Optimized for Reticulum RNS and LXMF requirements.
 */

export class MicroMsgPack {
	/**
	 * Encodes a JavaScript value into a MessagePack Uint8Array.
	 * @param {any} value
	 * @returns {Uint8Array}
	 */
	static encode(value) {
		const bytes = [];
		this._encodeValue(value, bytes);
		return new Uint8Array(bytes);
	}

	/**
	 * Decodes a MessagePack Uint8Array into a JavaScript value.
	 * @param {Uint8Array} uint8array
	 * @returns {any}
	 */
	static decode(uint8array) {
		const state = {
			view: new DataView(uint8array.buffer, uint8array.byteOffset, uint8array.byteLength),
			offset: 0,
		};
		return this._decodeValue(state);
	}

	// --- ENCODER ---

	static _encodeValue(value, bytes) {
		if (value === null || value === undefined) {
			bytes.push(0xc0); // nil
		} else if (typeof value === "boolean") {
			bytes.push(value ? 0xc3 : 0xc2); // true / false
		} else if (typeof value === "number") {
			this._encodeNumber(value, bytes);
		} else if (typeof value === "string") {
			this._encodeString(value, bytes);
		} else if (value instanceof Uint8Array) {
			this._encodeBinary(value, bytes);
		} else if (Array.isArray(value)) {
			this._encodeArray(value, bytes);
		} else if (typeof value === "object") {
			this._encodeMap(value, bytes);
		} else {
			throw new Error(`Unsupported data type: ${typeof value}`);
		}
	}

	static _encodeNumber(value, bytes) {
		if (Number.isInteger(value)) {
			if (value >= 0) {
				if (value <= 0x7f) {
					bytes.push(value); // positive fixint
				} else if (value <= 0xff) {
					bytes.push(0xcc, value); // uint 8
				} else if (value <= 0xffff) {
					bytes.push(0xcd, (value >> 8) & 0xff, value & 0xff); // uint 16
				} else if (value <= 0xffffffff) {
					bytes.push(0xce, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff); // uint 32
				} else {
					this._encodeFloat64(value, bytes); // Fallback for JS max safe integers
				}
			} else {
				if (value >= -0x20) {
					bytes.push(0xe0 | (value + 0x20)); // negative fixint
				} else if (value >= -0x80) {
					bytes.push(0xd0, value & 0xff); // int 8
				} else if (value >= -0x8000) {
					bytes.push(0xd1, (value >> 8) & 0xff, value & 0xff); // int 16
				} else if (value >= -0x80000000) {
					bytes.push(0xd2, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff); // int 32
				} else {
					this._encodeFloat64(value, bytes);
				}
			}
		} else {
			this._encodeFloat64(value, bytes);
		}
	}

	static _encodeFloat64(value, bytes) {
		bytes.push(0xcb); // float 64
		const buffer = new ArrayBuffer(8);
		new DataView(buffer).setFloat64(0, value, false); // Big-Endian
		bytes.push(...new Uint8Array(buffer));
	}

	static _encodeString(value, bytes) {
		const utf8 = new TextEncoder().encode(value);
		const len = utf8.length;
		if (len <= 31) {
			bytes.push(0xa0 | len); // fixstr
		} else if (len <= 255) {
			bytes.push(0xd9, len); // str 8
		} else if (len <= 65535) {
			bytes.push(0xda, (len >> 8) & 0xff, len & 0xff); // str 16
		} else {
			bytes.push(0xdb, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff); // str 32
		}
		bytes.push(...utf8);
	}

	static _encodeBinary(value, bytes) {
		const len = value.length;
		if (len <= 255) {
			bytes.push(0xc4, len); // bin 8
		} else if (len <= 65535) {
			bytes.push(0xc5, (len >> 8) & 0xff, len & 0xff); // bin 16
		} else {
			bytes.push(0xc6, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff); // bin 32
		}
		bytes.push(...value);
	}

	static _encodeArray(value, bytes) {
		const len = value.length;
		if (len <= 15) {
			bytes.push(0x90 | len); // fixarray
		} else if (len <= 65535) {
			bytes.push(0xdc, (len >> 8) & 0xff, len & 0xff); // array 16
		} else {
			bytes.push(0xdd, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff); // array 32
		}
		for (const item of value) {
			this._encodeValue(item, bytes);
		}
	}

	static _encodeMap(value, bytes) {
		const keys = Object.keys(value);
		const len = keys.length;
		if (len <= 15) {
			bytes.push(0x80 | len); // fixmap
		} else if (len <= 65535) {
			bytes.push(0xde, (len >> 8) & 0xff, len & 0xff); // map 16
		} else {
			bytes.push(0xdf, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff); // map 32
		}
		for (const key of keys) {
			this._encodeString(key, bytes);
			this._encodeValue(value[key], bytes);
		}
	}

	// --- DECODER ---

	static _decodeValue(state) {
		if (state.offset >= state.view.byteLength)
			throw new Error("Unexpected end of data");
		const byte = state.view.getUint8(state.offset++);

		// Positive FixInt
		if (byte <= 0x7f) return byte;

		// FixMap
		if (byte >= 0x80 && byte <= 0x8f) return this._decodeMap(state, byte & 0x0f);

		// FixArray
		if (byte >= 0x90 && byte <= 0x9f) return this._decodeArray(state, byte & 0x0f);

		// FixStr
		if (byte >= 0xa0 && byte <= 0xbf) return this._decodeString(state, byte & 0x1f);

		// Negative FixInt
		if (byte >= 0xe0) return byte - 0x100;

		switch (byte) {
			case 0xc0: return null; // nil
			case 0xc2: return false; // false
			case 0xc3: return true; // true
			case 0xc4: return this._decodeBinary(state, this._readUint8(state)); // bin 8
			case 0xc5: return this._decodeBinary(state, this._readUint16(state)); // bin 16
			case 0xc6: return this._decodeBinary(state, this._readUint32(state)); // bin 32
			case 0xcb: return this._readFloat64(state); // float 64
			case 0xd1: return this._readInt8(state); // int 8
			case 0xd2: return this._readInt16(state); // int 16
			case 0xd3: return this._readInt32(state); // int 32
			case 0xd9: return this._decodeString(state, this._readUint8(state)); // str 8
			case 0xda: return this._decodeString(state, this._readUint16(state)); // str 16
			case 0xdb: return this._decodeString(state, this._readUint32(state)); // str 32
			case 0xdc: return this._decodeArray(state, this._readUint16(state)); // array 16
			case 0xdd: return this._decodeArray(state, this._readUint32(state)); // array 32
			case 0xde: return this._decodeMap(state, this._readUint16(state)); // map 16
			case 0xdf: return this._decodeMap(state, this._readUint32(state)); // map 32
			default:
				throw new Error(`Unimplemented MessagePack byte: 0x${byte.toString(16)}`);
		}
	}

	static _readUint8(state) {
		return state.view.getUint8(state.offset++);
	}

	static _readUint16(state) {
		const val = state.view.getUint16(state.offset, false);
		state.offset += 2;
		return val;
	}

	static _readUint32(state) {
		const val = state.view.getUint32(state.offset, false);
		state.offset += 4;
		return val;
	}

	static _readInt8(state) {
		const val = state.view.getInt8(state.offset);
		state.offset += 1;
		return val;
	}

	static _readInt16(state) {
		const val = state.view.getInt16(state.offset, false);
		state.offset += 2;
		return val;
	}

	static _readInt32(state) {
		const val = state.view.getInt32(state.offset, false);
		state.offset += 4;
		return val;
	}

	static _readFloat64(state) {
		const val = state.view.getFloat64(state.offset, false);
		state.offset += 8;
		return val;
	}

	static _decodeString(state, length) {
		const bytes = new Uint8Array(state.view.buffer, state.view.byteOffset + state.offset, length);
		state.offset += length;
		return new TextDecoder().decode(bytes);
	}

	static _decodeBinary(state, length) {
		const bytes = new Uint8Array(state.view.buffer.slice(
			state.view.byteOffset + state.offset,
			state.view.byteOffset + state.offset + length,
		));
		state.offset += length;
		return bytes;
	}

	static _decodeArray(state, length) {
		const arr = new Array(length);
		for (let i = 0; i < length; i++) {
			arr[i] = this._decodeValue(state);
		}
		return arr;
	}

	static _decodeMap(state, length) {
		const map = {};
		for (let i = 0; i < length; i++) {
			const key = this._decodeValue(state);
			map[key] = this._decodeValue(state);
		}
		return map;
	}
}
