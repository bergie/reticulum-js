/**
 * @file pkcs7.js
 * @description PKCS7 padding and unpadding
 */

/**
 * @namespace pkcs7
 */
export const pkcs7 = {
	/**
	 * Pads the data with PKCS7 padding.
	 * @param {Uint8Array} data
	 * @returns {Uint8Array}
	 */
	pad(data) {
		const paddingLength = 16 - (data.length % 16);
		const padded = new Uint8Array(data.length + paddingLength);
		padded.set(data, 0);
		padded.fill(paddingLength, data.length);
		return padded;
	},

	/**
	 * Removes PKCS7 padding from the data.
	 * @param {Uint8Array} data
	 * @returns {Uint8Array}
	 * @throws {Error} if padding is invalid
	 */
	unpad(data) {
		if (data.length === 0) {
			throw new Error("Cannot unpad empty data");
		}
		const paddingLength = data[data.length - 1];
		if (paddingLength < 1 || paddingLength > 16) {
			throw new Error("Invalid PKCS7 padding");
		}
		for (let i = 1; i <= paddingLength; i++) {
			if (data[data.length - i] !== paddingLength) {
				throw new Error("Invalid PKCS7 padding");
			}
		}
		return data.slice(0, data.length - paddingLength);
	},
};
