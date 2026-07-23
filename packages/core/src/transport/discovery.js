/**
 * @file discovery.js
 * @description On-network interface discovery — consumer side. Mirrors the
 *   consumer half of `RNS/Discovery.py` (`InterfaceAnnounceHandler` +
 *   `InterfaceDiscovery`, verified against RNS 1.4.0).
 *
 *   A transport node announces its connectable interfaces on the
 *   `rnstransport.discovery.interface` announce aspect, LXMF-stamped against
 *   abuse. This module lets a leaf node *discover* those announces: parse the
 *   msgpack `info` dict, validate the trailing LXMF stamp, surface the
 *   normalized record via an EventTarget, and (optionally) persist it across
 *   restarts.
 *
 *   The producer side (`InterfaceAnnouncer`) is transport-node territory and
 *   is intentionally not implemented here. Only the stamp/encode primitives
 *   needed to test the parser are exposed (`generateDiscoveryStamp`,
 *   `buildDiscoveryAppData`).
 *
 *   Aspect filtering reuses the transport's existing `"announce"` EventTarget
 *   event (no separate announce-handler registry): the discovery aspect's
 *   10-byte `name_hash` is precomputed once and compared against each
 *   announce's `nameHash`.
 */

import { Identity } from "../core/identity.js";
import {
  generateStamp,
  STAMP_SIZE,
  stampValid,
  stampValue,
  stampWorkblock,
} from "../lxmf/stamper.js";
import { bytesEqual, concatBytes, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { MicroMsgPack } from "../utils/msgpack.js";

// ---------------------------------------------------------------------
// Constants (RNS/Discovery.py)
// ---------------------------------------------------------------------

/** Application name for the interface-discovery destination family. */
export const APP_NAME = "rnstransport";
/**
 * Full announce aspect the discovery announce handler filters on
 * (`APP_NAME + ".discovery.interface"`).
 */
export const ASPECT = `${APP_NAME}.discovery.interface`;

/**
 * Default required LXMF stamp value (leading zero bits) for a discovery
 * announce. RNS 1.4.0 raised this from 14 (1.3.x) to 16; it is configurable
 * per-network via {@link InterfaceDiscoveryOptions.requiredValue}.
 */
export const DEFAULT_STAMP_VALUE = 16;

/**
 * HKDF expansion rounds for the discovery stamp workblock. Deliberately cheap
 * (vs LXMF messages' 3000): discovery is high-frequency and store-and-forward.
 */
export const WORKBLOCK_EXPAND_ROUNDS = 20;

/** Discovery announce `app_data` flag bits (the leading flags byte). */
export const FLAG_SIGNED = 0b00000001;
/** Discovery announce `app_data` flag bit: payload encrypted to a network identity. */
export const FLAG_ENCRYPTED = 0b00000010;

// msgpack `info` dict keys (small ints; see RNS/Discovery.py).
/** Interface type string (e.g. `"TCPServerInterface"`). */
export const NAME = 0xff;
/** 16-byte transport identity hash (`bytes`). */
export const TRANSPORT_ID = 0xfe;
/** Interface type string. */
export const INTERFACE_TYPE = 0x00;
/** Whether the announcer is a transport node (`bool`). */
export const TRANSPORT = 0x01;
/** Hostname/IP a leaf can reach the interface on (`str`). */
export const REACHABLE_ON = 0x02;
/** Geographic latitude (`float | nil`). */
export const LATITUDE = 0x03;
/** Geographic longitude (`float | nil`). */
export const LONGITUDE = 0x04;
/** Geographic height in metres (`float | nil`). */
export const HEIGHT = 0x05;
/** TCP/UDP port (`int`). */
export const PORT = 0x06;
/** Interface activation network name (`str`). */
export const IFAC_NETNAME = 0x07;
/** Interface activation network key / passphrase (`str`). */
export const IFAC_NETKEY = 0x08;
/** Radio frequency in Hz (`int`). */
export const FREQUENCY = 0x09;
/** Radio bandwidth (`int`). */
export const BANDWIDTH = 0x0a;
/** LoRa spreading factor (`int`). */
export const SPREADINGFACTOR = 0x0b;
/** LoRa coding rate (`int`). */
export const CODINGRATE = 0x0c;
/** Modulation (`str`). */
export const MODULATION = 0x0d;
/** Radio channel (`int`). */
export const CHANNEL = 0x0e;

/**
 * Interface types the announce *handler* accepts (`DISCOVERABLE_INTERFACE_TYPES`
 * in Python — includes `TCPClientInterface` because a KISS-over-TCP interface
 * is announced under that type before being rewritten to `KISSInterface`).
 */
export const ACCEPTED_INTERFACE_TYPES = Object.freeze([
  "BackboneInterface",
  "TCPServerInterface",
  "TCPClientInterface",
  "RNodeInterface",
  "WeaveInterface",
  "I2PInterface",
  "KISSInterface",
]);

/**
 * Interface types the discovery orchestrator surfaces/persists
 * (`DISCOVERABLE_TYPES` in Python — narrower than {@link ACCEPTED_INTERFACE_TYPES}:
 * a bare `TCPClientInterface` is parsed but not listed).
 */
export const DISCOVERABLE_TYPES = Object.freeze([
  "BackboneInterface",
  "TCPServerInterface",
  "I2PInterface",
  "RNodeInterface",
  "WeaveInterface",
  "KISSInterface",
]);

// --- freshness thresholds (seconds) ---
/** Age after which a discovered interface is `unknown` (1 day). */
export const THRESHOLD_UNKNOWN = 24 * 60 * 60;
/** Age after which a discovered interface is `stale` (3 days). */
export const THRESHOLD_STALE = 3 * 24 * 60 * 60;
/** Age after which a discovered interface record is purged (7 days). */
export const THRESHOLD_REMOVE = 7 * 24 * 60 * 60;

// --- status codes (ordered so that higher == fresher/more desirable) ---
/** Status code for a stale (old) discovered interface. */
export const STATUS_STALE = 0;
/** Status code for a discovered interface heard too long ago to trust. */
export const STATUS_UNKNOWN = 100;
/** Status code for a fresh discovered interface. */
export const STATUS_AVAILABLE = 1000;

/**
 * ASCII characters allowed by {@link sanitizeName} at the name's edges
 * (digits, upper- and lower-case letters) — matches Python's `san_map`.
 */
const SAN_MAP =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

/**
 * Returns the current time as Unix seconds (Python `time.time()` equivalent),
 * preserving fractional precision.
 * @returns {number}
 */
function nowSeconds() {
  return Date.now() / 1000;
}

/**
 * Precomputes the 10-byte announce `name_hash` for a given aspect string
 * (`SHA-256(aspect)[:10]`). Used to aspect-filter the transport `"announce"`
 * event without a separate announce-handler registry.
 * @param {string} aspect
 * @returns {Promise<Uint8Array>}
 */
export async function aspectNameHash(aspect) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    /** @type {any} */ (new TextEncoder().encode(aspect)),
  );
  return new Uint8Array(digest.slice(0, 10));
}

