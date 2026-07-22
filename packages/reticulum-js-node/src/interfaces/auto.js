/**
 * @file auto.js
 * @description AutoInterface — zero-config IPv6-multicast LAN/Wi-Fi peering
 *   (Node.js), porting the Python reference
 *   `RNS/Interfaces/AutoInterface.py`.
 *
 * AutoInterface discovers peers on the local link with **IPv6 multicast** and
 * talks to each one over IPv6 unicast UDP via a spawned
 * {@link AutoInterfacePeer}. This module covers work doc #12 through **Phase 2**:
 *
 * - Phase 1 — interface enumeration/adoption, multicast-address and
 *   discovery-token derivation, the per-interface multicast + unicast discovery
 *   sockets, the announce loop, discovery-packet authentication, and peer
 *   tracking (`addPeer`/`refreshPeer`).
 * - Phase 2 — the data path: a per-interface UDP data socket, raw
 *   `Packet` serialize/deserialize (no KISS framing), the multi-interface
 *   dedup deque, `AutoInterfacePeer` spawning, and auto-registration of spawned
 *   peers with the transport via the `attachTransport` hook.
 * - Phase 3 — the lifecycle jobs: peer expiry, reverse-peering send,
 *   link-local-address rebind, and the multicast-echo carrier watchdog.
 *
 * Phase 4 (register in the interface registry; schema already present) remains.
 *
 * ## Why no KISS framing here
 *
 * Unlike the TCP/WebSocket interfaces, AutoInterface's discovery packets are
 * **not** RNS packets — they are a 32-byte SHA-256 token, one per UDP datagram
 * — and the per-peer data path also sends one raw RNS packet per datagram with
 * no HDLC framing. So both the parent `AutoInterface` (discovery) and the
 * spawned {@link AutoInterfacePeer} (data) bypass the `framer.js` stream
 * machinery and speak raw `dgram` directly. The parent never exposes
 * `readable`/`writable` (matching the Python parent interface, which only
 * spawns peer sub-interfaces).
 *
 * ## Multicast in Node
 *
 * Per-interface operation is achieved by binding/joining/sending against the
 * interface's **scoped link-local address** (e.g. `fe80::1%lo0`). Node's
 * `addMembership(group, scopedLL)` and `setMulticastInterface(scopedLL)` accept
 * that form on macOS/Linux; the older `::%<ifindex>` form is rejected.
 */
import dgram from "node:dgram";
import { Identity } from "reticulum-js/src/core/identity.js";
import { Interface } from "reticulum-js/src/interfaces/base.js";
import { LogLevel, log } from "reticulum-js/src/utils/log.js";
import {
  AF_INET6,
  descopeLinkLocal,
  listAddresses,
  listInterfaces,
} from "../utils/netinfo.js";
import { AutoInterfacePeer } from "./auto_peer.js";

/**
 * SHA-256 length in bytes: the discovery token is the full hash, and the first
 * `HASHLENGTH // 8` bytes of an inbound datagram are compared against it.
 * Mirrors `RNS.Identity.HASHLENGTH` (256 bits).
 */
const HASHLENGTH_BYTES = 32;

/** HW MTU mirrors the Python reference. (Reserved for the Phase 2 data path.) */
const HW_MTU = 1196;

/**
 * Multi-interface dedup deque bounds, mirroring `AutoInterface.MULTI_IF_DEQUE_*`.
 * A packet seen on more than one adopted interface within the TTL is dropped.
 */
const MULTI_IF_DEQUE_LEN = 48;
const MULTI_IF_DEQUE_TTL = 0.75;

/**
 * Maps a human-readable discovery scope name to its IPv6 multicast scope nibble,
 * matching `AutoInterface.SCOPE_*` in the Python reference.
 * @enum {string}
 */
const SCOPE = {
  link: "2",
  admin: "4",
  site: "5",
  organisation: "8",
  global: "e",
};

/**
 * Multicast address type nibbles: `0` permanent, `1` temporary. The Python
 * reference defaults to **temporary**.
 * @enum {string}
 */
const MULTICAST_TYPE = {
  permanent: "0",
  temporary: "1",
};

/**
 * Loopback names that are skipped on every platform, matching the Python
 * `ALL_IGNORE_IFS`. (Loopback is only adoptable when explicitly listed in
 * `devices`, for testing — see {@link AutoInterface._isAdoptable}.)
 */
const ALL_IGNORE_IFS = ["lo0", "lo"];
/**
 * macOS interfaces skipped unless explicitly allowed, matching the Python
 * `DARWIN_IGNORE_IFS` (AWDL, Low-power WLAN, loopback, the iPhone tether gadget).
 */
const DARWIN_IGNORE_IFS = ["awdl0", "llw0", "lo0", "en5"];

/**
 * Derives the IPv6 multicast discovery address from a group id, exactly as the
 * Python reference does: `ff{type}{scope}:` + a leading `0` word + six 16-bit
 * words read big-endian from the first 14 bytes of `SHA-256(group_id)`.
 *
 * Exported for unit testing against Python-computed constants.
 * @param {Object} params
 * @param {Uint8Array} params.groupId - Raw group id bytes.
 * @param {string} [params.scope] - IPv6 scope nibble (see {@link SCOPE}).
 * @param {string} [params.multicastAddressType] - `permanent` or `temporary`.
 * @returns {Promise<string>} The multicast address string (e.g.
 *   `ff12:0:d70b:fb1c:16e4:5e39:485e:31e1` for the default group).
 */
export async function computeDiscoveryAddress({
  groupId,
  scope = SCOPE.link,
  multicastAddressType = MULTICAST_TYPE.temporary,
}) {
  const typeNibble =
    multicastAddressType === "permanent" ||
    multicastAddressType === MULTICAST_TYPE.permanent
      ? MULTICAST_TYPE.permanent
      : MULTICAST_TYPE.temporary;
  const g = await Identity.fullHash(groupId);
  /** @type {(i: number) => string} Big-endian 16-bit word at byte offset `i` of the group hash. */
  const word = (i) => ((g[i + 1] + (g[i] << 8)) & 0xffff).toString(16);
  const groupTail = `0:${word(2)}:${word(4)}:${word(6)}:${word(8)}:${word(10)}:${word(12)}`;
  return `ff${typeNibble}${scope}:${groupTail}`;
}

