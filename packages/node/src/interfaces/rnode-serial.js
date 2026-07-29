/**
 * @file rnode-serial.js
 * @description Node.js serial backend for the RNode interface.
 *
 * Opens a USB/Bluetooth-serial RNode (e.g. `/dev/ttyUSB0`,
 * `/dev/cu.SLAB_USBtoUART`) with **no external dependencies**, in three steps:
 *
 * 1. `open(O_RDWR | O_NONBLOCK)` — a *non-blocking* open. A blocking open
 *   hangs in uninterruptible sleep on real RNode hardware, because the kernel
 *   waits for carrier detect (the line discipline lacks `CLOCAL` until we set
 *   it, and `open()` blocks before termios is applied). Non-blocking open
 *   returns at once.
 * 2. `stty <baud> raw -echo clocal`, run against the already-open fd (passed as
 *   the child's stdin via `stdio`). Because `stty` operates on fd 0 it does
 *   **not** re-open the device, so there is no carrier wait — and there is no
 *   macOS `-f` vs Linux `-F` flag difference to paper over.
 * 3. Poll the non-blocking fd with `readSync` (treating `EAGAIN` as "no data")
 *   and write with `writeSync` (retrying `EAGAIN`). Node has no built-in
 *   `termios`/`fcntl`, so it cannot flip the fd back to blocking mode for
 *   `createReadStream`; polling is the zero-dependency way to drive a
 *   non-blocking tty.
 *
 * POSIX-only (Linux/macOS). Windows needs WSL2 or the third-party `serialport`
 * package; see work doc #6.
 */

/* @ts-self-types="../../../node/types/src/interfaces/rnode-serial.d.ts" */

import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";
import { RNodeInterface } from "@reticulum/core/src/interfaces/rnode.js";
import { LogLevel, log } from "@reticulum/core/src/utils/log.js";

/**
 * Read-poll interval in milliseconds. LoRa is low-bandwidth; a 20 ms poll is
 * responsive without burning CPU. Each tick drains everything available, so
 * bursty arrivals are handled in one pass.
 */
const POLL_INTERVAL_MS = 20;
/** Per-`writeSync` EAGAIN retry delay, in milliseconds. */
const WRITE_EAGAIN_MS = 5;
/** Read buffer size per poll tick. */
const READ_CHUNK = 512;

/**
 * @typedef {import("@reticulum/core/src/interfaces/rnode.js").RNodeBaseOptions & {
 *   port: string,
 *   baudRate?: number,
 * }} RNodeSerialOptions
 */

/**
 * RNode interface over a POSIX serial device.
 *
 * Subclasses the transport-agnostic {@link RNodeInterface} and supplies the
 * byte transport via {@link RNodeSerialInterface#_openTransport} using a
 * non-blocking fd + inherited-fd `stty` + polled `readSync`/`writeSync`.
 *
 * Registered in the Node interface registry as `"rnode-serial"`.
 * @extends RNodeInterface
 */
export class RNodeSerialInterface extends RNodeInterface {
  /**
   * Returns the JSON Schema for the serial RNode backend (the base radio
   * options plus the serial `port`/`baudRate`).
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const radio = RNodeInterface.getConfigurationSchema();
    return {
      ...radio,
      title: "RNode Serial Interface (Node.js)",
      description:
        "Connects to a LoRa RNode over a POSIX serial device " +
        "(/dev/ttyUSB*, /dev/ttyACM*, /dev/cu.*) using a non-blocking fd + " +
        "stty + polled readSync/writeSync (no external dependencies). Mirrors " +
        "the Python reference RNodeInterface serial path.",
      properties: {
        ...radio.properties,
        port: {
          type: "string",
          examples: ["/dev/ttyUSB0", "/dev/cu.SLAB_USBtoUART"],
          description: "Serial device path (Python config key: port).",
        },
        baudRate: {
          type: "integer",
          default: 115200,
          examples: [115200, 9600],
          description:
            "Serial baud rate (Python config key: implicit; defaults to " +
            "115200).",
        },
      },
      required: [...radio.required, "port"],
      additionalProperties: false,
    };
  }

  /**
   * Creates a serial RNode interface.
   * @param {RNodeSerialOptions} options
   */
  constructor(options) {
    super(options);
    if (!options.port) {
      throw new Error(`No port specified for RNode interface ${this.name}`);
    }
    this.port = options.port;
    this.baudRate = options.baudRate || 115200;
    this.name = options.name || `rnode-${this.port}`;
    // I/O handles, populated by `_openTransport`.
    /** @type {number | null} */ this._fd = null;
    /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
    this._readController = null;
    /** @type {ReturnType<typeof setTimeout> | null} */ this._pollTimer = null;
  }

