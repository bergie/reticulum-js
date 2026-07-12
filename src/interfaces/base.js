/**
 * @file base.js
 * @description Interface abstract base class
 */

/**
 * @typedef {CustomEvent} ErrorEvent
 * @property {Error} detail
 */

/**
 * Abstract base class for all RNS interfaces.
 * @extends EventTarget
 */
export class Interface extends EventTarget {
  /**
   * @type {import('node:stream/web').WritableStreamDefaultWriter | null}
   */
  _packetWriter = null;

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

  /**
   * Sends bytes wrapped in KISS framing
   * @param {import("../core/packet.js").Packet} packet
   */
  async send(packet) {
    if (!this.writable) {
      throw new Error("Interface not ready: No packet writer found.");
    }

    if (!this._packetWriter) {
      // Only get a writer if it doesn't exist yet
      this._packetWriter = this.writable.getWriter();
    }

    await this._packetWriter.write(packet);

    // FORCE DRAIN:
    // If the socket has a buffer, wait for it to empty
    if (this.socket && this.socket.writable) {
      // This forces Node to push the buffered data out of the NIC
      await new Promise((resolve) => this.socket.write("", resolve));
    }
  }
}