/**
 * Computes the 32-byte discovery token for a peer's (descope'd) link-local
 * address: `SHA-256(group_id || link_local_addr_utf8)`. This is both what a
 * peer *sends* to announce itself and what a receiver expects (over the first
 * `HASHLENGTH//8` bytes of the datagram).
 *
 * Exported for unit testing against Python-computed constants.
 * @param {Uint8Array} groupId
 * @param {string} linkLocalAddr - Descope'd (no `%scope`) link-local address.
 * @returns {Promise<Uint8Array>}
 */
export async function computeDiscoveryToken(groupId, linkLocalAddr) {
  const addrBytes = new TextEncoder().encode(String(linkLocalAddr));
  const combined = new Uint8Array(groupId.length + addrBytes.length);
  combined.set(groupId, 0);
  combined.set(addrBytes, groupId.length);
  return Identity.fullHash(combined);
}

/**
 * @typedef {Object} AutoInterfaceOptions
 * @property {string} [name] - Human-readable interface name.
 * @property {string} [groupId] - Peering group id. Nodes with the same group id
 *   discover each other; different groups are isolated. Defaults to
 *   `"reticulum"` (Python config key: group_id).
 * @property {"link"|"admin"|"site"|"organisation"|"global"} [discoveryScope] -
 *   IPv6 multicast scope. Defaults to `"link"` (Python config key:
 *   discovery_scope).
 * @property {number} [discoveryPort] - UDP port for multicast discovery.
 *   Defaults to 29716 (Python: DEFAULT_DISCOVERY_PORT). Unicast reverse-peering
 *   uses `discoveryPort + 1`.
 * @property {number} [dataPort] - UDP port for per-peer data. Defaults to 42671
 *   (Python: DEFAULT_DATA_PORT). Reserved for Phase 2.
 * @property {"permanent"|"temporary"} [multicastAddressType] - Whether to use a
 *   permanent or temporary multicast address. Defaults to `"temporary"`.
 * @property {string[]} [devices] - Allow-list of interface names to adopt. When
 *   set, only these are adopted (and even ignore-list entries like `lo0` become
 *   adoptable, which is how the loopback smoketest pins a single interface).
 * @property {string[]} [ignoredDevices] - Extra interface names to skip.
 * @property {number} [configuredBitrate] - Override the default bitrate guess.
 * @property {number} [ifacSize] - IFAC size in bytes (0 disables; reserved, v1
 *   runs with IFAC disabled).
 * @property {number} [announceInterval] - Seconds between multicast announces.
 *   Defaults to 1.6 (Python: ANNOUNCE_INTERVAL). Overridable for fast tests.
 * @property {number} [peeringTimeout] - Seconds of silence after which a peer
 *   expires. Defaults to 22 (Python: PEERING_TIMEOUT).
 * @property {number} [peerJobInterval] - Seconds between lifecycle job ticks.
 *   Defaults to 4 (Python: PEER_JOB_INTERVAL).
 * @property {number} [multicastEchoTimeout] - Seconds without our own
 *   multicast echo before flagging carrier lost. Defaults to 6.5 (Python:
 *   MCAST_ECHO_TIMEOUT).
 * @property {number} [reversePeeringInterval] - Seconds between reverse-peering
 *   sends to a peer. Defaults to `announceInterval * 3.25` (Python).
 */

/**
 * AutoInterface — zero-config IPv6-multicast local-network peering.
 *
 * Phases 1–3 of work doc #12: discovery + peer tracking (1), the data path (2),
 * and the lifecycle jobs — peer expiry, reverse-peering send, link-local
 * rebind, multicast-echo watchdog (3). Phase 4 (register in the interface
 * registry; schema already present) remains.
 * (`AutoInterfacePeer`) and registering it with a transport arrives in Phase 2;
 * the lifecycle jobs (expiry, reverse-peering send, rebind, watchdog) arrive in
 * Phase 3.
 *
 * The parent interface dispatches:
 * - `"connected"` once discovery sockets are up,
 * - `"peer"` with `{ address, ifname }` when a new peer is authenticated (Phase
 *   2 will additionally spawn a peer interface and dispatch `"connection"`),
 * - `"closed"` on `disconnect()`,
 * - `"error"` on socket errors.
 * @extends Interface
 */
