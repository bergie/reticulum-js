/**
 * @file rnode.js
 * @description Transport-agnostic RNode interface base class.
 *
 * An RNode is a LoRa radio (typically over serial/USB/Bluetooth) that speaks
 * the **KISS** framing protocol to delineate packets and to carry radio
 * configuration/status commands. This module implements the entirety of that
 * KISS/RNode protocol — the read-loop state machine, the detect → configure →
 * validate handshake, flow control, and the radio-stats parsers — without any
 * I/O of its own. It is browser-safe: a concrete backend (Node.js serial,
 * Web Serial, Web Bluetooth, …) subclasses it and supplies a raw byte stream
 * via the {@link RNodeInterface#_openTransport} hook.
 *
 * Mirrors the Python reference `RNS.Interfaces.RNodeInterface` (serial path)
 * and its `KISS` command class. See work doc #6.
 */

/* @ts-self-types="../../types/src/interfaces/rnode.d.ts" */

import { Packet } from "../core/packet.js";
import { kissEscape, kissFrame } from "../transport/kiss-framer.js";
import { LogLevel, log } from "../utils/log.js";
import { Interface, reconnectSchemaProperties } from "./base.js";

// ---------------------------------------------------------------------------
// KISS command constants — a direct port of the Python reference `KISS` class
// (`RNS/Interfaces/RNodeInterface.py`). The RNode firmware speaks bare command
// bytes (no TNC port nibble), so unlike the generic KISS framer we do NOT mask
// the command byte here.
// ---------------------------------------------------------------------------

/** Frame End / Begin. */
const FEND = 0xc0;
/** Frame Escape. */
const FESC = 0xdb;
/** Transposed Frame End (FESC TFEND → FEND). */
const TFEND = 0xdc;
/** Transposed Frame Escape (FESC TFESC → FESC). */
const TFESC = 0xdd;

const CMD_UNKNOWN = 0xfe;
const CMD_DATA = 0x00;
const CMD_FREQUENCY = 0x01;
const CMD_BANDWIDTH = 0x02;
const CMD_TXPOWER = 0x03;
const CMD_SF = 0x04;
const CMD_CR = 0x05;
const CMD_RADIO_STATE = 0x06;
const CMD_RADIO_LOCK = 0x07;
const CMD_DETECT = 0x08;
const CMD_ST_ALOCK = 0x0b;
const CMD_LT_ALOCK = 0x0c;
const CMD_LEAVE = 0x0a;
const CMD_READY = 0x0f;
const CMD_STAT_RX = 0x21;
const CMD_STAT_TX = 0x22;
const CMD_STAT_RSSI = 0x23;
const CMD_STAT_SNR = 0x24;
const CMD_STAT_CHTM = 0x25;
const CMD_STAT_PHYPRM = 0x26;
const CMD_STAT_BAT = 0x27;
const CMD_STAT_CSMA = 0x28;
const CMD_STAT_TEMP = 0x29;
const CMD_RANDOM = 0x40;
const CMD_PLATFORM = 0x48;
const CMD_MCU = 0x49;
const CMD_FW_VERSION = 0x50;
const CMD_ERROR = 0x90;
const CMD_RESET = 0x55;

/** RNode detect request byte (sent on CMD_DETECT). */
const DETECT_REQ = 0x73;
/** RNode detect response byte (expected on CMD_DETECT). */
const DETECT_RESP = 0x46;

const RADIO_STATE_OFF = 0x00;
const RADIO_STATE_ON = 0x01;

const ERROR_INITRADIO = 0x01;
const ERROR_TXFAILED = 0x02;
const ERROR_MEMORY_LOW = 0x05;
const ERROR_MODEM_TIMEOUT = 0x06;

const PLATFORM_ESP32 = 0x80;
const PLATFORM_NRF52 = 0x70;

/** RSSI offset applied to raw radio RSSI readings, matching the Python ref. */
const RSSI_OFFSET = 157;

/**
 * The full KISS command byte table, exported for backends, tests, and tooling
 * (e.g. a future `rnodeconf`-equivalent). Mirrors the Python `KISS` class.
 */
export const KISS = Object.freeze({
  FEND,
  FESC,
  TFEND,
  TFESC,
  CMD_UNKNOWN,
  CMD_DATA,
  CMD_FREQUENCY,
  CMD_BANDWIDTH,
  CMD_TXPOWER,
  CMD_SF,
  CMD_CR,
  CMD_RADIO_STATE,
  CMD_RADIO_LOCK,
  CMD_DETECT,
  CMD_ST_ALOCK,
  CMD_LT_ALOCK,
  CMD_LEAVE,
  CMD_READY,
  CMD_STAT_RX,
  CMD_STAT_TX,
  CMD_STAT_RSSI,
  CMD_STAT_SNR,
  CMD_STAT_CHTM,
  CMD_STAT_PHYPRM,
  CMD_STAT_BAT,
  CMD_STAT_CSMA,
  CMD_STAT_TEMP,
  CMD_RANDOM,
  CMD_PLATFORM,
  CMD_MCU,
  CMD_FW_VERSION,
  CMD_ERROR,
  CMD_RESET,
  RSSI_OFFSET,
  DETECT_REQ,
  DETECT_RESP,
  RADIO_STATE_OFF,
  RADIO_STATE_ON,
  ERROR_INITRADIO,
  ERROR_TXFAILED,
  ERROR_MEMORY_LOW,
  ERROR_MODEM_TIMEOUT,
  PLATFORM_ESP32,
  PLATFORM_NRF52,
});

/**
 * @typedef {Object} RNodeTransport
 * @property {ReadableStream<Uint8Array>} readable - Inbound raw byte stream
 *   from the radio (KISS-framed).
 * @property {(bytes: Uint8Array) => (Promise<void> | void)} write - Writes raw
 *   bytes (already KISS-framed by the caller) out to the radio.
 * @property {() => (Promise<void> | void)} close - Releases the transport
 *   (closes the serial port / GATT / socket).
 */

