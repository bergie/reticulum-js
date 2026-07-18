/**
 * @file base.js
 * @description Interface abstract base class
 */

/**
 * @typedef {CustomEvent<Error>} ErrorEvent
 */

/**
 * @typedef {CustomEvent<{packet: import("../core/packet.js").Packet}>} PacketEvent
 */

/**
 * Abstract base class for all RNS interfaces.
 * @extends EventTarget
 */
export class Interface extends EventTarget {
  /**
   * Returns a JSON Schema (draft-07) describing the options accepted by this
   * interface's constructor, for dynamically-generated setup UIs.
   *
   * The base schema declares the options common to every interface (`name`,
   * `ifacSize`). Subclasses extend it with their own options via
   * `super.getConfigurationSchema()` + spread, and intentionally omit
   * internal-only options (e.g. an adopted socket).
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Human-readable interface name. Every interface in a node " +
            "should have a unique name so multiple interfaces of the same " +
            "type (e.g. two TCP clients) can be told apart. A descriptive " +
            "name is generated if omitted.",
          examples: ["tcp-client-1", "lora-node"],
        },
        ifacSize: {
          type: "integer",
          minimum: 0,
          default: 0,
          examples: [16],
          description:
            "Optional interface authentication code (IFAC) size in bytes. " +
            "0 disables IFAC.",
        },
      },
      required: [],
    };
  }

  /**
   * The underlying socket, when this interface is backed by a Node.js stream.
   * @type {import('node:net').Socket | null}
   */
  socket = null;
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
    const socket = this.socket;
    if (socket && socket.writable) {
      // This forces Node to push the buffered data out of the NIC
      await new Promise((resolve) => socket.write("", resolve));
    }
  }
}