  /**
   * Opens the serial device (non-blocking), configures the line discipline via
   * inherited-fd `stty`, and returns the transport handles for the base class.
   * @returns {import("@reticulum/core/src/interfaces/rnode.js").RNodeTransport}
   * @protected
   */
  _openTransport() {
    log(this.name, `Opening serial port ${this.port}...`, LogLevel.VERBOSE);
    const fd = openSync(this.port, constants.O_RDWR | constants.O_NONBLOCK);
    this._fd = fd;

    // 2. Configure termios on the already-open fd by running `stty` against it
    //    (passed as the child's stdin). stty operates on fd 0, so it does not
    //    re-open the device (no carrier wait) and needs no -F/-f flag.
    const stty = spawnSync(
      "stty",
      [String(this.baudRate), "raw", "-echo", "clocal"],
      { stdio: [fd, "ignore", "ignore"] },
    );
    if (stty.status !== 0 || stty.error) {
      const detail = stty.error
        ? stty.error.message
        : stty.stderr
          ? stty.stderr.toString().trim()
          : `exit ${stty.status}`;
      closeSync(fd);
      this._fd = null;
      throw new Error(`stty failed on ${this.port}: ${detail}`);
    }
    log(this.name, `Serial port ${this.port} is now open`, LogLevel.VERBOSE);

    // 3. Poll the non-blocking fd into a ReadableStream; writeSync for output.
    //    Arrow-function source callbacks bind `this` to the interface (method
    //    shorthand would rebind `this` to the source literal and silently
    //    break polling).
    const readable = new ReadableStream({
      start: (controller) => {
        this._readController = controller;
        this._startPolling();
      },
      cancel: () => {
        this._stopPolling();
      },
    });
    return {
      readable,
      write: (bytes) => this._writeAll(bytes),
      close: () => this._closeFd(),
    };
  }

  /**
   * Polls the non-blocking fd every {@link POLL_INTERVAL_MS}, draining all
   * available bytes into the readable stream's controller. `EAGAIN` means "no
   * data right now" and is silently retried; any other read error ends the
   * stream.
   * @private
   */
  _startPolling() {
    const buf = Buffer.alloc(READ_CHUNK);
    const poll = () => {
      if (this._fd === null || !this._readController) return;
      // One bounded readSync per tick. A non-blocking tty read returns EAGAIN
      // when empty; doing a single read per tick guarantees the event loop is
      // never starved by a fd that trickles data continuously (which would
      // spin an unbounded drain loop). Bursts drain across successive ticks.
      try {
        const n = readSync(this._fd, buf, 0, buf.length, null);
        if (n > 0) {
          this._readController.enqueue(new Uint8Array(buf.subarray(0, n)));
        }
      } catch (e) {
        const err = /** @type {NodeJS.ErrnoException} */ (e);
        if (err.code !== "EAGAIN") {
          this._stopPolling();
          // By close time the fd may already be gone (EBADF) — close, not error.
          if (this._readController && this._fd !== null) {
            this._readController.error(err);
          }
          return;
        }
      }
      this._pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
  }

  /** @private */
  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Writes already-framed bytes to the serial device, retrying on partial
   * writes / EAGAIN until the whole buffer is flushed.
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   * @private
   */
  _writeAll(bytes) {
    return new Promise((resolve, reject) => {
      const buf = Buffer.from(bytes);
      const writeLoop = (/** @type {number} */ offset) => {
        if (this._fd === null) {
          reject(new Error(`Serial port ${this.port} is not open`));
          return;
        }
        if (offset >= buf.length) {
          resolve();
          return;
        }
        let n;
        try {
          n = writeSync(this._fd, buf, offset, buf.length - offset);
        } catch (e) {
          const err = /** @type {NodeJS.ErrnoException} */ (e);
          if (err.code === "EAGAIN") {
            setTimeout(() => writeLoop(offset), WRITE_EAGAIN_MS);
            return;
          }
          reject(err);
          return;
        }
        if (n <= 0) {
          reject(new Error(`Serial write returned ${n} on ${this.port}`));
          return;
        }
        writeLoop(offset + n);
      };
      writeLoop(0);
    });
  }

  /**
   * Stops polling and closes the fd (swallowing errors — best-effort teardown).
   * @returns {void}
   * @private
   */
  _closeFd() {
    this._stopPolling();
    if (this._fd !== null) {
      try {
        closeSync(this._fd);
      } catch (_e) {
        // already closed
      }
      this._fd = null;
    }
  }
}
