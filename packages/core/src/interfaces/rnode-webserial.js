/**
 * @file rnode-webserial.js
 * @description Web Serial backend for the RNode interface (browsers).
 *
 * The browser-side counterpart to the Node.js serial backend. Subclasses the
 * transport-agnostic {@link RNodeInterface} and supplies the byte transport via
 * the Web Serial API (`navigator.serial`), whose `SerialPort` already exposes
 * native Web Streams — so unlike the Node backend there is no termios/stty to
 * manage and no manual polling: Web Serial opens the port raw at the chosen
 * baud rate, and `port.readable`/`port.writable` are the streams the base class
 * wants directly.
 *
 * Browser-only. Importing the module in Node is safe (no API access happens at
 * module load); the API is touched only in {@link RNodeWebSerialInterface#_openTransport}.
 */

/* @ts-self-types="../../types/src/interfaces/rnode-webserial.d.ts" */

import { LogLevel, log } from "../utils/log.js";
import { RNodeInterface } from "./rnode.js";

/**
 * @typedef {import("./rnode.js").RNodeBaseOptions & {
 *   serialPort?: any,
 *   baudRate?: number,
 *   dataBits?: 7 | 8,
 *   stopBits?: 1 | 2,
 *   parity?: "none" | "even" | "odd",
 *   serialFlowControl?: "none" | "hardware",
 * }} RNodeWebSerialOptions
 */

/**
 * RNode interface over the Web Serial API.
 *
 * Pass an already-obtained `SerialPort` via `options.serialPort` (the
 * recommended pattern, since `navigator.serial.requestPort()` must be called
 * from a user gesture such as a click). If omitted, `_openTransport()` will call
 * `requestPort()` itself — which only works inside a user-gesture call stack.
 * @extends RNodeInterface
 */
export class RNodeWebSerialInterface extends RNodeInterface {
  /**
   * Returns the JSON Schema for the Web Serial RNode backend (the base radio
   * options plus the Web Serial `baudRate`/frame options). `serialPort` is a
   * live `SerialPort` object so it is intentionally omitted from the schema.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const radio = RNodeInterface.getConfigurationSchema();
    return {
      ...radio,
      title: "RNode Web Serial Interface (browser)",
      description:
        "Connects to a LoRa RNode over the Web Serial API (navigator.serial) " +
        "in a browser. The host page must have obtained a SerialPort via " +
        "navigator.serial.requestPort() from a user gesture and pass it as " +
        "options.serialPort. Mirrors the Python reference RNodeInterface.",
      properties: {
        ...radio.properties,
        baudRate: {
          type: "integer",
          default: 115200,
          examples: [115200],
          description: "Serial baud rate (Python: defaults to 115200).",
        },
        dataBits: {
          type: "integer",
          enum: [7, 8],
          default: 8,
          description: "Data bits per character (Web Serial open option).",
        },
        stopBits: {
          type: "integer",
          enum: [1, 2],
          default: 1,
          description: "Stop bits (Web Serial open option).",
        },
        parity: {
          type: "string",
          enum: ["none", "even", "odd"],
          default: "none",
          description: "Parity (Web Serial open option).",
        },
        serialFlowControl: {
          type: "string",
          enum: ["none", "hardware"],
          default: "none",
          description:
            "Serial line flow control (Web Serial open option; distinct " +
            "from the base LoRa flowControl).",
        },
      },
      required: [...radio.required],
      additionalProperties: false,
    };
  }

  /**
   * Creates a Web Serial RNode interface.
   *
   * `options.serialPort` is a `SerialPort` obtained via
   * `navigator.serial.requestPort()` (from a user gesture) or
   * `navigator.serial.getPorts()`. If omitted, `_openTransport()` calls
   * `requestPort()` itself.
   * @param {RNodeWebSerialOptions} options
   */
  constructor(options) {
    super(options);
    this.baudRate = options.baudRate || 115200;
    this.dataBits = options.dataBits || 8;
    this.stopBits = options.stopBits || 1;
    this.parity = options.parity || "none";
    this.serialFlowControl = options.serialFlowControl || "none";
    /** @type {any} */ this.serialPort = options.serialPort || null;
    this.name = options.name || "rnode-webserial";
    /** @type {any} */ this._writer = null;
  }

  /**
   * Opens the Web Serial port and returns the transport handles for the base
   * class: `port.readable` is already a `ReadableStream<Uint8Array>`, and a
   * held writer wraps `port.writable`.
   * @returns {Promise<import("./rnode.js").RNodeTransport>}
   * @protected
   */
  async _openTransport() {
    let port = this.serialPort;
    if (!port) {
      const serial = /** @type {any} */ (globalThis.navigator)?.serial;
      if (!serial) {
        throw new Error(
          "Web Serial API (navigator.serial) is not available; pass a " +
            "SerialPort via options.serialPort (obtained from a user gesture)",
        );
      }
      log(
        this.name,
        "Requesting a serial port (requires a user gesture)...",
        LogLevel.VERBOSE,
      );
      port = await serial.requestPort();
      this.serialPort = port;
    }

    // Open the port raw at the configured baud. Web Serial opens in a
    // transparent/8N1 mode by default — no stty/termios needed (unlike the
    // Node backend), and never blocks on carrier detect.
    if (!port.readable) {
      await port.open({
        baudRate: this.baudRate,
        dataBits: this.dataBits,
        stopBits: this.stopBits,
        parity: this.parity,
        flowControl: this.serialFlowControl,
      });
    }
    log(this.name, "Web Serial port is open", LogLevel.VERBOSE);

    // Hold a single writer for outbound bytes (the base writes one frame at a
    // time via `_transportWrite`).
    this._writer = port.writable.getWriter();

    return {
      readable: port.readable,
      write: (bytes) => this._serialWrite(bytes),
      close: () => this._closePort(),
    };
  }

  /**
   * Writes already-framed bytes to the held Web Serial writer.
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   * @private
   */
  async _serialWrite(bytes) {
    if (!this._writer) {
      throw new Error(`Web Serial port for ${this.name} is not open`);
    }
    await this._writer.write(bytes);
  }

  /**
   * Releases the writer and closes the port. The base releases its reader
   * (cancelling `port.readable`) before calling this, so the port is no longer
   * locked here.
   * @returns {Promise<void>}
   * @private
   */
  async _closePort() {
    if (this._writer) {
      try {
        await this._writer.close();
      } catch (e) {
        log(
          this.name,
          `Writer close error: ${/** @type {any} */ (e).message}`,
          LogLevel.DEBUG,
        );
      }
      try {
        this._writer.releaseLock();
      } catch (_e) {
        // already released
      }
      this._writer = null;
    }
    if (this.serialPort) {
      try {
        await this.serialPort.close();
      } catch (e) {
        log(
          this.name,
          `Port close error: ${/** @type {any} */ (e).message}`,
          LogLevel.DEBUG,
        );
      }
    }
  }
}