/**
 * @typedef {Object} RNodeBaseOptions
 * @property {number} frequency - Centre frequency in Hz (Python: frequency).
 * @property {number} bandwidth - LoRa bandwidth in Hz (Python: bandwidth).
 * @property {number} txPower - TX power in dBm (Python: txpower).
 * @property {number} spreadingFactor - LoRa spreading factor 5–12 (Python:
 *   spreadingfactor).
 * @property {number} codingRate - LoRa coding rate 5–8 (Python: codingrate).
 * @property {boolean} [flowControl] - Gate outbound packets on the radio's
 *   CMD_READY signal (one in flight at a time). Defaults to `false` (Python:
 *   flow_control).
 * @property {number} [airtimeLimitShort] - Optional short-term airtime limit,
 *   0–100 percent (Python: airtime_limit_short).
 * @property {number} [airtimeLimitLong] - Optional long-term airtime limit,
 *   0–100 percent (Python: airtime_limit_long).
 * @property {number} [ifacSize] - Optional IFAC size in bytes. Defaults to 0.
 * @property {string} [name] - Human-readable interface name.
 * @property {number} [detectTimeout] - Seconds to wait for the detect
 *   handshake. Defaults to 5 (Python TCP/BLE detect timeout) — the serial path
 *   is near-instant.
 * @property {number} [validateTimeout] - Seconds to wait for the post-config
 *   radio-state echo. Defaults to 2 (Python `validateRadioState` sleep).
 * @property {number} [postOpenDelayMs] - Milliseconds to wait between opening
 *   the transport and probing the device, giving the firmware time to settle
 *   after the port opens. Defaults to 2000 (Python `sleep(2.0)` in
 *   `configure_device`).
 * @property {boolean} [autoReconnect] - Reconnect after the port drops.
 *   Defaults to `true`.
 * @property {number} [reconnectWait] - Seconds between attempts (default 5,
 *   matching `RNodeInterface.RECONNECT_WAIT`).
 * @property {number|null} [maxReconnectTries] - Attempt cap, or `null` for
 *   unlimited. Defaults to unlimited.
 * @property {number} [connectTimeout] - Per-attempt open timeout in seconds.
 *   Defaults to 5.
 */

/**
 * Transport-agnostic RNode interface.
 *
 * Implements the full RNode-over-KISS protocol (read loop, handshake, radio
 * configuration, flow control, stats) and leaves only the raw byte transport
 * to a backend subclass via {@link RNodeInterface#_openTransport}. This base
 * class performs no I/O and is browser-safe.
 *
 * Concrete backends:
 * - {@link import("../../../node/src/interfaces/rnode-serial.js").RNodeSerialInterface}
 *   (Node.js serial via `stty` + `node:fs`).
 *
 * Future Web Serial / Web Bluetooth backends subclass this and override
 * `_openTransport`.
 * @extends Interface
 */
export class RNodeInterface extends Interface {
  /**
   * Returns the JSON Schema for the **radio** options common to every RNode
   * backend (frequency, bandwidth, …). Backend subclasses spread this in and
   * add their transport-specific options (e.g. the serial `port`).
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "RNode Interface (base)",
      description:
        "Transport-agnostic base for LoRa RNode interfaces. Implements the " +
        "full KISS/RNode protocol; a concrete backend supplies the byte " +
        "transport. Mirrors the Python reference RNodeInterface radio " +
        "parameters.",
      properties: {
        ...base.properties,
        frequency: {
          type: "integer",
          minimum: 137000000,
          maximum: 3000000000,
          examples: [868000000],
          description: "Centre frequency in Hz (Python config key: frequency).",
        },
        bandwidth: {
          type: "integer",
          minimum: 7800,
          maximum: 1625000,
          examples: [125000],
          description: "LoRa bandwidth in Hz (Python config key: bandwidth).",
        },
        txPower: {
          type: "integer",
          minimum: 0,
          maximum: 37,
          examples: [17],
          description: "TX power in dBm (Python config key: txpower).",
        },
        spreadingFactor: {
          type: "integer",
          minimum: 5,
          maximum: 12,
          examples: [7, 8, 12],
          description:
            "LoRa spreading factor (Python config key: spreadingfactor).",
        },
        codingRate: {
          type: "integer",
          minimum: 5,
          maximum: 8,
          examples: [5, 6, 8],
          description: "LoRa coding rate (Python config key: codingrate).",
        },
        flowControl: {
          type: "boolean",
          default: false,
          description:
            "Gate outbound packets on the radio CMD_READY signal so only one " +
            "is in flight at a time (Python config key: flow_control).",
        },
        airtimeLimitShort: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Optional short-term airtime limit, percent (Python config key: " +
            "airtime_limit_short).",
        },
        airtimeLimitLong: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description:
            "Optional long-term airtime limit, percent (Python config key: " +
            "airtime_limit_long).",
        },
        detectTimeout: {
          type: "number",
          minimum: 0,
          default: 5,
          description:
            "Seconds to wait for the detect handshake response (Python " +
            "TCP/BLE detect timeout).",
        },
        validateTimeout: {
          type: "number",
          minimum: 0,
          default: 2,
          description:
            "Seconds to wait for the post-config radio-state echo (Python " +
            "validateRadioState sleep).",
        },
        ...reconnectSchemaProperties(),
      },
      required: [
        "frequency",
        "bandwidth",
        "txPower",
        "spreadingFactor",
        "codingRate",
      ],
      additionalProperties: false,
    };
  }

  /** Hardware MTU for the LoRa path, matching the Python `HW_MTU = 508`. */
  static HW_MTU = 508;
  /** Default IFAC size, matching the Python `DEFAULT_IFAC_SIZE = 8`. */
  static DEFAULT_IFAC_SIZE = 8;
  /** Minimum supported frequency in Hz. */
  static FREQ_MIN = 137000000;
  /** Maximum supported frequency in Hz. */
  static FREQ_MAX = 3000000000;
  /** RSSI offset applied to raw radio RSSI readings, matching the Python ref. */
  static RSSI_OFFSET = 157;
  /** Minimum required firmware major version. */
  static REQUIRED_FW_VER_MAJ = 1;
  /** Minimum required firmware minor version. */
  static REQUIRED_FW_VER_MIN = 52;

