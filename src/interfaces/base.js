/**
 * @file base.js
 * @description Interface abstract base class
 */

/**
 * Abstract base class for all RNS interfaces.
 * @extends EventTarget
 */
export class Interface extends EventTarget {
	/**
	 * The name of the interface.
	 * @type {string}
	 */
	name = "unknown";

	/**
	 * Whether the interface is currently open/online.
	 * @type {boolean}
	 */
	get isOpen() {
		return false;
	}

	/**
	 * The readable stream of incoming data.
	 * @type {import('node:stream/web').ReadableStream | null}
	 */
	get readable() {
		throw new Error("Interface.readable is not implemented");
	}

	/**
	 * The writable stream of outgoing data.
	 * @type {import('node:stream/web').WritableStream | null}
	 */
	get writable() {
		throw new Error("Interface.writable is not implemented");
	}

	/**
	 * Establishes the connection.
	 * @returns {Promise<void>}
	 */
	async connect() {
		throw new Error("Interface.connect is not implemented");
	}

	/**
	 * Closes the connection.
	 * @returns {Promise<void>}
	 */
	async disconnect() {
		throw new Error("Interface.disconnect is not implemented");
	}
}
