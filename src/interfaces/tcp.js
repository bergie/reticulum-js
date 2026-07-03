import net from "node:net";
import { Readable, Writable } from "node:stream";
import { Packet } from "../core/packet.js";
import {
	createRNSFramerStream,
	createRNSUnframerStream,
} from "../transport/framer.js";
import { Interface } from "./base.js";

/**
 * @typedef {Object} TCPClientInterfaceOptions
 * @property {string} [host]
 * @property {number} [port]
 * @property {any} [socket]
 * @property {number} [ifacSize]
 */

/**
 * @typedef {Object} TCPServerInterfaceOptions
 * @property {number} port
 * @property {number} [ifacSize]
 */

/**
 * @extends Interface
 */
export class TCPClientInterface extends Interface {
	/**
	 * @param {TCPClientInterfaceOptions} options
	 */
	constructor(options) {
		super();
		this.host = options.host || "";
		this.port = options.port || 0;
		/** @type {any} */
		this.socket = options.socket || null;
		this.ifacSize = options.ifacSize || 0;
		/** @type {any} */
		this._readable = null;
		/** @type {any} */
		this._writable = null;
		this.online = false;
	}

	/** @returns {any} */
	get readable() {
		return this._readable;
	}
	/** @returns {any} */
	get writable() {
		return this._writable;
	}

	/**
	 * @returns {Promise<void>}
	 */
	async connect() {
		if (this.socket) {
			this._setupStreams(this.socket);
			this.online = true;
			return;
		}
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection(
				{ host: this.host, port: this.port },
				() => {
					this._setupStreams(this.socket);
					this.online = true;
					resolve();
				},
			);
			this.socket.on("error", reject);
		});
	}

	/**
	 * @returns {Promise<void>}
	 */
	async disconnect() {
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
		this.online = false;
	}

	/**
	 * @param {any} socket
	 * @private
	 */
	_setupStreams(socket) {
		const nodeReadable = Readable.from(socket);
		const nodeWritable = new Writable({
			/**
			 * @param {Uint8Array} chunk
			 * @param {string} encoding
			 * @param {any} callback
			 */
			write(chunk, encoding, callback) {
				socket.write(chunk, encoding, callback);
			},
		});
		this._readable = Readable.toWeb(nodeReadable).pipeThrough(
			createRNSUnframerStream(Packet, this.ifacSize),
		);

		const framer = createRNSFramerStream(Packet);
		framer.readable.pipeTo(Writable.toWeb(nodeWritable)).catch((err) => {
			console.error("Framer pipeTo error:", err);
		});
		this._writable = framer.writable;
	}
}

/**
 * @extends Interface
 */
export class TCPServerInterface extends Interface {
	/**
	 * @param {TCPServerInterfaceOptions} options
	 */
	constructor(options) {
		super();
		this.port = options.port;
		this.ifacSize = options.ifacSize || 0;
		/** @type {any} */
		this.server = null;
		/** @type {Set<TCPClientInterface>} */
		this.spawnedInterfaces = new Set();
		this.online = false;
	}

	/** @returns {any} */
	get readable() {
		throw new Error("TCPServerInterface.readable is not implemented");
	}
	/** @returns {any} */
	get writable() {
		throw new Error("TCPServerInterface.writable is not implemented");
	}

	/**
	 * @returns {Promise<void>}
	 */
	async connect() {
		return new Promise((resolve, reject) => {
			this.server = net.createServer(async (/** @type {any} */ socket) => {
				const client = new TCPClientInterface({
					socket,
					ifacSize: this.ifacSize,
				});
				await client.connect();
				this.spawnedInterfaces.add(client);
				this.dispatchEvent(new CustomEvent("connection", { detail: client }));
			});
			this.server.listen(this.port, () => {
				this.online = true;
				resolve();
			});
			this.server.on("error", reject);
		});
	}

	/**
	 * @returns {Promise<void>}
	 */
	async disconnect() {
		if (this.server) {
			this.server.close();
		}
		const disconnects = Array.from(this.spawnedInterfaces).map((client) =>
			client.disconnect(),
		);
		await Promise.all(disconnects);
		this.spawnedInterfaces.clear();
		this.online = false;
	}
}