  /**
   * Creates an RNode interface.
   *
   * Validates the radio configuration (throwing on invalid values, matching
   * the Python reference constructor) but performs **no** I/O — call
   * {@link RNodeInterface#connect} to open the transport and bring the radio
   * up. Subclasses must implement {@link RNodeInterface#_openTransport}.
   * @param {RNodeBaseOptions} options
   */
  constructor(options) {
    super();
    this._initReconnectState({
      reconnectWait: 5,
      ...options,
    });
    this.name = options.name || "rnode";
    this.ifacSize = options.ifacSize || 0;

    this.frequency = options.frequency;
    this.bandwidth = options.bandwidth;
    this.txPower = options.txPower;
    this.sf = options.spreadingFactor;
    this.cr = options.codingRate;
    this.flowControl = options.flowControl === true;
    this.airtimeLimitShort =
      options.airtimeLimitShort === undefined
        ? null
        : options.airtimeLimitShort;
    this.airtimeLimitLong =
      options.airtimeLimitLong === undefined ? null : options.airtimeLimitLong;
    this.detectTimeout =
      options.detectTimeout === undefined ? 5 : options.detectTimeout;
    this.validateTimeout =
      options.validateTimeout === undefined ? 2 : options.validateTimeout;
    this.postOpenDelayMs =
      options.postOpenDelayMs === undefined ? 2000 : options.postOpenDelayMs;

    /** @type {any} */ this.socket = null;
    this.online = false;
    /** The initiator flag is always true for an RNode (it dials the radio). */
    this.initiator = true;
    /**
     * Nominal bitrate. Starts at 0 and is computed from the echoed LoRa
     * parameters once the radio reports them (Python parity).
     * @type {number}
     */
    this.bitrate = 0;

    // Bytes transferred (Python `rxb`/`txb`).
    this.rxb = 0;
    this.txb = 0;

    // RNode is an access-point-class medium: it can discover/announce.
    this.supportsDiscovery = true;

    this._validateConfig();

    // Radio state echoed back by the firmware (Python `r_*` fields).
    /** @type {number | null} */ this.rFrequency = null;
    /** @type {number | null} */ this.rBandwidth = null;
    /** @type {number | null} */ this.rTxPower = null;
    /** @type {number | null} */ this.rSf = null;
    /** @type {number | null} */ this.rCr = null;
    /** @type {number | null} */ this.rState = null;
    /** @type {number | null} */ this.rLock = null;
    this.rStatRssi = null;
    this.rStatSnr = null;
    this.rStatQ = null;
    this.rStatRx = null;
    this.rStatTx = null;
    this.rRandom = null;
    this.rSymbolTimeMs = null;
    this.rSymbolRate = null;
    this.rCurrentRssi = null;
    this.rNoiseFloor = null;
    this.rInterference = null;
    this.rBatteryState = 0;
    this.rBatteryPercent = 0;
    this.rTemperature = null;

    // Detect/handshake state.
    this.detected = false;
    this.fwVersionReceived = false;
    /** @type {number | null} */ this.platform = null;
    /** @type {number | null} */ this.mcu = null;
    this.majVersion = 0;
    this.minVersion = 0;
    this.firmwareOk = false;
    /** @type {{error: number, description: string}[]} */ this.hwErrors = [];

    // Flow control / outbound queue (Python `interface_ready`/`packet_queue`).
    this.interfaceReady = false;
    /** @type {import("../core/packet.js").Packet[]} */ this._packetQueue = [];

    // Read-loop state machine (see `_feedBytes`).
    this._inFrame = false;
    this._inEscape = false;
    this._command = CMD_UNKNOWN;
    /** @type {number[]} */ this._dataBuffer = [];
    /** @type {number[]} */ this._commandBuffer = [];

    // Transport handles, set in `connect()`.
    /** @type {ReadableStream<Uint8Array> | null} */ this._readableBytes = null;
    /** @type {((bytes: Uint8Array) => (Promise<void> | void)) | null} */
    this._transportWrite = null;
    /** @type {(() => (Promise<void> | void)) | null} */
    this._transportClose = null;
    /** @type {Promise<void> | null} */ this._loopPromise = null;
    /** @type {AbortController | null} */ this._readAbort = null;

    // Expose a Packet WritableStream so Transport can grab a writer in
    // `addInterface` regardless of connect ordering; writes only transmit once
    // the transport is open (gated by `online` in `_transmitPacket`).
    this._writable = new WritableStream({
      write: (/** @type {import("../core/packet.js").Packet} */ packet) =>
        this._transmitPacket(packet),
    });
  }

  /**
   * Validates the radio configuration, throwing on any out-of-range value.
   * Matches the Python reference constructor checks.
   * @private
   */
  _validateConfig() {
    const errors = [];
    if (
      this.frequency < RNodeInterface.FREQ_MIN ||
      this.frequency > RNodeInterface.FREQ_MAX
    ) {
      errors.push("frequency");
    }
    if (this.txPower < 0 || this.txPower > 37) errors.push("txPower");
    if (this.bandwidth < 7800 || this.bandwidth > 1625000) {
      errors.push("bandwidth");
    }
    if (this.sf < 5 || this.sf > 12) errors.push("spreadingFactor");
    if (this.cr < 5 || this.cr > 8) errors.push("codingRate");
    if (
      this.airtimeLimitShort !== null &&
      (this.airtimeLimitShort < 0 || this.airtimeLimitShort > 100)
    ) {
      errors.push("airtimeLimitShort");
    }
    if (
      this.airtimeLimitLong !== null &&
      (this.airtimeLimitLong < 0 || this.airtimeLimitLong > 100)
    ) {
      errors.push("airtimeLimitLong");
    }
    if (errors.length > 0) {
      throw new Error(
        `Invalid RNode configuration for ${this.name}: ${errors.join(", ")}`,
      );
    }
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.online;
  }

