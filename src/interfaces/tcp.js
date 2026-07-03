import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { createRNSFramerStream, createRNSUnframerStream } from '../transport/framer.js';
import { Packet } from '../core/packet.js';

/**
 * @extends Interface
 */
export class TCPClientInterface {
	constructor(options) {
		this.host = options.host;
		this.port = options.port;
		this.ifacSize = options.ifacSize || 0;
		this.socket = null;
		this._readable = null;
		this._writable = null;
	}

	get readable() { return this._readable; }
	get writable() { return this._writable; }

	async connect() {
		return new Promise((resolve, reject) => {
			this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
				this._setupStreams();
				resolve();
			});
			this.socket.on('error', reject);
		});
	}

	async disconnect() {
		if (this.socket) this.socket.destroy();
	}

	_setupStreams() {
		const nodeReadable = Readable.from(this.socket);
		const nodeWritable = new Writable({
			write(chunk, encoding, callback) {
				this.socket.write(chunk, encoding, callback);
			},
		});
		this._readable = Readable.toWeb(nodeReadable).pipeThrough(createRNSUnframerStream(Packet, this.ifacSize));
		this._writable = Writable.toWeb(nodeWritable).pipeThrough(createRNSFramerStream(Packet));
	}
}

/**
 * @extends Interface
 */
export class TCPServerInterface {
	constructor(options) {
		this.port = options.port;
		this.ifacSize = options.ifacSize || 0;
		this.server = null;
		this.activeSocket = null;
		this._readable = null;
		this._writable = null;
	}

	get readable() { return this._readable; }
	get writable() { return this._writable; }

	async connect() {
		return new Promise((resolve, reject) => {
			this.server = net.createServer((socket) => {
				this.activeSocket = socket;
				this._setupStreams(socket);
				resolve();
			});
			this.server.listen(this.port, () => {});
			this.server.on('error', reject);
		});
	}

	async disconnect() {
		if (this.server) this.server.close();
		if (this.activeSocket) this.activeSocket.destroy();
	}

	_setupStreams(socket) {
		const nodeReadable = Readable.from(socket);
		const nodeWritable = new Writable({
			write(chunk, encoding, callback) {
				socket.write(chunk, encoding, callback);
			},
		});
		this._readable = Readable.toWeb(nodeReadable).pipeThrough(createRNSUnframerStream(Packet, this.ifacSize));
		this._writable = Writable.toWeb(nodeWritable).pipeThrough(createRNSFramerStream(Packet));
	}
}
