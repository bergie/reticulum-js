/**
 * @file hmac.js
 * @description HMAC implementation using Web Crypto API
 */

/**
 * Computes an HMAC-SHA256 signature.
 * @param {any} key - The key for HMAC.
 * @param {any} data - The data to sign.
 * @returns {Promise<Uint8Array>} The resulting HMAC signature.
 */
export async function hmac(key, data) {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		/** @type {any} */ (key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const cleanData = new Uint8Array(data);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, cleanData);

	return new Uint8Array(signature);
}