export class AutoInterface extends Interface {
  /**
   * Returns the JSON Schema describing the options accepted by the
   * {@link AutoInterface} constructor, for dynamically-generated setup UIs.
   * @returns {Record<string, any>} A JSON Schema object.
   */
  static getConfigurationSchema() {
    const base = Interface.getConfigurationSchema();
    return {
      ...base,
      title: "AutoInterface",
      description:
        "Zero-config IPv6-multicast LAN/Wi-Fi peering. Discovers peers on the " +
        "local link via multicast and (in later phases) talks to each over " +
        "unicast UDP. Mirrors the Python reference AutoInterface.",
      properties: {
        ...base.properties,
        groupId: {
          type: "string",
          default: "reticulum",
          examples: ["reticulum", "my-mesh"],
          description:
            "Peering group id. Nodes sharing a group id discover each other; " +
            "different groups are isolated (Python config key: group_id).",
        },
        discoveryScope: {
          type: "string",
          enum: ["link", "admin", "site", "organisation", "global"],
          default: "link",
          description:
            "IPv6 multicast scope to discover peers in (Python config key: " +
            "discovery_scope).",
        },
        discoveryPort: {
          type: "integer",
          minimum: 0,
          maximum: 65534,
          default: 29716,
          description:
            "UDP port for multicast discovery (Python: DEFAULT_DISCOVERY_PORT).",
        },
        dataPort: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          default: 42671,
          description:
            "UDP port for per-peer data (Python: DEFAULT_DATA_PORT).",
        },
        multicastAddressType: {
          type: "string",
          enum: ["permanent", "temporary"],
          default: "temporary",
          description:
            "Permanent vs. temporary multicast address (Python config key: " +
            "multicast_address_type).",
        },
        devices: {
          type: "array",
          items: { type: "string" },
          description:
            "Allow-list of interface names to adopt. When set, only these are " +
            "used and even ignore-list entries (e.g. lo0) become adoptable " +
            "(Python config key: devices).",
        },
        ignoredDevices: {
          type: "array",
          items: { type: "string" },
          description:
            "Extra interface names to skip (Python config key: ignored_devices).",
        },
        configuredBitrate: {
          type: "integer",
          minimum: 0,
          description: "Override the default 10 Mbit/s bitrate guess.",
        },
      },
      required: [],
      additionalProperties: false,
    };
  }

  /**
   * Creates an AutoInterface. Discovery sockets are opened by {@link connect}.
   * @param {AutoInterfaceOptions} [options]
   */
  constructor(options = {}) {
    super();
    this.name = options.name || "auto-interface";

    this.groupId = options.groupId
      ? new TextEncoder().encode(options.groupId)
      : new TextEncoder().encode("reticulum");

    const scopeName = options.discoveryScope || "link";
    this.discoveryScope = SCOPE[scopeName] ? SCOPE[scopeName] : SCOPE.link;

    this.discoveryPort = options.discoveryPort ?? 29716;
    this.unicastDiscoveryPort = this.discoveryPort + 1;
    this.dataPort = options.dataPort ?? 42671;

    const typeName = options.multicastAddressType || "temporary";
    this.multicastAddressType =
      typeName === "permanent"
        ? MULTICAST_TYPE.permanent
        : MULTICAST_TYPE.temporary;

    this.allowedInterfaces = options.devices ? [...options.devices] : [];
    this.ignoredInterfaces = options.ignoredDevices
      ? [...options.ignoredDevices]
      : [];

    this.bitrate = options.configuredBitrate ?? 10 * 1000 * 1000;
    this.ifacSize = options.ifacSize ?? 0;

    // Timers and timing. ANNOUNCE_INTERVAL is overridable for fast tests.
    this.announceInterval = options.announceInterval ?? 1.6;
    // Lifecycle timing (peer_jobs), mirroring AutoInterface.* in the Python
    // reference. All overridable for fast tests.
    this.peeringTimeout = options.peeringTimeout ?? 22.0;
    this.peerJobInterval = options.peerJobInterval ?? 4.0;
    this.multicastEchoTimeout = options.multicastEchoTimeout ?? 6.5;
    this.reversePeeringInterval =
      options.reversePeeringInterval ?? this.announceInterval * 3.25;

    // Discovery state, mirroring the Python reference's instance attributes.
    /** @type {Record<string, string>} ifname → descope'd link-local address */
    this.adoptedInterfaces = {};
    /** @type {string[]} descope'd link-local addresses of adopted interfaces */
    this.linkLocalAddresses = [];
    /** @type {Record<string, import("node:dgram").Socket>} multicast discovery sockets keyed by ifname */
    this.multicastSockets = {};
    /** @type {Record<string, import("node:dgram").Socket>} unicast discovery sockets keyed by ifname */
    this.unicastSockets = {};
    /** @type {Record<string, import("node:dgram").Socket>} per-interface data sockets (one RNS packet per datagram) keyed by ifname */
    this.dataSockets = {};
    /** ifname → timestamp (seconds) of the last multicast echo from ourselves */
    /** @type {Record<string, number>} */
    this.multicastEchoes = {};
    /** ifname → timestamp of the first multicast echo (carrier-present marker) */
    /** @type {Record<string, number>} */
    this.initialEchoes = {};
    /** @type {Record<string, { ifname: string; lastHeard: number; lastOutbound: number }>} peer address → peering state */
    this.peers = {};
    /** @type {Record<string, AutoInterfacePeer>} peer address → spawned data interface */
    this.spawnedInterfaces = {};
    /**
     * Multi-interface dedup deque: recent data-packet hashes with their expiry.
     * Capped at {@link MULTI_IF_DEQUE_LEN} entries; a hit within
     * {@link MULTI_IF_DEQUE_TTL} drops a duplicate seen on another interface.
     * @type {Array<{ hash: Uint8Array; expiresAt: number }>}
     */
    this.mifDeque = [];
    /**
     * Transport that owns this interface, set via {@link attachTransport}. When
     * present, spawned peers are auto-registered with it; otherwise the caller
     * registers them via the `"connection"` event.
     * @type {import("reticulum-js/src/transport/transport.js").TransportCore | null}
     */
    this.transport = null;

    // Computed in connect(); declared here for clarity.
    /** @type {string | null} */
    this.mcastDiscoveryAddress = null;

    /** Per-interface announce-loop timers, keyed by ifname. */
    /** @type {Record<string, ReturnType<typeof setInterval>>} */
    this._announceTimers = {};
    /** Handle for the periodic peer-jobs loop (expiry, reverse peering, rebind, watchdog). */
    /** @type {ReturnType<typeof setInterval> | null} */
    this._peerJobsTimer = null;

    // Carrier-watchdog state, mirroring Python's `timed_out_interfaces` /
    // `carrier_changed`.
    /** @type {Record<string, boolean>} ifname → carrier-lost flag */
    this.timedOutInterfaces = {};
    /** Set whenever peer/link state changes a way that should reset announce-rate control. */
    this.carrierChanged = false;

    this.online = false;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.online;
  }

  /**
   * Number of spawned peer data interfaces. Mirrors Python's
   * `len(self.spawned_interfaces)` (the count used for `peer_count`).
   */
  get peerCount() {
    return Object.keys(this.spawnedInterfaces).length;
  }

  /**
   * The parent AutoInterface has no RNS byte stream of its own — it only
   * spawns per-peer interfaces that do. Returns `null` (rather than throwing)
   * so {@link TransportCore.addInterface} can attach the parent to receive the
   * transport ref via {@link attachTransport} without trying to grab a writer.
   * @returns {any}
   */
  get readable() {
    return null;
  }
  /** @returns {any} */
  get writable() {
    return null;
  }

  /**
   * Receives the owning transport from `TransportCore.addInterface` so spawned
   * peers can be auto-registered (Open Q1 of work doc #12). Also registers any
   * peers spawned before the transport was attached, so the
   * `addInterface`/`connect` call order doesn't matter.
   * @param {import("reticulum-js/src/transport/transport.js").TransportCore} transport
   */
  attachTransport(transport) {
    this.transport = transport;
    for (const peer of Object.values(this.spawnedInterfaces)) {
      transport.addInterface(peer);
    }
  }

  /**
   * Enumerates, adopts suitable interfaces, opens the per-interface multicast +
   * unicast discovery sockets, and starts the announce loop and receive
   * handlers. Resolves once all adopted interfaces are listening and dispatches
   * `"connected"`.
   *
   * The discovery address and per-interface tokens are derived lazily here
   * (rather than in the constructor) because `Identity.fullHash` is async.
   * @returns {Promise<void>}
   */
  async connect() {
    this.mcastDiscoveryAddress = await computeDiscoveryAddress({
      groupId: this.groupId,
      scope: this.discoveryScope,
      multicastAddressType: this.multicastAddressType,
    });
    log(
      "AutoInterface",
      `${this} multicast discovery address is ${this.mcastDiscoveryAddress}`,
      LogLevel.EXTREME,
    );

    let suitable = 0;
    for (const ifname of listInterfaces()) {
      if (!this._isAdoptable(ifname)) continue;
      const addresses = listAddresses(ifname);
      const v6 = addresses[AF_INET6];
      if (!v6) continue;
      let linkLocalAddr = null;
      for (const entry of v6) {
        if (entry.addr.startsWith("fe80:")) {
          linkLocalAddr = descopeLinkLocal(entry.addr);
          this.linkLocalAddresses.push(linkLocalAddr);
          this.adoptedInterfaces[ifname] = linkLocalAddr;
          this.multicastEchoes[ifname] = this._now();
          log(
            "AutoInterface",
            `${this} selecting link-local ${linkLocalAddr} on ${ifname}`,
            LogLevel.EXTREME,
          );
          break;
        }
      }
      if (linkLocalAddr === null) {
        log(
          "AutoInterface",
          `${this} no link-local IPv6 on ${ifname}, skipping`,
          LogLevel.EXTREME,
        );
        continue;
      }
      try {
        await this._openDiscoverySockets(ifname, linkLocalAddr);
        await this._openDataSocket(ifname, linkLocalAddr);
      } catch (/** @type {any} */ e) {
        // Mirrors the Python reference: a per-interface socket failure (e.g.
        // EADDRINUSE because another Reticulum instance — like a local rnsd
        // — already holds the discovery/data port on this link-local address)
        // skips just this interface rather than aborting the whole interface.
        log(
          "AutoInterface",
          `${this} could not configure ${ifname}, skipping it: ${e.message}`,
          LogLevel.ERROR,
        );
        await this._abandonInterface(ifname, linkLocalAddr);
        continue;
      }
      suitable += 1;
    }

    if (suitable === 0) {
      log(
        "AutoInterface",
        `${this} could not autoconfigure; no connectivity`,
        LogLevel.WARNING,
      );
    }

    this.online = true;
    this._startPeerJobs();
    this.dispatchEvent(
      new CustomEvent("connected", {
        detail: { address: this.mcastDiscoveryAddress },
      }),
    );
  }

  /**
   * Decides whether an interface should be adopted, mirroring the Python
   * reference's per-interface skip chain.
   *
   * When an allow-list ({@link AutoInterface.allowedInterfaces}, `devices`) is
   * set, **only** those names are adopted, and they bypass the ignore lists
   * (including loopback) — matching Python's
   * `if len(allowed) > 0 and not ifname in allowed: skip`, with the same
   * relaxation that lets the single-host loopback smoketest pin `lo0`
   * explicitly. (Python unconditionally skips `lo0` on Darwin even when
   * allowed; we relax only that, so production parity holds: loopback is never
   * adopted without `devices`.)
   * @param {string} ifname
   * @returns {boolean}
   */
  _isAdoptable(ifname) {
    if (this.allowedInterfaces.length > 0) {
      return this.allowedInterfaces.includes(ifname);
    }
    if (this.ignoredInterfaces.includes(ifname)) return false;
    if (ALL_IGNORE_IFS.includes(ifname)) return false;
    if (process.platform === "darwin" && DARWIN_IGNORE_IFS.includes(ifname)) {
      return false;
    }
    return true;
  }

  /**
   * Opens the multicast and unicast discovery sockets for one adopted
   * interface and wires their receive handlers. The multicast socket also
   * serves as the announce sender (its `setMulticastInterface` pins the
   * outgoing link).
   * @param {string} ifname
   * @param {string} linkLocalAddr - Descope'd link-local address.
   * @returns {Promise<void>}
   * @private
   */
  async _openDiscoverySockets(ifname, linkLocalAddr) {
    const scopedLL = `${linkLocalAddr}%${ifname}`;
    const mcastAddr = /** @type {string} */ (this.mcastDiscoveryAddress);

    // --- Multicast discovery socket -------------------------------------
    const msock = dgram.createSocket({ type: "udp6", reuseAddr: true });
    msock.on("message", (data, rinfo) => {
      this._onDiscoveryMessage(data, rinfo, ifname).catch(
        (/** @type {any} */ e) =>
          log(
            "AutoInterface",
            `${this} discovery handler error: ${e.message}`,
            LogLevel.ERROR,
          ),
      );
    });
    msock.on("error", (/** @type {any} */ err) =>
      this.dispatchEvent(new CustomEvent("error", { detail: err })),
    );
    await this._bind(msock, this.discoveryPort, "::");
    msock.addMembership(mcastAddr, scopedLL);
    msock.setMulticastLoopback(true);
    msock.setMulticastInterface(scopedLL);
    this.multicastSockets[ifname] = msock;
    log(
      "AutoInterface",
      `${this} joined ${mcastAddr} on ${ifname} (${scopedLL})`,
      LogLevel.EXTREME,
    );

    // --- Unicast discovery socket (reverse peering receiver) ------------
    const usock = dgram.createSocket({ type: "udp6", reuseAddr: true });
    usock.on("message", (data, rinfo) => {
      this._onDiscoveryMessage(data, rinfo, ifname).catch(
        (/** @type {any} */ e) =>
          log(
            "AutoInterface",
            `${this} discovery handler error: ${e.message}`,
            LogLevel.ERROR,
          ),
      );
    });
    usock.on("error", (/** @type {any} */ err) =>
      this.dispatchEvent(new CustomEvent("error", { detail: err })),
    );
    await this._bind(usock, this.unicastDiscoveryPort, scopedLL);
    this.unicastSockets[ifname] = usock;

    // --- Announce loop (multicast only, as in Python) -------------------
    this._startAnnounceLoop(ifname);
  }

  /**
   * Opens the per-interface data socket: a UDP6 socket bound to the local
   * scoped link-local address on `dataPort`. It serves both directions of the
   * per-peer data path — inbound datagrams are routed to the matching spawned
   * peer's `processIncoming`, and outbound datagrams to peers on this
   * interface are sent from it. No KISS framing: one RNS packet per datagram.
   *
   * @param {string} ifname
   * @param {string} linkLocalAddr - Descope'd link-local address.
   * @returns {Promise<void>}
   * @private
   */
  async _openDataSocket(ifname, linkLocalAddr) {
    const scopedLL = `${linkLocalAddr}%${ifname}`;
    const sock = dgram.createSocket({ type: "udp6", reuseAddr: true });
    sock.on("message", (data, rinfo) => {
      this._onData(data, rinfo);
    });
    sock.on("error", (/** @type {any} */ err) =>
      this.dispatchEvent(new CustomEvent("error", { detail: err })),
    );
    await this._bind(sock, this.dataPort, scopedLL);
    this.dataSockets[ifname] = sock;
    log(
      "AutoInterface",
      `${this} data socket bound to ${scopedLL}:${this.dataPort}`,
      LogLevel.EXTREME,
    );
  }

  /**
   * Routes an inbound data datagram to the spawned peer for its source address.
   * The source is descope'd (Node includes a `%scope` suffix) before the
   * spawned-interfaces lookup, since peers are keyed by their bare link-local
   * address. Unknown sources are ignored.
   * @param {Uint8Array} data
   * @param {{ address: string; port: number }} rinfo
   * @private
   */
  _onData(data, rinfo) {
    if (!this.online) return;
    const srcAddr = descopeLinkLocal(rinfo.address);
    const peer = this.spawnedInterfaces[srcAddr];
    if (!peer) return;
    peer
      .processIncoming(data)
      .catch((/** @type {any} */ e) =>
        log(
          "AutoInterface",
          `${this} data handler error from ${srcAddr}: ${e.message}`,
          LogLevel.ERROR,
        ),
      );
  }

  /**
   * Sends a raw RNS packet to a peer on the given interface, from that
   * interface's data socket. The destination is re-scoped with `%ifname` so the
   * OS routes it out the correct link-local. Mirrors Python's
   * `AutoInterfacePeer.process_outgoing` send path (Python uses a shared
   * unbound outbound socket + `addr%ifindex`; we reuse the per-interface bound
   * data socket, which already has the correct source address).
   * @param {string} addr - Descope'd peer link-local address.
   * @param {string} ifname
   * @param {Uint8Array} data
   * @returns {void}
   */
  _sendData(addr, ifname, data) {
    const sock = this.dataSockets[ifname];
    if (!sock) {
      log(
        "AutoInterface",
        `${this} no data socket for ${ifname}; dropping outbound to ${addr}`,
        LogLevel.WARNING,
      );
      return;
    }
    const dest = `${addr}%${ifname}`;
    sock.send(data, this.dataPort, dest, (/** @type {any} */ err) => {
      if (err) {
        log(
          "AutoInterface",
          `${this} could not transmit to ${dest}: ${err.message}`,
          LogLevel.ERROR,
        );
      }
    });
  }

  /**
   * Multi-interface dedup check. Returns true (and remembers nothing) if the
   * packet hash was seen within {@link MULTI_IF_DEQUE_TTL}; otherwise remembers
   * it and returns false. Mirrors Python's `mif_deque`/`mif_deque_times` logic.
   * @param {Uint8Array} hash - `SHA-256` of the raw datagram bytes.
   * @returns {boolean} `true` if the packet is a recent duplicate.
   */
  _isDuplicate(hash) {
    const now = this._now();
    const isHit = this.mifDeque.some(
      (entry) => entry.expiresAt > now && this._bytesEqual(entry.hash, hash),
    );
    if (isHit) return true;
    this.mifDeque.push({ hash, expiresAt: now + MULTI_IF_DEQUE_TTL });
    while (this.mifDeque.length > MULTI_IF_DEQUE_LEN) this.mifDeque.shift();
    return false;
  }

  // ------------------------------------------------------------------
  // Lifecycle jobs (Phase 3): peer expiry, reverse-peering send,
  // link-local rebind, multicast-echo watchdog. Mirrors Python's `peer_jobs`.
  // ------------------------------------------------------------------

  /**
   * Starts the periodic peer-jobs loop. Each tick runs {@link _runPeerJobs}.
   * @private
   */
  _startPeerJobs() {
    this._peerJobsTimer = setInterval(
      () =>
        this._runPeerJobs().catch((/** @type {any} */ e) =>
          log(
            "AutoInterface",
            `${this} peer-jobs error: ${e.message}`,
            LogLevel.ERROR,
          ),
        ),
      this.peerJobInterval * 1000,
    );
  }

  /**
   * One peer-jobs tick. Expires silent peers (and tears down their spawned
   * interfaces), sends reverse-peering packets to peers due for one, rebinds
   * the per-interface data socket when its link-local address changes, and runs
   * the multicast-echo carrier watchdog. Mirrors Python's `peer_jobs`.
   * @returns {Promise<void>}
   * @protected
   */
  async _runPeerJobs() {
    const now = this._now();

    // 1. Expire peers not heard from within peeringTimeout.
    /** @type {string[]} */
    const timedOut = [];
    for (const [addr, peer] of Object.entries(this.peers)) {
      if (now > peer.lastHeard + this.peeringTimeout) timedOut.push(addr);
    }
    if (timedOut.length > 0) {
      await Promise.all(timedOut.map((addr) => this._expirePeer(addr)));
    }

    // 2. Send reverse-peering packets to peers due for one.
    for (const [addr, peer] of Object.entries(this.peers)) {
      if (now > peer.lastOutbound + this.reversePeeringInterval) {
        try {
          await this._reverseAnnounce(peer.ifname, addr);
          peer.lastOutbound = this._now();
        } catch (/** @type {any} */ e) {
          log(
            "AutoInterface",
            `${this} reverse-peering send to ${addr} failed: ${e.message}`,
            LogLevel.ERROR,
          );
        }
      }
    }

    // 3. Rebind data sockets whose link-local address changed; 4. watchdog.
    for (const ifname of Object.keys(this.adoptedInterfaces)) {
      this._checkLinkLocalChange(ifname);
      this._checkMulticastEcho(ifname, now);
    }
  }

  /**
   * Expires one peer: disconnects its spawned interface (which dispatches
   * `"closed"` so an attached transport removes it) and drops the tracking
   * entries. Mirrors Python's timed-out-peer removal (`detach`/`teardown`).
   * @param {string} addr
   * @returns {Promise<void>}
   * @private
   */
  async _expirePeer(addr) {
    delete this.peers[addr];
    const peer = this.spawnedInterfaces[addr];
    if (peer) {
      delete this.spawnedInterfaces[addr];
      await peer.disconnect();
    }
    log(
      "AutoInterface",
      `${this} removed expired peer ${addr}`,
      LogLevel.DEBUG,
    );
  }

  /**
   * Sends one reverse-peering packet to a peer: the same discovery token
   * (`SHA-256(group_id || own_link_local)`) unicast to the peer's address on
   * the unicast discovery port, so the peer adds us even if our multicast
   * announce didn't reach it. Mirrors Python's `reverse_announce`.
   *
   * Sent from this interface's bound unicast discovery socket, so the source is
   * our scoped link-local (Python uses a fresh unbound socket; equivalent).
   * @param {string} ifname
   * @param {string} peerAddr - Descope'd peer link-local address.
   * @returns {Promise<void>}
   * @private
   */
  async _reverseAnnounce(ifname, peerAddr) {
    const linkLocalAddress = this.adoptedInterfaces[ifname];
    const sock = this.unicastSockets[ifname];
    if (!linkLocalAddress || !sock) return;
    const token = await computeDiscoveryToken(this.groupId, linkLocalAddress);
    const dest = `${peerAddr}%${ifname}`;
    await /** @type {Promise<void>} */ (
      new Promise((resolve, reject) =>
        sock.send(token, this.unicastDiscoveryPort, dest, (err) =>
          err ? reject(err) : resolve(),
        ),
      )
    );
  }

  /**
   * Checks whether an adopted interface's link-local address has changed and,
   * if so, adopts the new one and rebinds its data socket. Mirrors Python's
   * link-local-change handling (which rebinds `interface_servers`). The
   * discovery sockets are left on the old address, matching the Python
   * reference.
   * @param {string} ifname
   * @private
   */
  _checkLinkLocalChange(ifname) {
    const v6 = listAddresses(ifname)[AF_INET6];
    if (!v6) return;
    let current = null;
    for (const entry of v6) {
      if (entry.addr.startsWith("fe80:")) {
        current = descopeLinkLocal(entry.addr);
        break;
      }
    }
    const adopted = this.adoptedInterfaces[ifname];
    if (current && current !== adopted) {
      log(
        "AutoInterface",
        `${this} replacing link-local ${adopted} on ${ifname} with ${current}`,
        LogLevel.DEBUG,
      );
      this.adoptedInterfaces[ifname] = current;
      const oldIdx = this.linkLocalAddresses.indexOf(adopted);
      if (oldIdx >= 0) this.linkLocalAddresses.splice(oldIdx, 1);
      if (!this.linkLocalAddresses.includes(current)) {
        this.linkLocalAddresses.push(current);
      }
      this._rebindDataSocket(ifname, current).catch((/** @type {any} */ e) =>
        log(
          "AutoInterface",
          `${this} data-socket rebind on ${ifname} failed: ${e.message}`,
          LogLevel.WARNING,
        ),
      );
      this.carrierChanged = true;
    }
  }

  /**
   * Rebinds an interface's data socket to a (new) link-local address: closes
   * the old socket and opens a fresh one. Mirrors Python's restart of
   * `interface_servers[ifname]`.
   * @param {string} ifname
   * @param {string} linkLocalAddr
   * @returns {Promise<void>}
   * @private
   */
  async _rebindDataSocket(ifname, linkLocalAddr) {
    const old = this.dataSockets[ifname];
    if (old) {
      delete this.dataSockets[ifname];
      await this._close(old);
    }
    await this._openDataSocket(ifname, linkLocalAddr);
    log(
      "AutoInterface",
      `${this} rebound data socket on ${ifname} to ${linkLocalAddr}`,
      LogLevel.DEBUG,
    );
  }

  /**
   * Multicast-echo carrier watchdog for one interface. If we haven't seen our
   * own multicast announce echo within `multicastEchoTimeout`, flag carrier
   * lost; clear the flag when echoes resume. Mirrors Python's
   * `timed_out_interfaces` / `carrier_changed` logic.
   * @param {string} ifname
   * @param {number} now
   * @private
   */
  _checkMulticastEcho(ifname, now) {
    const lastEcho = this.multicastEchoes[ifname] ?? 0;
    const echoReceived = ifname in this.initialEchoes;
    const wasLost = this.timedOutInterfaces[ifname] === true;
    const lost = now - lastEcho > this.multicastEchoTimeout;
    if (lost) {
      if (!wasLost) {
        this.carrierChanged = true;
        log(
          "AutoInterface",
          `${this} multicast echo timeout on ${ifname}; carrier lost`,
          LogLevel.WARNING,
        );
      }
      this.timedOutInterfaces[ifname] = true;
    } else {
      if (wasLost) {
        this.carrierChanged = true;
        log(
          "AutoInterface",
          `${this} carrier recovered on ${ifname}`,
          LogLevel.WARNING,
        );
      }
      this.timedOutInterfaces[ifname] = false;
    }
    if (!echoReceived) {
      log(
        "AutoInterface",
        `${this} no multicast echoes ever received on ${ifname}; ` +
          "a firewall or the hardware may be blocking multicast",
        LogLevel.ERROR,
      );
    }
  }

  /**
   * Binds a socket and resolves on `listening`, rejecting on `error`.
   * @param {import("node:dgram").Socket} sock
   * @param {number} port
   * @param {string} address
   * @returns {Promise<void>}
   * @private
   */
  _bind(sock, port, address) {
    return new Promise((resolve, reject) => {
      const onError = (/** @type {any} */ err) => {
        sock.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        sock.off("error", onError);
        resolve();
      };
      sock.once("error", onError);
      sock.once("listening", onListening);
      sock.bind(port, address);
    });
  }

  /**
   * Starts the periodic multicast announce for one interface and fires one
   * immediately so peers don't wait a full interval to notice us.
   * @param {string} ifname
   * @private
   */
  _startAnnounceLoop(ifname) {
    if (this._announceTimers[ifname])
      clearInterval(this._announceTimers[ifname]);
    const timer = setInterval(
      () => this._peerAnnounce(ifname).catch((e) => this._announceError(e)),
      this.announceInterval * 1000,
    );
    this._announceTimers[ifname] = timer;
    this._peerAnnounce(ifname).catch((e) => this._announceError(e));
  }

  /**
   * Tears down everything opened for one interface and drops its adoption, used
   * when a later socket bind fails mid-`connect` (e.g. EADDRINUSE because
   * another Reticulum instance holds the port on this link). Mirrors the
   * Python reference's per-interface skip on configuration failure.
   * @param {string} ifname
   * @param {string} linkLocalAddr
   * @returns {Promise<void>}
   * @private
   */
  async _abandonInterface(ifname, linkLocalAddr) {
    if (this._announceTimers[ifname]) {
      clearInterval(this._announceTimers[ifname]);
      delete this._announceTimers[ifname];
    }
    const closers = [
      this.multicastSockets[ifname],
      this.unicastSockets[ifname],
      this.dataSockets[ifname],
    ]
      .filter((s) => s)
      .map((s) => this._close(s));
    delete this.multicastSockets[ifname];
    delete this.unicastSockets[ifname];
    delete this.dataSockets[ifname];
    delete this.adoptedInterfaces[ifname];
    const llIdx = this.linkLocalAddresses.indexOf(linkLocalAddr);
    if (llIdx >= 0) this.linkLocalAddresses.splice(llIdx, 1);
    await Promise.all(closers);
  }

  /**
   * @param {any} e
   * @private
   */
  _announceError(e) {
    log(
      "AutoInterface",
      `${this} announce failed: ${e.message}`,
      LogLevel.WARNING,
    );
  }

  /**
   * Sends one multicast discovery token out the given interface.
   *
   * Mirrors Python's `peer_announce`: the token is
   * `SHA-256(group_id || own_link_local)`, sent to the multicast group. Reuses
   * the bound multicast socket (whose `setMulticastInterface` pins the link)
   * instead of opening a fresh socket per announce — functionally identical and
   * far fewer sockets.
   * @param {string} ifname
   * @returns {Promise<void>}
   * @private
   */
  async _peerAnnounce(ifname) {
    const linkLocalAddress = this.adoptedInterfaces[ifname];
    const sock = this.multicastSockets[ifname];
    if (!linkLocalAddress || !sock) return;
    const token = await computeDiscoveryToken(this.groupId, linkLocalAddress);
    const mcastAddr = /** @type {string} */ (this.mcastDiscoveryAddress);
    await /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        sock.send(token, this.discoveryPort, mcastAddr, () => resolve());
      })
    );
  }

  /**
   * Authenticates an inbound discovery datagram and, on success, records the
   * peer. Verifies that the first {@link HASHLENGTH_BYTES} bytes equal
   * `SHA-256(group_id || src_addr)`, exactly as Python's `discovery_handler`
   * does. Self-multicast-echoes (src is one of our own link-local addresses)
   * feed the carrier watchdog state instead of adding a peer.
   * @param {Uint8Array} data
   * @param {{ address: string; port: number; scopeId?: number }} rinfo
   * @param {string} ifname
   * @returns {Promise<void>}
   * @protected
   */
  async _onDiscoveryMessage(data, rinfo, ifname) {
    if (!this.online) return;
    // Node reports link-local sources WITH a `%scope` suffix (e.g.
    // `fe80::1%lo0`) in rinfo.address, whereas Python's recvfrom yields the
    // bare address. Peers compute the token over the bare address, so descope
    // here to authenticate real Python peers correctly.
    const srcAddr = descopeLinkLocal(rinfo.address);
    const expected = await Identity.fullHash(
      this._concat(this.groupId, new TextEncoder().encode(srcAddr)),
    );
    const offered = data.subarray(0, HASHLENGTH_BYTES);
    if (
      offered.length !== HASHLENGTH_BYTES ||
      !this._bytesEqual(offered, expected)
    ) {
      log(
        "AutoInterface",
        `${this} discovery packet on ${ifname} from ${srcAddr} failed auth`,
        LogLevel.DEBUG,
      );
      return;
    }
    this.addPeer(srcAddr, ifname);
  }

  /**
   * Records a discovered peer, or refreshes a known one, mirroring Python's
   * `add_peer`. For a new peer this spawns an {@link AutoInterfacePeer} data
   * interface, registers it with the attached transport (if any), and dispatches
   * a `"connection"` event with the peer for parity with the other server
   * interfaces.
   *
   * If `addr` is one of our own link-local addresses, this is our own multicast
   * echo: it feeds the carrier watchdog (`multicastEchoes`/`initialEchoes`)
   * rather than adding a peer.
   * @param {string} addr - Descope'd source link-local address.
   * @param {string} ifname
   */
  addPeer(addr, ifname) {
    if (this.linkLocalAddresses.includes(addr)) {
      const matching = Object.keys(this.adoptedInterfaces).find(
        (name) => this.adoptedInterfaces[name] === addr,
      );
      if (matching) {
        this.multicastEchoes[matching] = this._now();
        if (!(matching in this.initialEchoes)) {
          this.initialEchoes[matching] = this._now();
        }
      } else {
        log(
          "AutoInterface",
          `${this} multicast echo on unexpected interface ${ifname}`,
          LogLevel.WARNING,
        );
      }
      return;
    }

    if (addr in this.peers) {
      this.refreshPeer(addr);
      return;
    }

    this.peers[addr] = {
      ifname,
      lastHeard: this._now(),
      lastOutbound: this._now(),
    };

    // Spawn the per-peer data interface.
    const peer = new AutoInterfacePeer({
      parent: this,
      address: addr,
      ifname,
      name: `auto-peer-${this.name}/${ifname}/${addr}`,
    });
    // Inherit the parent's nominal bitrate (Python spawned-interface parity).
    peer.bitrate = this.bitrate;
    this._spawnPeer(peer);
  }

  /**
   * Connects a freshly built peer, records it, auto-registers it with the
   * attached transport, and dispatches `"connection"`.
   *
   * Synchronous because {@link AutoInterfacePeer.connect} is sync-effective
   * (stream setup has no awaits), so the peer's `writable` is ready before the
   * transport grabs its writer, and `addPeer`'s effects (peer count, event)
   * are observable immediately — matching Python's synchronous `add_peer`.
   * @param {AutoInterfacePeer} peer
   * @private
   */
  _spawnPeer(peer) {
    peer
      .connect()
      .catch((/** @type {any} */ e) =>
        log(
          "AutoInterface",
          `${peer} connect failed: ${e.message}`,
          LogLevel.ERROR,
        ),
      );
    this.spawnedInterfaces[peer.address] = peer;
    if (this.transport) this.transport.addInterface(peer);
    log(
      "AutoInterface",
      `${this} added peer ${peer.address} on ${peer.ifname}`,
      LogLevel.DEBUG,
    );
    this.dispatchEvent(new CustomEvent("connection", { detail: peer }));
  }

  /**
   * Refreshes a known peer's last-heard timestamp.
   * @param {string} addr
   */
  refreshPeer(addr) {
    const peer = this.peers[addr];
    if (!peer) return;
    peer.lastHeard = this._now();
  }

  /**
   * Closes all discovery and data sockets, stops the announce loops,
   * disconnects every spawned peer (which dispatches `"closed"` so an attached
   * transport removes it), drops all tracking state, and dispatches
   * `"closed"`.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.online = false;
    if (this._peerJobsTimer) {
      clearInterval(this._peerJobsTimer);
      this._peerJobsTimer = null;
    }
    for (const timer of Object.values(this._announceTimers))
      clearInterval(timer);
    this._announceTimers = {};

    // Tear down spawned peers first: disconnecting them dispatches "closed",
    // which an attached transport turns into removeInterface().
    const peerDisconnects = Object.values(this.spawnedInterfaces).map((peer) =>
      peer.disconnect(),
    );

    const closers = [
      ...Object.values(this.multicastSockets),
      ...Object.values(this.unicastSockets),
      ...Object.values(this.dataSockets),
    ].map((sock) => this._close(sock));
    await Promise.all([...peerDisconnects, ...closers]);
    this.multicastSockets = {};
    this.unicastSockets = {};
    this.dataSockets = {};
    this.spawnedInterfaces = {};
    this.peers = {};
    this.mifDeque = [];
    this.dispatchEvent(new CustomEvent("closed"));
  }

  /**
   * Closes a socket, resolving once closed (or immediately if already closed).
   * @param {import("node:dgram").Socket} sock
   * @returns {Promise<void>}
   * @private
   */
  _close(sock) {
    return new Promise((resolve) => {
      try {
        sock.once("close", resolve);
        sock.close(() => resolve());
      } catch (_e) {
        resolve();
      }
    });
  }

  /**
   * Concatenates two byte arrays.
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {Uint8Array}
   * @private
   */
  _concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /**
   * Constant-time-free equality of two byte arrays of equal length.
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {boolean}
   * @private
   */
  _bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** Monotonic-ish wall-clock seconds, mirroring Python's `time.time()`. */
  _now() {
    return Date.now() / 1000;
  }

  /** @returns {string} */
  toString() {
    return `AutoInterface[${this.name}]`;
  }
}

// Re-export for downstream phases and tests.
export { HW_MTU, MULTICAST_TYPE, SCOPE };