/**
 * Sanitizes a discovered-interface display name (Python
 * `InterfaceAnnounceHandler.sanitize_name`).
 *
 * Strips non-ASCII, collapses runs of 2+ spaces, then trims leading/trailing
 * characters that aren't alphanumeric. Returns `null` for an empty/falsy input.
 * @param {unknown} name
 * @returns {string|null}
 */
export function sanitizeName(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  // ASCII-only, ignoring everything else (Python encode ascii ignore).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII range (0x00-0x7f) strip
  let s = name.replace(/[^\x00-\x7f]/g, "").trim();
  // Collapse runs of 5, then 3, then 2 spaces into one space.
  for (const len of [5, 3, 2]) {
    s = s.split(" ".repeat(len)).join(" ");
  }
  while (s.length > 0 && !SAN_MAP.includes(s[0])) s = s.slice(1);
  while (
    s.length > 0 &&
    !(SAN_MAP.includes(s[s.length - 1]) || s[s.length - 1] === ")")
  ) {
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * Tests whether a string is a valid IPv4 or IPv6 address (Python
 * `ipaddress.ip_address` equivalent for discovery's sanity check).
 * @param {string} str
 * @returns {boolean}
 */
export function isIpAddress(str) {
  if (typeof str !== "string" || str.length === 0) return false;
  // IPv6 contains a colon; IPv4 never does.
  if (str.includes(":")) return isValidIPv6(str);
  const parts = str.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(p));
}

/**
 * @param {string} str
 * @returns {boolean}
 */
function isValidIPv6(str) {
  // At most one "::" run of compressed zero groups.
  const doubleColons = str.match(/::/g);
  if (doubleColons && doubleColons.length > 1) return false;
  const parts = str.split(":");
  // A bare "::" splits into ["", ""], which is valid (all zeros).
  const groups = parts.filter((p) => p !== "");
  // Without compression there must be exactly 8 groups.
  if (!doubleColons && parts.length !== 8) return false;
  // With compression, at least one group slot is elided.
  if (doubleColons && groups.length > 7) return false;
  return groups.every((g, i) => {
    // The trailing group(s) may embed an IPv4-mapped suffix (e.g. ::ffff:1.2.3.4).
    if (g.includes(".")) return isIpAddress(g);
    // Each group is 1-4 hex digits.
    return /^[0-9a-f]{1,4}$/i.test(g) && i >= 0;
  });
}

/**
 * Tests whether a string is a syntactically valid DNS hostname (Python
 * `is_hostname`).
 * @param {string} hostname
 * @returns {boolean}
 */
export function isHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  if (hostname[hostname.length - 1] === ".") hostname = hostname.slice(0, -1);
  if (hostname.length === 0 || hostname.length > 253) return false;
  const components = hostname.split(".");
  // A trailing all-numeric label looks like an (invalid) IP, not a hostname.
  if (/^\d+$/.test(components[components.length - 1])) return false;
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
  return components.every((c) => label.test(c));
}

// ---------------------------------------------------------------------
// config_entry generation (RNS/Discovery.py received_announce)
// ---------------------------------------------------------------------

/**
 * @typedef {Object} ConfigEntryContext
 * @property {string} name
 * @property {string} transportIdHex
 * @property {string|null} ifacNetname
 * @property {string|null} ifacNetkey
 * @property {boolean} backboneSupport Whether the receiver platform supports
 *   the Backbone interface type (Python: `not is_windows()`). JS defaults to
 *   `true`, mirroring the dominant non-Windows deployment so generated config
 *   entries are directly usable by a Python transport node.
 */

/**
 * Builds the optional `network_name` / `passphrase` / `transport_identity`
 * suffix lines shared by every interface-type config entry.
 * @param {ConfigEntryContext} ctx
 * @returns {{identity: string, netname: string, netkey: string}}
 */
function configSuffix(ctx) {
  const netname = ctx.ifacNetname
    ? `\n  network_name = ${ctx.ifacNetname}`
    : "";
  const netkey = ctx.ifacNetkey ? `\n  passphrase = ${ctx.ifacNetkey}` : "";
  const identity = `\n  transport_identity = ${ctx.transportIdHex}`;
  // Python orders these identity, netname, netkey for most types — see callers.
  return { identity, netname, netkey };
}

/**
 * Generates the human-readable TOML-ish config snippet for a discovered
 * interface, matching Python's `received_announce` per-type output. Used by a
 * leaf operator to add the interface manually (auto-connect is out of scope for
 * v1, see work doc #17).
 *
 * @param {DiscoveredFields} fields
 * @param {boolean} [backboneSupport=true]
 * @returns {string}
 */
export function buildConfigEntry(fields, backboneSupport = true) {
  const ctx = /** @type {ConfigEntryContext} */ ({
    name: fields.name,
    transportIdHex: fields.transportIdHex,
    ifacNetname: fields.ifacNetname ?? null,
    ifacNetkey: fields.ifacNetkey ?? null,
  });
  const sfx = configSuffix(ctx);

  switch (fields.type) {
    case "BackboneInterface":
    case "TCPServerInterface": {
      // Receiver-platform dependent: Backbone (Linux/macOS) or TCPClient (Win).
      const connectionInterface = backboneSupport
        ? "BackboneInterface"
        : "TCPClientInterface";
      const remoteKey = backboneSupport ? "remote" : "target_host";
      return (
        `[[${ctx.name}]]\n` +
        `  type = ${connectionInterface}\n` +
        `  enabled = yes\n` +
        `  ${remoteKey} = ${fields.reachableOn}\n` +
        `  target_port = ${fields.port}` +
        `${sfx.identity}${sfx.netname}${sfx.netkey}`
      );
    }
    case "I2PInterface":
      return (
        `[[${ctx.name}]]\n` +
        `  type = I2PInterface\n` +
        `  enabled = yes\n` +
        `  peers = ${fields.reachableOn}` +
        `${sfx.identity}${sfx.netname}${sfx.netkey}`
      );
    case "RNodeInterface":
      return (
        `[[${ctx.name}]]\n` +
        `  type = RNodeInterface\n` +
        `  enabled = yes\n` +
        `  port = \n` +
        `  frequency = ${fields.frequency}\n` +
        `  bandwidth = ${fields.bandwidth}\n` +
        `  spreadingfactor = ${fields.sf}\n` +
        `  codingrate = ${fields.cr}\n` +
        `  txpower = ${sfx.netname}${sfx.netkey}${sfx.identity}`
      );
    case "WeaveInterface":
      return (
        `[[${ctx.name}]]\n` +
        `  type = WeaveInterface\n` +
        `  enabled = yes\n` +
        `  port = ${sfx.netname}${sfx.netkey}${sfx.identity}`
      );
    case "KISSInterface":
      return (
        `[[${ctx.name}]]\n` +
        `  type = KISSInterface\n` +
        `  enabled = yes\n` +
        `  port = \n` +
        `  # Frequency: ${fields.frequency}\n` +
        `  # Bandwidth: ${fields.bandwidth}\n` +
        `  # Modulation: ${fields.modulation}` +
        `${sfx.identity}${sfx.netname}${sfx.netkey}`
      );
    default:
      return "";
  }
}

/**
 * The per-type fields needed to render a {@link buildConfigEntry}.
 * @typedef {Object} DiscoveredFields
 * @property {string} type
 * @property {string} name
 * @property {string} transportIdHex
 * @property {string|null} ifacNetname
 * @property {string|null} ifacNetkey
 * @property {string} [reachableOn]
 * @property {number} [port]
 * @property {number} [frequency]
 * @property {number} [bandwidth]
 * @property {number} [sf]
 * @property {number} [cr]
 * @property {number} [channel]
 * @property {string} [modulation]
 */

// ---------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------

/**
 * A normalized discovered-interface record, as emitted on the `"discovered"`
 * event and persisted by {@link InterfaceDiscovery}.
 *
 * @typedef {Object} DiscoveredInterface
 * @property {string} type Interface type (e.g. `"TCPServerInterface"`).
 * @property {boolean} transport Whether the announcer is a transport node.
 * @property {string} name Sanitized display name.
 * @property {number} received Unix seconds at which the announce was parsed.
 * @property {Uint8Array} stamp The 32-byte LXMF stamp from the announce.
 * @property {number} value Achieved stamp value (leading zero bits).
 * @property {string} transportIdHex Hex of the announcing transport identity.
 * @property {string} networkIdHex Hex of the announce destination identity.
 * @property {number} hops Hop distance to the discovered interface.
 * @property {number|null} latitude
 * @property {number|null} longitude
 * @property {number|null} height
 * @property {string} discoveryHashHex Hex of `SHA256(transportIdHex + name)`.
 * @property {string} [reachable_on]
 * @property {number} [port]
 * @property {string} [ifac_netname]
 * @property {string} [ifac_netkey]
 * @property {number} [frequency]
 * @property {number} [bandwidth]
 * @property {number} [sf]
 * @property {number} [cr]
 * @property {number} [channel]
 * @property {string} [modulation]
 * @property {string} [config_entry]
 * @property {number} [discovered] Unix seconds first heard (persistence only).
 * @property {number} [last_heard] Unix seconds last heard (persistence only).
 * @property {number} [heard_count] Times heard since first discovery.
 * @property {string} [status] `"available" | "unknown" | "stale"`.
 * @property {number} [status_code] Numeric status for sorting.
 */

/**
 * Options for {@link parseDiscoveryAnnounce}.
 *
 * @typedef {Object} ParseDiscoveryOptions
 * @property {number} [requiredValue] Minimum stamp value (leading zero bits);
 *   defaults to {@link DEFAULT_STAMP_VALUE}.
 * @property {Identity|null} [networkIdentity] Identity to decrypt an encrypted
 *   payload with (`FLAG_ENCRYPTED`). Required iff the announce is encrypted.
 * @property {Uint8Array[]|null} [discoverySources] When set, only accepts
 *   announces whose destination identity hash is in this allow-list (Python
 *   `interface_discovery_sources`).
 * @property {number} [hops] Hop distance to fill into the result.
 * @property {boolean} [backboneSupport] See {@link buildConfigEntry}.
 */

/**
 * Parses and validates a discovery announce's `app_data`.
 *
 * Verifies the LXMF stamp at discovery's cheap work factor, unpacks the msgpack
 * `info` dict, validates the field types/shapes (mirroring Python's
 * `received_announce`), and builds the normalized {@link DiscoveredInterface}
 * record including a generated `config_entry`.
 *
 * @param {Uint8Array|null|undefined} appData Raw `app_data` bytes from the
 *   transport `"announce"` event detail.
 * @param {Identity} announcedIdentity Identity reconstructed from the announce.
 * @param {ParseDiscoveryOptions} [options]
 * @returns {Promise<DiscoveredInterface|null>} `null` for any malformed,
 *   unauthorized, or insufficiently-stamped announce (Python logs and swallows).
 */
export async function parseDiscoveryAnnounce(
  appData,
  announcedIdentity,
  options = {},
) {
  const requiredValue = options.requiredValue ?? DEFAULT_STAMP_VALUE;
  const networkIdentity = options.networkIdentity ?? null;
  const discoverySources = options.discoverySources ?? null;
  const hops = options.hops ?? 0;
  const backboneSupport = options.backboneSupport ?? true;

  // Python: authorize the announcing network identity when a source list is set.
  if (discoverySources) {
    const ok = discoverySources.some((h) =>
      bytesEqual(h, announcedIdentity.identityHash),
    );
    if (!ok) {
      log(
        "Discovery",
        `Interface discovered from non-authorized network identity ${toHex(
          announcedIdentity.identityHash,
        )}, ignoring`,
        LogLevel.DEBUG,
      );
      return null;
    }
  }

  if (!appData || appData.length <= STAMP_SIZE + 1) return null;

  const flags = appData[0];
  /** @type {Uint8Array} */
  let data = appData.subarray(1);
  const encrypted = (flags & FLAG_ENCRYPTED) !== 0;

  if (encrypted) {
    if (!networkIdentity) return null;
    try {
      const decrypted = await networkIdentity.decrypt(data);
      if (!decrypted) return null;
      data = /** @type {Uint8Array} */ (decrypted);
    } catch (e) {
      log(
        "Discovery",
        `Failed to decrypt discovery payload: ${e}`,
        LogLevel.DEBUG,
      );
      return null;
    }
  }

  const stamp = data.subarray(data.length - STAMP_SIZE);
  const packed = data.subarray(0, data.length - STAMP_SIZE);

  const infohash = await Identity.fullHash(packed);
  const workblock = await stampWorkblock(infohash, WORKBLOCK_EXPAND_ROUNDS);
  const value = await stampValue(workblock, stamp);
  const valid = await stampValid(stamp, requiredValue, workblock);
  if (!valid) {
    log(
      "Discovery",
      `Ignored discovered interface with insufficient stamp value ${value}`,
      LogLevel.DEBUG,
    );
    return null;
  }

  try {
    const unpacked = MicroMsgPack.decode(packed);
    return await buildDiscoveredInfo(unpacked, announcedIdentity, {
      stamp,
      value,
      hops,
      received: nowSeconds(),
      backboneSupport,
    });
  } catch (e) {
    log(
      "Discovery",
      `An error occurred while decoding discovered interface: ${e}`,
      LogLevel.DEBUG,
    );
    return null;
  }
}

/**
 * Validates the unpacked msgpack dict and builds the normalized record. Throws
 * on any validation failure (the caller swallows it, mirroring Python).
 *
 * @param {Record<string, any>} unpacked
 * @param {Identity} announcedIdentity
 * @param {Object} meta
 * @param {Uint8Array} meta.stamp
 * @param {number} meta.value
 * @param {number} meta.hops
 * @param {number} meta.received
 * @param {boolean} meta.backboneSupport
 * @returns {Promise<DiscoveredInterface>}
 */
async function buildDiscoveredInfo(unpacked, announcedIdentity, meta) {
  const interfaceType = unpacked[String(INTERFACE_TYPE)];
  if (typeof interfaceType !== "string") {
    throw new Error("Missing INTERFACE_TYPE in discovery announce");
  }
  if (!ACCEPTED_INTERFACE_TYPES.includes(interfaceType)) {
    throw new Error(
      `Invalid interface type in announce data: ${interfaceType}`,
    );
  }

  const name = sanitizeName(unpacked[String(NAME)]);

  // Field type checks (Python raises ValueError on mismatch).
  if (typeof unpacked[String(TRANSPORT)] !== "boolean") {
    throw new Error("Invalid data in transport field of announce");
  }
  if (!isNullOrFloat(unpacked[String(LATITUDE)])) {
    throw new Error("Invalid data in latitude field of announce");
  }
  if (!isNullOrFloat(unpacked[String(LONGITUDE)])) {
    throw new Error("Invalid data in longitude field of announce");
  }
  if (!isNullOrFloat(unpacked[String(HEIGHT)])) {
    throw new Error("Invalid data in height field of announce");
  }
  const transportId = unpacked[String(TRANSPORT_ID)];
  if (!(transportId instanceof Uint8Array) || transportId.length !== 16) {
    throw new Error("Invalid data in transport_id field of announce");
  }

  if (unpacked[String(REACHABLE_ON)] !== undefined) {
    const reachable = unpacked[String(REACHABLE_ON)];
    if (
      typeof reachable !== "string" ||
      !(isIpAddress(reachable) || isHostname(reachable))
    ) {
      throw new Error("Invalid data in reachable_on field of announce");
    }
  }

  const transportIdHex = toHex(transportId);
  const networkIdHex = toHex(announcedIdentity.identityHash);
  const displayName = name || `Discovered ${interfaceType}`;

  /** @type {Record<string, any>} */
  const info = {
    type: interfaceType,
    transport: unpacked[String(TRANSPORT)],
    name: displayName,
    received: meta.received,
    stamp: meta.stamp,
    value: meta.value,
    transportIdHex,
    networkIdHex,
    hops: meta.hops,
    latitude: unpacked[String(LATITUDE)] ?? null,
    longitude: unpacked[String(LONGITUDE)] ?? null,
    height: unpacked[String(HEIGHT)] ?? null,
  };

  if (unpacked[String(IFAC_NETNAME)] !== undefined) {
    info.ifac_netname = String(unpacked[String(IFAC_NETNAME)]);
  }
  if (unpacked[String(IFAC_NETKEY)] !== undefined) {
    info.ifac_netkey = String(unpacked[String(IFAC_NETKEY)]);
  }

  /** @type {DiscoveredFields} */
  const fields = {
    type: interfaceType,
    name: displayName,
    transportIdHex,
    ifacNetname: info.ifac_netname ?? null,
    ifacNetkey: info.ifac_netkey ?? null,
  };

  switch (interfaceType) {
    case "BackboneInterface":
    case "TCPServerInterface": {
      info.reachable_on = unpacked[String(REACHABLE_ON)];
      info.port = unpacked[String(PORT)];
      fields.reachableOn = info.reachable_on;
      fields.port = info.port;
      info.config_entry = buildConfigEntry(fields, meta.backboneSupport);
      break;
    }
    case "I2PInterface": {
      info.reachable_on = unpacked[String(REACHABLE_ON)];
      fields.reachableOn = info.reachable_on;
      info.config_entry = buildConfigEntry(fields, meta.backboneSupport);
      break;
    }
    case "RNodeInterface": {
      info.frequency = unpacked[String(FREQUENCY)];
      info.bandwidth = unpacked[String(BANDWIDTH)];
      info.sf = unpacked[String(SPREADINGFACTOR)];
      info.cr = unpacked[String(CODINGRATE)];
      fields.frequency = info.frequency;
      fields.bandwidth = info.bandwidth;
      fields.sf = info.sf;
      fields.cr = info.cr;
      info.config_entry = buildConfigEntry(fields, meta.backboneSupport);
      break;
    }
    case "WeaveInterface": {
      info.frequency = unpacked[String(FREQUENCY)];
      info.bandwidth = unpacked[String(BANDWIDTH)];
      info.channel = unpacked[String(CHANNEL)];
      info.modulation = unpacked[String(MODULATION)];
      fields.frequency = info.frequency;
      fields.bandwidth = info.bandwidth;
      fields.channel = info.channel;
      fields.modulation = info.modulation;
      info.config_entry = buildConfigEntry(fields, meta.backboneSupport);
      break;
    }
    case "KISSInterface": {
      info.frequency = unpacked[String(FREQUENCY)];
      info.bandwidth = unpacked[String(BANDWIDTH)];
      info.modulation = unpacked[String(MODULATION)];
      fields.frequency = info.frequency;
      fields.bandwidth = info.bandwidth;
      fields.modulation = info.modulation;
      info.config_entry = buildConfigEntry(fields, meta.backboneSupport);
      break;
    }
    // TCPClientInterface: parsed but no config_entry / per-type fields.
    default:
      break;
  }

  // discovery_hash = SHA256(transport_id_hex + name), hex-encoded.
  const material = new TextEncoder().encode(transportIdHex + displayName);
  info.discoveryHashHex = toHex(await Identity.fullHash(material));

  return /** @type {DiscoveredInterface} */ (info);
}

/**
 * @param {unknown} v
 * @returns {boolean}
 * @private
 */
function isNullOrFloat(v) {
  return v === null || typeof v === "number";
}

// ---------------------------------------------------------------------
// Producer primitives (for tests + a future InterfaceAnnouncer)
// ---------------------------------------------------------------------

/**
 * Computes the discovery stamp workblock seed (`infohash`) for an `info` dict:
 * `SHA-256(msgpack(info))`.
 *
 * @param {Map<number, any>} infoMap Info dict with integer keys (use a `Map` so
 *   msgpack emits integer keys, matching Python's wire format).
 * @returns {Promise<Uint8Array>}
 */
export async function discoveryInfoHash(infoMap) {
  const packed = MicroMsgPack.encode(infoMap);
  return Identity.fullHash(packed);
}

/**
 * Searches for a 32-byte LXMF stamp meeting `stampCost` for the given `info`
 * dict. Producer-side primitive — the full `InterfaceAnnouncer` is a follow-up;
 * exposed so tests can mint valid discovery announces.
 *
 * @param {Map<number, any>} infoMap
 * @param {number} [stampCost=DEFAULT_STAMP_VALUE]
 * @param {number} [expandRounds=WORKBLOCK_EXPAND_ROUNDS]
 * @returns {Promise<[Uint8Array, number] | null>} `[stamp, value]`, or `null`
 *   if no stamp could be generated.
 */
export async function generateDiscoveryStamp(
  infoMap,
  stampCost = DEFAULT_STAMP_VALUE,
  expandRounds = WORKBLOCK_EXPAND_ROUNDS,
) {
  const infohash = await discoveryInfoHash(infoMap);
  return generateStamp(infohash, stampCost, expandRounds);
}

/**
 * Builds the `flags || payload` `app_data` blob for a discovery announce
 * (`InterfaceAnnouncer.get_interface_announce_data`'s assembly step).
 * Producer-side primitive for tests / the future producer.
 *
 * @param {Map<number, any>} infoMap
 * @param {Object} [options]
 * @param {number} [options.stampCost]
 * @param {number} [options.expandRounds]
 * @param {boolean} [options.encrypt]
 * @param {Identity|null} [options.networkIdentity]
 * @returns {Promise<Uint8Array>}
 */
export async function buildDiscoveryAppData(infoMap, options = {}) {
  const {
    stampCost = DEFAULT_STAMP_VALUE,
    expandRounds = WORKBLOCK_EXPAND_ROUNDS,
    encrypt = false,
    networkIdentity = null,
  } = options;
  const packed = MicroMsgPack.encode(infoMap);
  const result = await generateDiscoveryStamp(infoMap, stampCost, expandRounds);
  if (!result) {
    throw new Error("Could not generate discovery stamp");
  }
  const [stamp] = result;
  let payload = concatBytes(packed, stamp);
  let flags = 0;
  if (encrypt) {
    if (!networkIdentity) {
      throw new Error("encrypt=true requires a networkIdentity");
    }
    flags |= FLAG_ENCRYPTED;
    payload = await networkIdentity.encrypt(payload);
  }
  const out = new Uint8Array(payload.length + 1);
  out[0] = flags;
  out.set(payload, 1);
  return out;
}

// ---------------------------------------------------------------------
// InterfaceDiscovery orchestrator
// ---------------------------------------------------------------------

/** @typedef {"discovery"} DiscoveryNamespace */

/**
 * Options for {@link InterfaceDiscovery}.
 *
 * @typedef {Object} InterfaceDiscoveryOptions
 * @property {import("./transport.js").TransportCore} transport The transport to
 *   subscribe to for `"announce"` events.
 * @property {number} [requiredValue] Minimum stamp value; defaults to
 *   {@link DEFAULT_STAMP_VALUE}.
 * @property {any} [storageAdapter] Optional persistence adapter implementing
 *   `get/set/delete/keys(namespace, key)` (work doc #16's interface). When
 *   absent or missing the KV methods, discoveries are held in memory only.
 * @property {DiscoveryNamespace} [storageNamespace="discovery"] Namespace for
 *   the storage adapter.
 * @property {Uint8Array[]|null} [discoverySources] Optional allow-list of
 *   announcing network-identity hashes.
 * @property {Identity|null} [networkIdentity] Network identity for decrypting
 *   encrypted discovery payloads.
 * @property {boolean} [backboneSupport] See {@link buildConfigEntry}.
 */

/**
 * Consumer-side orchestrator for on-network interface discovery (Python
 * `InterfaceDiscovery`). Subscribes to the transport `"announce"` event,
 * aspect-filters to {@link ASPECT}, stamp-validates each candidate, and
 * dispatches a `"discovered"` event for every fresh/repeated discovery.
 *
 * Persists discoveries across restarts when a storage adapter with the KV
 * interface (#16) is supplied; otherwise keeps them in memory. v1 is
 * **surface-only** — it does not auto-connect discovered interfaces.
 *
 * @extends EventTarget
 */
export class InterfaceDiscovery extends EventTarget {
  /** @type {Promise<void>} Serializes announce processing (Python discovery_lock). */
  _chain = Promise.resolve();
  /** @type {Map<string, DiscoveredInterface>} */
  _store = new Map();
  /** @type {Uint8Array|null} */
  _aspectNameHash = null;
  /** @type {((event: Event) => void) | null} */
  _announceListener = null;
  /** @type {boolean} */
  _started = false;
  /**
   * The in-flight `start()` promise, set by the `Reticulum` constructor when
   * discovery is auto-started. Await this to ensure the listener is attached.
   * @type {Promise<void>|null}
   */
  startPromise = null;

  /**
   * @param {InterfaceDiscoveryOptions} options
   */
  constructor(options) {
    super();
    if (!options?.transport) {
      throw new Error("InterfaceDiscovery requires a transport instance");
    }
    this.transport = options.transport;
    this.requiredValue = options.requiredValue ?? DEFAULT_STAMP_VALUE;
    this.storageAdapter = options.storageAdapter ?? null;
    this.storageNamespace = options.storageNamespace ?? "discovery";
    this.discoverySources = options.discoverySources ?? null;
    this.networkIdentity = options.networkIdentity ?? null;
    this.backboneSupport = options.backboneSupport ?? true;
  }

  /**
   * Precomputes the aspect name-hash, hydrates the store from the storage
   * adapter, and attaches the transport `"announce"` listener. Idempotent.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._started) return;
    this._started = true;
    this._aspectNameHash = await aspectNameHash(ASPECT);
    await this._hydrate();
    this._announceListener = (/** @type {Event} */ event) => {
      this._onAnnounce(/** @type {CustomEvent} */ (event));
    };
    this.transport.addEventListener("announce", this._announceListener);
    log("Discovery", "Interface discovery listener started", LogLevel.NOTICE);
  }

  /**
   * Detaches the announce listener (no-op if not started). Persisted records
   * already written through are retained.
   */
  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._announceListener) {
      this.transport.removeEventListener("announce", this._announceListener);
      this._announceListener = null;
    }
    log("Discovery", "Interface discovery listener stopped", LogLevel.NOTICE);
  }

  /**
   * Handles a transport `"announce"` event: aspect-filters, parses, persists,
   * and dispatches `"discovered"`. Processing is serialized through
   * {@link InterfaceDiscovery#_chain} so concurrent announces for the same
   * interface can't lose `heard_count` increments (Python's `discovery_lock`).
   * @param {CustomEvent} event
   */
  _onAnnounce(event) {
    this._chain = this._chain
      .then(() => this._processAnnounce(event))
      .catch((e) =>
        log("Discovery", `Error processing announce: ${e}`, LogLevel.ERROR),
      );
  }

  /**
   * The actual (async) announce processing, run one at a time per instance.
   * @param {CustomEvent} event
   * @returns {Promise<void>}
   */
  async _processAnnounce(event) {
    const detail = event.detail ?? {};
    if (!detail.nameHash || !this._aspectNameHash) return;
    if (!bytesEqual(detail.nameHash, this._aspectNameHash)) return;

    const hops = this.transport.hopsTo(detail.destinationHash) ?? 0;
    const info = await parseDiscoveryAnnounce(detail.appData, detail.identity, {
      requiredValue: this.requiredValue,
      networkIdentity: this.networkIdentity,
      discoverySources: this.discoverySources,
      hops,
      backboneSupport: this.backboneSupport,
    });
    if (!info) return;
    if (!DISCOVERABLE_TYPES.includes(info.type)) return;
    await this._remember(info);
    this.dispatchEvent(
      new CustomEvent("discovered", { detail: { info: this._clone(info) } }),
    );
  }

  /**
   * Upserts a discovery into the store (and storage adapter), bumping
   * `heard_count` on repeats and refreshing `last_heard`. Mirrors Python's
   * `interface_discovered` persistence flow.
   * @param {DiscoveredInterface} info
   * @returns {Promise<void>}
   */
  async _remember(info) {
    const key = info.discoveryHashHex;
    const existing = this._store.get(key);
    if (!existing) {
      info.discovered = info.received;
      info.last_heard = info.received;
      info.heard_count = 0;
    } else {
      info.discovered = existing.discovered ?? info.received;
      info.last_heard = info.received;
      info.heard_count = (existing.heard_count ?? 0) + 1;
    }
    this._store.set(key, info);
    await this._persist(key, info);
  }

  /**
   * Returns the persisted discovered-interface list, mirroring Python's
   * `list_discovered_interfaces`.
   *
   * Records past {@link THRESHOLD_REMOVE}, or whose type/`reachable_on` is no
   * longer valid, are pruned (from memory and the storage adapter). Remaining
   * records get a computed `status`/`status_code` and are sorted by freshness,
   * stamp value, then last-heard.
   *
   * @param {Object} [filter]
   * @param {boolean} [filter.onlyAvailable] Only `available` records.
   * @param {boolean} [filter.onlyTransport] Only records where `transport` is true.
   * @returns {Promise<DiscoveredInterface[]>}
   */
  async listDiscoveredInterfaces(filter = {}) {
    const { onlyAvailable = false, onlyTransport = false } = filter;
    const now = nowSeconds();
    /** @type {DiscoveredInterface[]} */
    const out = [];
    /** @type {string[]} */
    const stale = [];

    for (const [key, info] of this._store) {
      const lastHeard = info.last_heard ?? info.received ?? now;
      const heardDelta = now - lastHeard;

      // Prune records that are too old or no longer valid.
      let shouldRemove = false;
      if (heardDelta > THRESHOLD_REMOVE) shouldRemove = true;
      else if (
        this.discoverySources &&
        (!info.networkIdHex ||
          !this.discoverySources.some((h) =>
            bytesEqual(h, fromHex(info.networkIdHex)),
          ))
      ) {
        shouldRemove = true;
      } else if (!DISCOVERABLE_TYPES.includes(info.type)) {
        shouldRemove = true;
      } else if (
        info.reachable_on !== undefined &&
        !(isIpAddress(info.reachable_on) || isHostname(info.reachable_on))
      ) {
        shouldRemove = true;
      }

      if (shouldRemove) {
        stale.push(key);
        continue;
      }

      let status;
      if (heardDelta > THRESHOLD_STALE) status = "stale";
      else if (heardDelta > THRESHOLD_UNKNOWN) status = "unknown";
      else status = "available";

      if (onlyAvailable && status !== "available") continue;
      if (onlyTransport && !info.transport) continue;

      const record = this._clone(info);
      record.status = status;
      record.status_code = statusCode(status);
      out.push(record);
    }

    for (const key of stale) {
      this._store.delete(key);
      await this._delete(key);
    }

    out.sort(
      (a, b) =>
        (b.status_code ?? 0) - (a.status_code ?? 0) ||
        (b.value ?? 0) - (a.value ?? 0) ||
        (b.last_heard ?? 0) - (a.last_heard ?? 0),
    );
    return out;
  }

  /**
   * Hydrates the in-memory store from the storage adapter (if any).
   * @returns {Promise<void>}
   */
  async _hydrate() {
    const adapter = this._kvAdapter();
    if (!adapter) return;
    try {
      const keys = await adapter.keys(this.storageNamespace);
      for (const key of keys) {
        const bytes = await adapter.get(this.storageNamespace, key);
        if (!bytes) continue;
        try {
          const info = this._deserialize(bytes);
          if (info) this._store.set(key, info);
        } catch (e) {
          log(
            "Discovery",
            `Error loading discovered interface ${key}: ${e}`,
            LogLevel.WARNING,
          );
        }
      }
    } catch (e) {
      log(
        "Discovery",
        `Error hydrating discovered interfaces: ${e}`,
        LogLevel.WARNING,
      );
    }
  }

  /**
   * Persists a record via the storage adapter.
   * @param {string} key
   * @param {DiscoveredInterface} info
   * @returns {Promise<void>}
   */
  async _persist(key, info) {
    const adapter = this._kvAdapter();
    if (!adapter) return;
    try {
      await adapter.set(this.storageNamespace, key, this._serialize(info));
    } catch (e) {
      log(
        "Discovery",
        `Error persisting discovered interface ${key}: ${e}`,
        LogLevel.ERROR,
      );
    }
  }

  /**
   * Deletes a record via the storage adapter.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async _delete(key) {
    const adapter = this._kvAdapter();
    if (!adapter) return;
    try {
      await adapter.delete(this.storageNamespace, key);
    } catch (e) {
      log(
        "Discovery",
        `Error deleting discovered interface ${key}: ${e}`,
        LogLevel.WARNING,
      );
    }
  }

  /**
   * Returns the adapter only if it implements the KV interface (#16).
   * @returns {{get: Function, set: Function, delete: Function, keys: Function}|null}
   */
  _kvAdapter() {
    const a = this.storageAdapter;
    if (
      a &&
      typeof a.get === "function" &&
      typeof a.set === "function" &&
      typeof a.delete === "function" &&
      typeof a.keys === "function"
    ) {
      return /** @type {any} */ (a);
    }
    return null;
  }

  /**
   * @param {DiscoveredInterface} info
   * @returns {DiscoveredInterface}
   */
  _clone(info) {
    return /** @type {DiscoveredInterface} */ (structuredCloneSafe(info));
  }

  /**
   * @param {DiscoveredInterface} info
   * @returns {Uint8Array}
   */
  _serialize(info) {
    return MicroMsgPack.encode(stripForStorage(info));
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {DiscoveredInterface|null}
   */
  _deserialize(bytes) {
    const obj = MicroMsgPack.decode(bytes);
    if (!obj || typeof obj !== "object") return null;
    return /** @type {DiscoveredInterface} */ (obj);
  }
}

