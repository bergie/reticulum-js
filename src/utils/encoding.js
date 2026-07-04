/**
 * Minimal, zero-dependency encoding utilities for the Reticulum Network System.
 * Strictly utilizes standard ES6 TypedArrays and Strings.
 */

/**
 * Converts a Uint8Array to a lowercase hexadecimal string.
 * This is primarily used for indexing Routing Tables and displaying Destination Hashes.
 * * @param {Uint8Array} bytes - The raw byte array to convert.
 * @returns {string} The resulting hexadecimal string.
 */
export function toHex(bytes) {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError("toHex expects a Uint8Array");
	}

	// We pre-allocate the array for slight memory optimization over .map()
	const hex = new Array(bytes.length);

	for (let i = 0; i < bytes.length; i++) {
		// .toString(16) drops leading zeros (e.g., 0x0A becomes 'a').
		// .padStart(2, '0') guarantees we always have valid 2-character hex pairs.
		hex[i] = bytes[i].toString(16).padStart(2, "0");
	}

	return hex.join("");
}

/**
 * Converts a hexadecimal string back into a raw Uint8Array.
 * Useful for parsing user-provided destination hashes or static routing configurations.
 * * @param {string} hexString - The hexadecimal string to convert.
 * @returns {Uint8Array} The resulting raw byte array.
 */
export function fromHex(hexString) {
	if (typeof hexString !== "string") {
		throw new TypeError("fromHex expects a string");
	}

	// Strip out any accidental spaces, dashes, or formatting
	const cleanHex = hexString.replace(/[\s-]/g, "");

	if (cleanHex.length % 2 !== 0) {
		throw new Error("Hex string must have an even number of characters");
	}

	const bytes = new Uint8Array(cleanHex.length / 2);

	for (let i = 0; i < bytes.length; i++) {
		const start = i * 2;
		// Parse each 2-character chunk as a base-16 integer
		bytes[i] = parseInt(cleanHex.substring(start, start + 2), 16);
	}

	return bytes;
}