  /**
   * The outbound Packet stream. Transport acquires a writer in `addInterface`;
   * each written packet is KISS-framed as a data frame and sent once the radio
   * is online and ready (see {@link RNodeInterface#send}).
   * @returns {WritableStream<import("../core/packet.js").Packet> | null}
   */
  get writable() {
    return this._writable;
  }

  /**
   * Not used: RNode inbound is event-driven (the internal read loop dispatches
   * `packet` events directly). Returns `null`.
   * @returns {null}
   */
  get readable() {
    return null;
  }

  // -----------------------------------------------------------------------
  // Transport hook — backends implement this.
  // -----------------------------------------------------------------------

  /**
   * Opens the raw byte transport to the RNode and returns the inbound readable,
   * outbound writer, and closer. The base class is transport-agnostic; a
   * backend subclass (Node.js serial, Web Serial, Web Bluetooth, …) must
   * override this.
   * @returns {RNodeTransport}
   * @protected
   */
  _openTransport() {
    throw new Error(
      "RNodeInterface._openTransport must be implemented by a backend " +
        "subclass (e.g. RNodeSerialInterface).",
    );
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /**
   * Opens the transport, runs the detect → configure → validate handshake, and
   * brings the radio online.
   *
   * On a first-attempt failure with auto-reconnect enabled, the promise rejects
   * (so the caller knows) but the reconnect loop keeps retrying in the
   * background — matching the Python reference, which spawns a reconnect thread
   * on the first failure.
   * @returns {Promise<void>}
   */
  async connect() {
    this.initiator = true;
    try {
      await this._establishConnection();
    } catch (e) {
      if (this.autoReconnect && !this.detached) {
        this._runReconnectLoop();
      }
      throw e;
    }
  }

  /**
   * Opens the transport and configures the radio. Used both for the initial
   * connection and for each reconnect attempt.
   * @returns {Promise<void>} Resolves once the radio is online.
   * @protected
   */
  async _establishConnection() {
    // Close any transport left over from a dropped connection before opening a
    // fresh one (otherwise reconnecting after e.g. a USB unplug leaks the fd).
    await this._closeTransportSafely();
    const transport = this._openTransport();
    this._readableBytes = transport.readable;
    this._transportWrite = transport.write;
    this._transportClose = transport.close;
    this._closed = false;
    try {
      await this._configureDevice();
    } catch (e) {
      // Tear down the half-open transport before surfacing the failure.
      await this._closeTransportSafely();
      throw e;
    }
    this.online = true;
    this.dispatchEvent(new CustomEvent("connected"));
  }

  /**
   * Powers the radio down, sends the host-leave command, closes the transport,
   * and cancels any pending reconnect. Dispatches `disconnected` then a
   * terminal `closed`.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this._cancelReconnect();
    this.detached = true;
    if (this.online) {
      try {
        this._sendCommand(CMD_RADIO_STATE, [RADIO_STATE_OFF]);
        this.leave();
      } catch (e) {
        log(
          this.name,
          `Error while powering down radio: ${/** @type {any} */ (e).message}`,
          LogLevel.ERROR,
        );
      }
    }
    this.online = false;
    await this._closeTransportSafely();
    this.dispatchEvent(new CustomEvent("disconnected"));
    this._dispatchClosed();
    if (this._loopPromise) {
      await this._loopPromise;
    }
  }

  /**
   * Stops the read loop (if running) and closes the transport, swallowing
   * errors (best-effort teardown).
   * @returns {Promise<void>}
   * @private
   */
  async _closeTransportSafely() {
    this._stopReadLoop();
    if (this._transportClose) {
      try {
        await this._transportClose();
      } catch (e) {
        log(
          this.name,
          `Error closing transport: ${/** @type {any} */ (e).message}`,
          LogLevel.DEBUG,
        );
      }
    }
    this._readableBytes = null;
    this._transportWrite = null;
    this._transportClose = null;
  }

  // -----------------------------------------------------------------------
  // Handshake: detect → initRadio → validate (Python `configure_device`)
  // -----------------------------------------------------------------------

  /**
   * Brings up the radio: starts the read loop, detects the hardware, applies
   * the radio configuration, and validates the echoed state. Throws on failure.
   * @returns {Promise<void>}
   * @private
   */
  async _configureDevice() {
    this._resetRadioState();
    this._startReadLoop();
    // Mirrors the Python `sleep(2.0)` before kicking off detection, giving the
    // firmware a moment after the port opens.
    if (this.postOpenDelayMs > 0) await sleep(this.postOpenDelayMs);

    this.detect();
    const detected = await this._waitFor(
      () => this.detected,
      this.detectTimeout * 1000,
      "detect",
    );
    if (!detected) {
      throw new Error(`Could not detect RNode device for ${this.name}`);
    }
    // The firmware version is reported asynchronously (in response to the
    // CMD_FW_VERSION probe sent by `detect()`). Wait for it, then validate; if
    // the device never reports a version, warn and proceed (Python only aborts
    // when a *too-old* version is reported, not when none is).
    const gotFw = await this._waitFor(
      () => this.fwVersionReceived,
      this.detectTimeout * 1000,
      "firmware version",
    );
    if (gotFw) {
      this._validateFirmware();
    } else {
      log(
        this.name,
        "RNode did not report a firmware version",
        LogLevel.WARNING,
      );
    }

    log(this.name, "Configuring RNode interface...", LogLevel.VERBOSE);
    this._initRadio();

    if (!(await this._validateRadioState())) {
      throw new Error(
        `Radio parameters for ${this.name} did not match the configuration; ` +
          "aborting RNode startup.",
      );
    }
    this.interfaceReady = true;
    log(this.name, `${this} is configured and powered up`);
  }

  /**
   * Sends the detect + firmware/platform/MCU query sequence, matching the
   * Python `detect()` byte-for-byte (four frames sharing FEND boundaries).
   */
  detect() {
    const frame = new Uint8Array([
      FEND,
      CMD_DETECT,
      DETECT_REQ,
      FEND,
      CMD_FW_VERSION,
      0x00,
      FEND,
      CMD_PLATFORM,
      0x00,
      FEND,
      CMD_MCU,
      0x00,
      FEND,
    ]);
    this._rawWrite(frame);
  }

  /** Sends the host-leave command (Python `leave()`). */
  leave() {
    this._sendCommand(CMD_LEAVE, [0xff]);
  }

  /**
   * Applies the configured radio parameters and powers the radio on. Mirrors
   * the Python `initRadio()` ordering.
   * @private
   */
  _initRadio() {
    this._setFrequency();
    this._setBandwidth();
    this._setTxPower();
    this._setSpreadingFactor();
    this._setCodingRate();
    this._setAirtimeLock(CMD_ST_ALOCK, this.airtimeLimitShort);
    this._setAirtimeLock(CMD_LT_ALOCK, this.airtimeLimitLong);
    this._setRadioState(RADIO_STATE_ON);
  }

  /** @private */
  _setFrequency() {
    this._sendCommand(CMD_FREQUENCY, uint32Be(this.frequency), true);
  }

  /** @private */
  _setBandwidth() {
    this._sendCommand(CMD_BANDWIDTH, uint32Be(this.bandwidth), true);
  }

  /** @private */
  _setTxPower() {
    this._sendCommand(CMD_TXPOWER, [this.txPower & 0xff]);
  }

  /** @private */
  _setSpreadingFactor() {
    this._sendCommand(CMD_SF, [this.sf & 0xff]);
  }

  /** @private */
  _setCodingRate() {
    this._sendCommand(CMD_CR, [this.cr & 0xff]);
  }

  /**
   * Sends a short/long-term airtime-limit command if configured.
   * @param {number} command - CMD_ST_ALOCK or CMD_LT_ALOCK.
   * @param {number | null} percent - The limit in percent, or null to skip.
   * @private
   */
  _setAirtimeLock(command, percent) {
    if (percent === null) return;
    const at = Math.trunc(percent * 100);
    this._sendCommand(command, [(at >> 8) & 0xff, at & 0xff], true);
  }

  /**
   * Sets the radio power state (on/off). Mirrors Python `setRadioState`.
   * @param {number} state - RADIO_STATE_ON / RADIO_STATE_OFF.
   * @private
   */
  _setRadioState(state) {
    this._sendCommand(CMD_RADIO_STATE, [state]);
  }

  /**
   * Validates that the firmware meets the minimum required version. Throws if
   * it does not (Python panics; we surface a config error instead).
   * @private
   */
  _validateFirmware() {
    this.firmwareOk =
      this.majVersion > RNodeInterface.REQUIRED_FW_VER_MAJ ||
      (this.majVersion >= RNodeInterface.REQUIRED_FW_VER_MAJ &&
        this.minVersion >= RNodeInterface.REQUIRED_FW_VER_MIN);
    if (!this.firmwareOk) {
      throw new Error(
        `RNode firmware ${this.majVersion}.${this.minVersion} on ${this.name} ` +
          `is too old; requires >= ` +
          `${RNodeInterface.REQUIRED_FW_VER_MAJ}.${RNodeInterface.REQUIRED_FW_VER_MIN}.`,
      );
    }
  }

  /**
   * Waits for the radio to echo back its configured parameters, then compares
   * them against the requested configuration. Mirrors Python
   * `validateRadioState` (with a wait instead of a fixed sleep for robustness).
   * @returns {Promise<boolean>}
   * @private
   */
  async _validateRadioState() {
    const got = await this._waitFor(
      () =>
        this.rFrequency !== null &&
        this.rBandwidth !== null &&
        this.rTxPower !== null &&
        this.rSf !== null &&
        this.rState !== null,
      this.validateTimeout * 1000,
      "radio state",
    );
    if (!got) return false;
    let ok = true;
    if (Math.abs(this.frequency - (this.rFrequency ?? 0)) > 100) {
      log(this.name, "Frequency mismatch", LogLevel.ERROR);
      ok = false;
    }
    if (this.bandwidth !== this.rBandwidth) {
      log(this.name, "Bandwidth mismatch", LogLevel.ERROR);
      ok = false;
    }
    if (this.txPower !== this.rTxPower) {
      log(this.name, "TX power mismatch", LogLevel.ERROR);
      ok = false;
    }
    if (this.sf !== this.rSf) {
      log(this.name, "Spreading factor mismatch", LogLevel.ERROR);
      ok = false;
    }
    if (this.rState !== RADIO_STATE_ON) {
      log(this.name, "Radio state mismatch", LogLevel.ERROR);
      ok = false;
    }
    return ok;
  }

  /** Resets the echoed radio state and detect flags. @private */
  _resetRadioState() {
    this.rFrequency = null;
    this.rBandwidth = null;
    this.rTxPower = null;
    this.rSf = null;
    this.rCr = null;
    this.rState = null;
    this.rLock = null;
    this.detected = false;
    this.fwVersionReceived = false;
    this.majVersion = 0;
    this.minVersion = 0;
    this.firmwareOk = false;
  }

  // -----------------------------------------------------------------------
  // Outbound: framing + flow control (Python `process_outgoing`/`process_queue`)
  // -----------------------------------------------------------------------

  /**
   * Sends a packet, honouring flow control. If the radio is online and ready
   * the packet is transmitted immediately (and, with flow control, the next one
   * is gated on CMD_READY); otherwise it is queued for later. Mirrors the
   * Python reference `process_outgoing`.
   * @param {import("../core/packet.js").Packet} packet
   */
  async send(packet) {
    if (this.online && this.interfaceReady) {
      if (this.flowControl) this.interfaceReady = false;
      await this._transmitPacket(packet);
    } else {
      this._packetQueue.push(packet);
    }
  }

  /**
   * Frames a packet as a KISS data frame and writes it to the transport.
   * @param {import("../core/packet.js").Packet} packet
   * @returns {Promise<void>}
   * @private
   */
  async _transmitPacket(packet) {
    if (!this.online || !this._transportWrite) {
      throw new Error(`RNode interface ${this.name} is not ready`);
    }
    const raw = packet.serialize();
    this.txb += raw.length;
    await this._rawWrite(kissFrame(raw));
  }

  /**
   * Drains one queued packet on CMD_READY (or marks the interface ready when the
   * queue is empty). Mirrors the Python reference `process_queue`.
   * @private
   */
  _processQueue() {
    if (this._packetQueue.length > 0) {
      const packet = /** @type {import("../core/packet.js").Packet} */ (
        this._packetQueue.shift()
      );
      this.interfaceReady = true;
      // Fire-and-forget: a failure here surfaces via the read-loop error path.
      this._transmitPacket(packet).catch((/** @type {any} */ e) =>
        log(this.name, `Queue transmit failed: ${e.message}`, LogLevel.ERROR),
      );
    } else {
      this.interfaceReady = true;
    }
  }

  // -----------------------------------------------------------------------
  // Low-level KISS command construction
  // -----------------------------------------------------------------------

  /**
   * Writes already-framed bytes to the transport. Throws if the transport is
   * not open.
   * @param {Uint8Array} frame
   * @private
   */
  _rawWrite(frame) {
    if (!this._transportWrite) {
      throw new Error(`RNode interface ${this.name} transport is not open`);
    }
    const ret = this._transportWrite(frame);
    if (ret && typeof ret.then === "function") {
      return ret;
    }
    return Promise.resolve();
  }

  /**
   * Builds and writes a single KISS command frame: `FEND | command | payload | FEND`.
   * The payload is KISS-escaped only when `escape` is set (frequency/bandwidth/
   * airtime-lock payloads carry bytes that may collide with FEND/FESC; the
   * single-byte commands and detect/leave do not). Mirrors the per-command
   * `KISS.escape` usage in the Python reference.
   * @param {number} command
   * @param {number[]} payload
   * @param {boolean} [escapePayload=false]
   * @private
   */
  _sendCommand(command, payload, escapePayload = false) {
    const raw = new Uint8Array(payload);
    const data = escapePayload ? kissEscape(raw) : raw;
    const frame = new Uint8Array(data.length + 3);
    frame[0] = FEND;
    frame[1] = command;
    frame.set(data, 2);
    frame[frame.length - 1] = FEND;
    this._rawWrite(frame);
  }

  // -----------------------------------------------------------------------
  // Inbound: the KISS read-loop state machine (Python `readLoop`)
  // -----------------------------------------------------------------------

  /**
   * Starts (or restarts) the inbound read loop that feeds the KISS state
   * machine. The loop runs until the transport closes or {@link RNodeInterface#_stopReadLoop}
   * aborts it.
   * @private
   */
  _startReadLoop() {
    this._stopReadLoop();
    this._readAbort = new AbortController();
    this._loopPromise = this._readLoop(this._readAbort.signal);
  }

  /** @private */
  _stopReadLoop() {
    if (this._readAbort) {
      this._readAbort.abort();
      this._readAbort = null;
    }
  }

  /**
   * Reads raw bytes from the transport and feeds them to the KISS state
   * machine. On an unintentional termination (not aborted) it triggers
   * connection-loss handling / reconnect.
   * @param {AbortSignal} signal
   * @private
   */
  async _readLoop(signal) {
    if (!this._readableBytes) return;
    const reader = this._readableBytes.getReader();
    let lost = false;
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          lost = true;
          break;
        }
        if (value) this._feedBytes(value);
      }
    } catch (e) {
      lost = true;
      if (!signal.aborted) {
        const err = /** @type {any} */ (e);
        if (err.name !== "AbortError" && err.code !== "ABORT_ERR") {
          log(this.name, `Read error: ${err.message}`, LogLevel.ERROR);
          this.dispatchEvent(new CustomEvent("error", { detail: err }));
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_e) {
        // already released
      }
      if (lost && !signal.aborted) {
        this.online = false;
        this._handleConnectionLost();
      }
    }
  }

  /**
   * Feeds a chunk of raw bytes through the KISS state machine, dispatching
   * `packet` events for CMD_DATA frames and updating radio state for every
   * other command. A byte-for-byte port of the Python reference `readLoop`,
   * including escape handling, the HW_MTU guard, and the per-command payload
   * lengths.
   *
   * Throws on `CMD_ERROR` `ERROR_INITRADIO`/`ERROR_TXFAILED` (matching the
   * Python reference, which raises `IOError` out of the read loop) — the
   * caller's read loop turns that into a connection loss.
   * @param {Uint8Array} chunk
   * @private
   */
  _feedBytes(chunk) {
    for (let idx = 0; idx < chunk.length; idx++) {
      const byte = chunk[idx];

      // A FEND both closes a CMD_DATA frame (processing it) and opens a new one.
      if (this._inFrame && byte === FEND && this._command === CMD_DATA) {
        this._inFrame = false;
        this._processIncoming(this._dataBuffer);
        this._dataBuffer = [];
        this._commandBuffer = [];
        this._inEscape = false;
        continue;
      }
      if (byte === FEND) {
        this._inFrame = true;
        this._command = CMD_UNKNOWN;
        this._dataBuffer = [];
        this._commandBuffer = [];
        this._inEscape = false;
        continue;
      }
      if (!this._inFrame) continue;
      // Python guards the whole byte-processing branch on
      // `len(data_buffer) < HW_MTU`; once exceeded, further frame bytes are
      // silently dropped until the next FEND.
      if (this._dataBuffer.length >= RNodeInterface.HW_MTU) continue;

      // The first in-frame byte is the command.
      if (this._dataBuffer.length === 0 && this._command === CMD_UNKNOWN) {
        this._command = byte;
        continue;
      }

      this._handleCommandByte(this._command, byte);
    }
  }

  /**
   * Dispatches a single in-frame byte to its command handler. Multi-byte
   * command payloads accumulate in `_commandBuffer` (with KISS unescaping) and
   * are acted on once they reach the command's expected length.
   * @param {number} command
   * @param {number} byte
   * @private
   */
  _handleCommandByte(command, byte) {
    switch (command) {
      case CMD_DATA:
        // Data frames are unescaped into `_dataBuffer` and emitted on the
        // closing FEND (see `_feedBytes`).
        if (byte === FESC) {
          this._inEscape = true;
        } else if (this._inEscape) {
          this._dataBuffer.push(this._transposeEscape(byte));
          this._inEscape = false;
        } else {
          this._dataBuffer.push(byte);
        }
        return;

      case CMD_DETECT:
        this.detected = byte === DETECT_RESP;
        return;

      case CMD_PLATFORM:
        this.platform = byte;
        return;

      case CMD_MCU:
        this.mcu = byte;
        return;

      case CMD_TXPOWER:
        this.rTxPower = byte;
        log(
          this.name,
          `Radio reporting TX power is ${this.rTxPower} dBm`,
          LogLevel.DEBUG,
        );
        return;

      case CMD_SF:
        this.rSf = byte;
        log(
          this.name,
          `Radio reporting spreading factor is ${this.rSf}`,
          LogLevel.DEBUG,
        );
        this._updateBitrate();
        return;

      case CMD_CR:
        this.rCr = byte;
        log(
          this.name,
          `Radio reporting coding rate is ${this.rCr}`,
          LogLevel.DEBUG,
        );
        this._updateBitrate();
        return;

      case CMD_RADIO_STATE:
        this.rState = byte;
        if (!byte)
          log(this.name, "Radio reporting state is offline", LogLevel.DEBUG);
        return;

      case CMD_RADIO_LOCK:
        this.rLock = byte;
        return;

      case CMD_READY:
        // Flow-control signal: the radio can accept the next packet.
        this._processQueue();
        return;

      case CMD_RANDOM:
        this.rRandom = byte;
        return;

      case CMD_STAT_RSSI:
        this.rStatRssi = byte - RNodeInterface.RSSI_OFFSET;
        return;

      case CMD_STAT_SNR:
        this.rStatSnr = int8(byte) * 0.25;
        this._updateQuality();
        return;

      case CMD_RESET:
        // ESP32 reports a reset with 0xF8; surface it as a connection loss so
        // the device is reinitialised (Python parity).
        if (byte === 0xf8 && this.platform === PLATFORM_ESP32 && this.online) {
          throw new Error("ESP32 reset");
        }
        return;

      case CMD_ERROR:
        this._handleErrorByte(byte);
        return;

      default:
        // Multi-byte commands with escaped payloads: accumulate + act on length.
        if (this._appendEscaped(this._commandBuffer, byte)) return;
        this._handleMultiByteCommand(command);
    }
  }

  /**
   * Acts on a multi-byte command once its payload has reached the expected
   * length (otherwise just returns, waiting for more bytes).
   * @param {number} command
   * @private
   */
  _handleMultiByteCommand(command) {
    const buf = this._commandBuffer;
    switch (command) {
      case CMD_FREQUENCY:
        if (buf.length === 4) {
          this.rFrequency = uint32BeDecode(buf);
          log(
            this.name,
            `Radio reporting frequency is ${this.rFrequency / 1e6} MHz`,
            LogLevel.DEBUG,
          );
          this._updateBitrate();
        }
        return;
      case CMD_BANDWIDTH:
        if (buf.length === 4) {
          this.rBandwidth = uint32BeDecode(buf);
          log(
            this.name,
            `Radio reporting bandwidth is ${this.rBandwidth / 1000} KHz`,
            LogLevel.DEBUG,
          );
          this._updateBitrate();
        }
        return;
      case CMD_FW_VERSION:
        if (buf.length === 2) {
          this.majVersion = buf[0];
          this.minVersion = buf[1];
          this.fwVersionReceived = true;
        }
        return;
      case CMD_STAT_RX:
        if (buf.length === 4) {
          this.rStatRx = uint32BeDecode(buf);
        }
        return;
      case CMD_STAT_TX:
        if (buf.length === 4) {
          this.rStatTx = uint32BeDecode(buf);
        }
        return;
      case CMD_STAT_CHTM:
        if (buf.length === 11) {
          this.rCurrentRssi = buf[8] - RNodeInterface.RSSI_OFFSET;
          this.rNoiseFloor = buf[9] - RNodeInterface.RSSI_OFFSET;
          this.rInterference =
            buf[10] === 0xff ? null : buf[10] - RNodeInterface.RSSI_OFFSET;
        }
        return;
      case CMD_STAT_PHYPRM:
        if (buf.length === 12) {
          this.rSymbolTimeMs = uint16(buf, 0) / 1000.0;
          this.rSymbolRate = uint16(buf, 2);
        }
        return;
      case CMD_STAT_BAT:
        if (buf.length === 2) {
          this.rBatteryState = buf[0];
          this.rBatteryPercent = Math.max(0, Math.min(100, buf[1]));
        }
        return;
      case CMD_STAT_TEMP:
        if (buf.length === 1) {
          const temp = buf[0] - 120;
          this.rTemperature = temp >= -30 && temp <= 90 ? temp : null;
        }
        return;
      case CMD_ST_ALOCK:
        if (buf.length === 2) {
          log(
            this.name,
            `Radio reporting short-term airtime limit is ${uint16(buf, 0) / 100}%`,
            LogLevel.DEBUG,
          );
        }
        return;
      case CMD_LT_ALOCK:
        if (buf.length === 2) {
          log(
            this.name,
            `Radio reporting long-term airtime limit is ${uint16(buf, 0) / 100}%`,
            LogLevel.DEBUG,
          );
        }
        return;
      default:
      // Unknown multi-byte command: nothing to do.
    }
  }

  /**
   * Handles a CMD_ERROR byte. INITRADIO/TXFAILED abort the read loop (matching
   * the Python IOError); MEMORY_LOW/MODEM_TIMEOUT are recorded.
   * @param {number} byte
   * @private
   */
  _handleErrorByte(byte) {
    if (byte === ERROR_INITRADIO) {
      throw new Error("RNode radio initialisation failure");
    }
    if (byte === ERROR_TXFAILED) {
      throw new Error("RNode hardware transmit failure");
    }
    if (byte === ERROR_MEMORY_LOW) {
      this.hwErrors.push({ error: byte, description: "Memory exhausted" });
      log(this.name, "RNode hardware error: Memory exhausted", LogLevel.ERROR);
      return;
    }
    if (byte === ERROR_MODEM_TIMEOUT) {
      this.hwErrors.push({
        error: byte,
        description: "Modem communication timed out",
      });
      log(
        this.name,
        "RNode hardware error: Modem communication timed out",
        LogLevel.ERROR,
      );
      return;
    }
    throw new Error(
      `RNode unknown hardware failure (code 0x${byte.toString(16)})`,
    );
  }

  /**
   * Dispatches a complete CMD_DATA payload as a `packet` event. Mirrors the
   * Python reference `process_incoming`.
   * @param {number[]} dataBuffer
   * @private
   */
  _processIncoming(dataBuffer) {
    const data = new Uint8Array(dataBuffer);
    this.rxb += data.length;
    this.rStatRssi = null;
    this.rStatSnr = null;
    try {
      let toDeserialize = data;
      if (this.ifacSize > 0) {
        toDeserialize = data.slice(2 + this.ifacSize);
      }
      const packet = Packet.deserialize(toDeserialize);
      this.dispatchEvent(new CustomEvent("packet", { detail: { packet } }));
    } catch (e) {
      log(
        this.name,
        `Failed to process incoming frame: ${/** @type {any} */ (e).message}`,
        LogLevel.ERROR,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Small helpers
  // -----------------------------------------------------------------------

  /**
   * Pushes a (possibly transposed) byte onto `buffer`, consuming KISS escape
   * sequences. Returns `true` when `byte` was an FESC marker (and the caller
   * should skip the push); `false` once the byte has been pushed.
   * @param {number[]} buffer
   * @param {number} byte
   * @returns {boolean}
   * @private
   */
  _appendEscaped(buffer, byte) {
    if (byte === FESC) {
      this._inEscape = true;
      return true;
    }
    if (this._inEscape) {
      buffer.push(this._transposeEscape(byte));
      this._inEscape = false;
    } else {
      buffer.push(byte);
    }
    return false;
  }

  /**
   * Resolves a transposed escape byte to its literal value. Matches the Python
   * reference (TFEND → FEND, TFESC → FESC, anything else passes through).
   * @param {number} byte
   * @returns {number}
   * @private
   */
  _transposeEscape(byte) {
    if (byte === TFEND) return FEND;
    if (byte === TFESC) return FESC;
    return byte;
  }

  /** Recomputes the nominal on-air bitrate from the echoed LoRa params. */
  _updateBitrate() {
    if (this.rSf && this.rCr && this.rBandwidth) {
      this.bitrate =
        this.rSf *
        (4.0 / this.rCr / (2 ** this.rSf / (this.rBandwidth / 1000))) *
        1000;
      log(
        this.name,
        `On-air bitrate is ${Math.round(this.bitrate / 100) / 10} kbps`,
        LogLevel.VERBOSE,
      );
    }
  }

  /** Derives a 0–100 link-quality figure from the latest SNR reading. */
  _updateQuality() {
    if (this.rStatSnr === null || !this.rSf) return;
    const sfs = this.rSf - 7;
    const qSnrMin = -9 - sfs * 2;
    const qSnrMax = 6;
    let quality = ((this.rStatSnr - qSnrMin) / (qSnrMax - qSnrMin)) * 100;
    quality = Math.max(0, Math.min(100, quality));
    this.rStatQ = Math.round(quality * 10) / 10;
  }

  /**
   * Resolves once `predicate` returns true, or after `timeoutMs`. Returns the
   * final predicate value (so callers can distinguish a real hit from a
   * timeout). Polls at 50ms, mirroring the Python reference's polling waits.
   * @param {() => boolean} predicate
   * @param {number} timeoutMs
   * @param {string} what
   * @returns {Promise<boolean>}
   * @private
   */
  async _waitFor(predicate, timeoutMs, what) {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        log(this.name, `${what} timed out`, LogLevel.WARNING);
        return false;
      }
      await sleep(50);
    }
    return true;
  }

  /** @returns {string} */
  toString() {
    return `RNodeInterface[${this.name}]`;
  }
}

// ---------------------------------------------------------------------------
// Pure byte helpers
// ---------------------------------------------------------------------------

/**
 * Big-endian 32-bit encoding of a non-negative integer into 4 bytes.
 * @param {number} value
 * @returns {number[]}
 */
function uint32Be(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/**
 * Big-endian 32-bit decode from a 4-byte buffer.
 * @param {number[] | Uint8Array} buf
 * @returns {number}
 */
function uint32BeDecode(buf) {
  return (
    ((buf[0] << 24) >>> 0) |
    ((buf[1] << 16) & 0xff0000) |
    ((buf[2] << 8) & 0xff00) |
    (buf[3] & 0xff)
  );
}

/**
 * Big-endian 16-bit decode at the given offset.
 * @param {number[] | Uint8Array} buf
 * @param {number} offset
 * @returns {number}
 */
function uint16(buf, offset) {
  return ((buf[offset] & 0xff) << 8) | (buf[offset + 1] & 0xff);
}

/**
 * Interprets a byte as a signed 8-bit integer.
 * @param {number} byte
 * @returns {number}
 */
function int8(byte) {
  return byte & 0x80 ? byte - 0x100 : byte;
}

/**
 * Promise-based sleep.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