/**
 * Maps a status name to its numeric code.
 * @param {string} status
 * @returns {number}
 * @private
 */
function statusCode(status) {
  switch (status) {
    case "available":
      return STATUS_AVAILABLE;
    case "unknown":
      return STATUS_UNKNOWN;
    case "stale":
      return STATUS_STALE;
    default:
      return 0;
  }
}

/**
 * Returns a plain (structured-clone-friendly) copy of a discovery record,
 * dropping the 32-byte `stamp` (regenerated per announce, not needed once
 * validated) to keep persisted blobs small.
 * @param {DiscoveredInterface} info
 * @returns {Record<string, any>}
 * @private
 */
function stripForStorage(info) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(info)) {
    if (k === "stamp") continue;
    out[k] = v instanceof Uint8Array ? new Uint8Array(v) : v;
  }
  return out;
}

/**
 * Structured clone that also copies nested `Uint8Array` views cleanly.
 * @param {T} value
 * @returns {T}
 * @template T
 * @private
 */
function structuredCloneSafe(value) {
  // `structuredClone` handles Uint8Array natively; keep this wrapper so the
  // persistence boundary never leaks shared mutable state to callers.
  return structuredClone(value);
}

/**
 * Decodes a hex string into a `Uint8Array`.
 * @param {string} hex
 * @returns {Uint8Array}
 * @private
 */
function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
