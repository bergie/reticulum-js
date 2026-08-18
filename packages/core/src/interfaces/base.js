/**
 * @module @reticulum/core/src/interfaces/base.js
 * @description Interface abstract base class
 */

/* @ts-self-types="../../types/src/interfaces/base.d.ts" */

import {
  deriveIfac,
  hasIfacFlag,
  IFAC_MIN_SIZE,
  open as openIfac,
  seal as sealIfac,
} from "../core/ifac.js";
import { LogLevel, log } from "../utils/log.js";

/**
 * An interface `error` event: a {@link CustomEvent} carrying an `Error`.
 *
 * @typedef {CustomEvent<Error>} ErrorEvent
 */

/**
 * An interface `packet` event: a {@link CustomEvent} carrying a received
 * {@link Packet}.
 *
 * @typedef {CustomEvent<{packet: import("../core/packet.js").Packet}>} PacketEvent
 */

/**
 * Snapshot of an interface's identity and byte counters (returned by
 * {@link Interface#getStats}), mirroring the Python reference stats fields.
 *
 * @typedef {Object} InterfaceStats
 * @property {string} name - Human-readable interface name.
 * @property {boolean} online - Whether the interface is currently connected.
 * @property {number} bitrate - Nominal physical bitrate in bits/s.
 * @property {number|null} gravity - Per-interface path preference weight
 *   (`Interface.gravity`); higher = preferred when the same announce is heard
 *   on multiple interfaces. `null` until `Reticulum.addInterface` applies the
 *   default.
 * @property {number} rxb - Total bytes received (post-framing RNS packet
 *   bytes), mirroring the Python reference `self.rxb`. Apps derive a transfer
 *   rate by sampling this over time.
 * @property {number} txb - Total bytes transmitted, mirroring `self.txb`.
 * @property {number} created - Epoch milliseconds when the interface was
 *   constructed (Python `self.created`).
 */

/**
 * `detail` payload of an interface `reconnecting` event.
 *
 * @typedef {Object} ReconnectingEventDetail
 * @property {number} attempt - The upcoming attempt number (1-based).
 * @property {number} waitSeconds - Seconds waited before this attempt.
 * @property {number} maxTries - The configured attempt cap (`Infinity` for
 *   unlimited).
 */

/**
 * An interface `reconnecting` event: a {@link CustomEvent} whose `detail` is a
 * {@link ReconnectingEventDetail}.
 *
 * @typedef {CustomEvent<ReconnectingEventDetail>} ReconnectingEvent
 */

/**
 * Reconnect defaults mirroring the Python reference client interfaces
 * (`RECONNECT_WAIT`, `RECONNECT_MAX_TRIES`, `INITIAL_CONNECT_TIMEOUT`).
 */
const RECONNECT_DEFAULTS = {
  autoReconnect: true,
  reconnectWait: 5,
  maxReconnectTries: Number.POSITIVE_INFINITY,
  connectTimeout: 5,
};

/**
 * Shared reconnect options accepted by client interfaces.
 * @typedef {Object} ReconnectOptions
 * @property {boolean} [autoReconnect]
 * @property {number} [reconnectWait]
 * @property {number|null} [maxReconnectTries]
 * @property {number} [connectTimeout]
 */

/**
 * Returns the JSON Schema properties for the shared reconnect options, for
 * client interface schemas to spread in. Mirrors the Python reference config
 * keys (`kiss_framing` and the rest live per-interface).
 * @returns {Record<string, any>}
 */
function reconnectSchemaProperties() {
  return {
    autoReconnect: {
      type: "boolean",
      default: true,
      description:
        "Whether the initiator (outbound dialer) automatically reconnects " +
        "after the connection drops, with a fixed backoff. When false, " +
        "behaviour is one-shot: a drop is terminal (Python config key: " +
        "implicit; only the initiator reconnects).",
    },
    reconnectWait: {
      type: "number",
      minimum: 0,
      default: 5,
      examples: [5],
      description:
        "Seconds to wait between reconnection attempts (Python config key: " +
        "RECONNECT_WAIT).",
    },
    maxReconnectTries: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
      description:
        "Maximum reconnection attempts per drop before giving up and firing " +
        "a terminal `closed` event. Omit (or null) to retry forever (Python " +
        "config key: max_reconnect_tries; RECONNECT_MAX_TRIES defaults to " +
        "None).",
    },
    connectTimeout: {
      type: "number",
      minimum: 0,
      default: 5,
      examples: [5],
      description:
        "Per-dial connect timeout in seconds (Python config key: " +
        "connect_timeout; INITIAL_CONNECT_TIMEOUT).",
    },
  };
}

/**
 * Node-global ingress-control overrides accepted by the {@link Reticulum}
 * constructor's `ingressControl` config block (camelCase forms of the Python
 * reference's `[reticulum]`-section `ic_*` options, which apply to every
 * interface — Python has no per-interface form of these).
 *
 * @typedef {Object} IngressControlConfig
 * @property {number} [icBurstHold] Seconds a latched burst stays active
 *   (Python config key: ic_burst_hold; default 15).
 * @property {number} [icBurstFreqNew] Announce burst threshold in Hz for
 *   interfaces younger than `icNewTime` (ic_burst_freq_new; default 3).
 * @property {number} [icBurstFreq] Announce burst threshold in Hz for
 *   established interfaces (ic_burst_freq; default 10).
 * @property {number} [icPrBurstFreqNew] Path-request burst threshold in Hz
 *   for new interfaces (ic_pr_burst_freq_new; default 3).
 * @property {number} [icPrBurstFreq] Path-request burst threshold in Hz for
 *   established interfaces (ic_pr_burst_freq; default 8).
 * @property {number} [icNewTime] Interface age in seconds below which the
 *   "new" thresholds apply (ic_new_time; default 7200).
 * @property {number} [icBurstPenalty] Seconds before held announces may
 *   release after an announce burst (ic_burst_penalty; default 15).
 * @property {number} [icHeldReleaseInterval] Seconds between held-announce
 *   releases (ic_held_release_interval; default 5).
 */

/**
 * Computes the arrival frequency (Hz) over a rolling timestamp window,
 * mirroring the Python reference `*_frequency()` methods exactly:
 *
 *   - fewer than `minSample + 1` samples → 0
 *   - a sample older than `decaySeconds` decays (is dropped for the *next*
 *     call — the current reading still uses the pre-drop sample count, as in
 *     Python)
 *   - non-positive span → 0 (guards same-tick sampling)
 *
 * @param {number[]} deque Ring of arrival timestamps (seconds).
 * @param {number} minSample Minimum samples before a reading (exclusive).
 * @param {number} decaySeconds Window decay in seconds.
 * @returns {number} Frequency in Hz.
 */
function frequencyOverWindow(deque, minSample, decaySeconds) {
  const n = deque.length;
  if (!(n > minSample)) return 0;
  const oldest = deque[0];
  const span = Date.now() / 1000 - oldest;
  if (span > decaySeconds) deque.shift();
  if (span <= 0) return 0;
  return n / span;
}

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
            "Auto-defaults to the interface DEFAULT_IFAC_SIZE when a " +
            "network_name / passphrase is set; 0 alone disables IFAC " +
            "(Python config key: ifac_size, given in bits upstream).",
        },
        networkName: {
          type: "string",
          description:
            "Shared interface network name enabling IFAC authentication " +
            "and obfuscation on the link. Both endpoints must set the same " +
            "value (Python config key: networkname / network_name; " +
            "ifac_netname).",
        },
        passphrase: {
          type: "string",
          description:
            "Shared interface passphrase enabling IFAC authentication and " +
            "obfuscation on the link. Both endpoints must set the same " +
            "value (Python config key: passphrase / pass_phrase; " +
            "ifac_netkey).",
        },
        gravity: {
          type: "integer",
          default: 0,
          description:
            "Per-interface path preference weight (`Interface.gravity`). " +
            "When the same announce is heard on multiple interfaces, the " +
            "path table prefers the higher-gravity one. Higher = preferred " +
            "(Python config key: gravity).",
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
   * Whether this interface is the initiator (the outbound dialer). Only
   * initiators reconnect; adopted/server-spawned sockets never do (matching
   * the Python reference `initiator` flag).
   * @type {boolean}
   */
  initiator = false;

  /**
   * Whether the interface is currently open/online.
   * @type {boolean}
   */
  online = false;

  /**
   * Nominal physical bitrate of this interface in bits per second
   * (`self.bitrate` on `RNS.Interfaces.Interface` in the Python reference,
   * default 62500). Each interface overrides this with its medium's rate.
   *
   * Used by `TransportCore.prioritizeInterfaces()` to order the interface set
   * highest-bitrate-first (mirrors the Python reference's
   * `Transport.prioritize_interfaces`); the per-bitrate link-timeout and
   * announce-rate-limit behaviours that also build on it are tracked as
   * Phase 2 of work doc #20. Configured bitrates below
   * {@link Reticulum.MINIMUM_BITRATE} are ignored (matching Python).
   * @type {number}
   */
  bitrate = 62500;

  /**
   * Total bytes received on this interface (`self.rxb` on
   * `RNS.Interfaces.Interface` in the Python reference). Counted as the
   * deserialized RNS packet length — matching Python's `len(data)` in each
   * interface's `process_incoming` — so it reflects the on-the-wire RNS
   * payload, not framing overhead. Apps derive a transfer rate by sampling
   * this counter over time.
   * @type {number}
   */
  rxb = 0;
  /**
   * Total bytes transmitted on this interface (`self.txb` in the Python
   * reference).
   * @type {number}
   */
  txb = 0;
  /**
   * Epoch milliseconds when the interface was constructed (`self.created` in
   * the Python reference, which uses `time.time()`).
   * @type {number}
   */
  created = Date.now();

  /**
   * Per-interface path preference weight (`Interface.gravity` in the Python
   * reference, `DEFAULT_GRAVITY = 0`). When the same announce reaches this
   * node over multiple interfaces, the path table prefers the entry learned
   * via the higher-gravity interface (e.g. a wired backbone over a slow radio
   * link). `null` means "no preference" — {@link import("../core/reticulum.js").Reticulum}
   * substitutes its `defaultGravity` at `addInterface` time.
   * @type {number|null}
   */
  gravity = null;

  // ------------------------------------------------------------------
  // Ingress control (Python `Interface` ingress control — work doc #31)
  // ------------------------------------------------------------------

  /**
   * Rolling-sample cap for the announce/PR frequency deques
   * (`IA_FREQ_SAMPLES` / `IP_FREQ_SAMPLES` / `OP_FREQ_SAMPLES` in the Python
   * reference — all 48; Python reuses `IA_FREQ_SAMPLES` for the PR deque).
   * @type {number}
   */
  static FREQ_SAMPLES = 48;
  /**
   * Seconds after which an unanswered announce sample decays out of the
   * deque (`AR_FREQ_DECAY = 1/AR_MINFREQ_HZ` = 10 s).
   * @type {number}
   */
  static ANNOUNCE_FREQ_DECAY = 10;
  /**
   * Seconds after which a PR sample decays (`PR_FREQ_DECAY` = 10 s).
   * @type {number}
   */
  static PR_FREQ_DECAY = 10;
  /**
   * Interface age in seconds below which the stricter "new interface"
   * burst thresholds apply (`IC_NEW_TIME` = 2 h).
   * @type {number}
   */
  static IC_NEW_TIME = 2 * 60 * 60;
  /** Announce burst threshold for new interfaces, Hz (`IC_BURST_FREQ_NEW`). */
  static IC_BURST_FREQ_NEW = 3;
  /** Announce burst threshold for established interfaces, Hz (`IC_BURST_FREQ`). */
  static IC_BURST_FREQ = 10;
  /** Path-request burst threshold for new interfaces, Hz (`IC_PR_BURST_FREQ_NEW`). */
  static IC_PR_BURST_FREQ_NEW = 3;
  /** Path-request burst threshold for established interfaces, Hz (`IC_PR_BURST_FREQ`). */
  static IC_PR_BURST_FREQ = 8;
  /**
   * Quiet evaluations required to unlatch a PR burst after the hold
   * (`ic_pr_burst_cooldown` = 3; any above-threshold evaluation resets it).
   * Anti-flapping hysteresis added upstream in "Improved PR ingress
   * limiter" — the announce limiter has no cooldown.
   * @type {number}
   */
  static IC_PR_BURST_COOLDOWN = 3;
  /** Seconds a burst stays latched after activation (`IC_BURST_HOLD`). */
  static IC_BURST_HOLD = 15;
  /** Seconds before held announces may release after a burst (`IC_BURST_PENALTY`). */
  static IC_BURST_PENALTY = 15;
  /**
   * Minimum deque samples before a frequency is reported
   * (`IC_DEQUE_MIN_SAMPLE` = 2 — i.e. > 2 samples).
   * @type {number}
   */
  static IC_DEQUE_MIN_SAMPLE = 2;

  /**
   * Whether ingress burst control is enabled on this interface (Python
   * `ingress_control`). Disabling makes {@link shouldIngressLimit} and
   * {@link shouldIngressLimitPr} always return `false`.
   * @type {boolean}
   */
  ingressControl = true;
  /** @type {number} */
  icNewTime = Interface.IC_NEW_TIME;
  /** @type {number} */
  icBurstFreqNew = Interface.IC_BURST_FREQ_NEW;
  /** @type {number} */
  icBurstFreq = Interface.IC_BURST_FREQ;
  /** @type {number} */
  icPrBurstFreqNew = Interface.IC_PR_BURST_FREQ_NEW;
  /** @type {number} */
  icPrBurstFreq = Interface.IC_PR_BURST_FREQ;
  /** @type {number} */
  icBurstHold = Interface.IC_BURST_HOLD;
  /** @type {number} */
  icBurstPenalty = Interface.IC_BURST_PENALTY;
  /** @type {number} */
  arFreqDecay = Interface.ANNOUNCE_FREQ_DECAY;
  /** @type {number} */
  prFreqDecay = Interface.PR_FREQ_DECAY;

  /** Incoming-announce timestamp ring (seconds). @type {number[]} */
  iaFreqDeque = [];
  /** Incoming path-request timestamp ring (seconds). @type {number[]} */
  ipFreqDeque = [];
  /** Outgoing path-request timestamp ring (seconds). @type {number[]} */
  opFreqDeque = [];

  /** @type {boolean} */
  icBurstActive = false;
  /** @type {number} */
  icBurstActivated = 0;
  /** @type {boolean} */
  icPrBurstActive = false;
  /** @type {number} */
  icPrBurstActivated = 0;
  /** Remaining quiet evaluations before a latched PR burst unlatches. */
  icPrBurstCooldown = 0;
  /** Earliest held-announce release time (seconds); set on burst activation. */
  icHeldRelease = 0;

  /**
   * Applies node-global ingress-control overrides to this interface
   * (mirrors Python, where every interface reads the `[reticulum]`-section
   * `ic_*` defaults via `RNS.Reticulum.get_instance()._default_ic_*()` — there
   * is no per-interface config for these). Only keys present in `overrides`
   * are assigned; absent keys keep the class constants. Called by
   * {@link import("../core/reticulum.js").Reticulum#addInterface} when the
   * node was constructed with an `ingressControl` config block. These are
   * deliberately **not** constructor options / interface schema properties:
   * they scope to the whole node, like the Python reference.
   *
   * @param {Partial<IngressControlConfig>} overrides
   */
  applyIngressConfig(overrides) {
    if (!overrides) return;
    if (overrides.icBurstHold !== undefined)
      this.icBurstHold = overrides.icBurstHold;
    if (overrides.icBurstFreqNew !== undefined)
      this.icBurstFreqNew = overrides.icBurstFreqNew;
    if (overrides.icBurstFreq !== undefined)
      this.icBurstFreq = overrides.icBurstFreq;
    if (overrides.icPrBurstFreqNew !== undefined)
      this.icPrBurstFreqNew = overrides.icPrBurstFreqNew;
    if (overrides.icPrBurstFreq !== undefined)
      this.icPrBurstFreq = overrides.icPrBurstFreq;
    if (overrides.icNewTime !== undefined) this.icNewTime = overrides.icNewTime;
    if (overrides.icBurstPenalty !== undefined)
      this.icBurstPenalty = overrides.icBurstPenalty;
    if (overrides.icHeldReleaseInterval !== undefined)
      this.icHeldReleaseInterval = overrides.icHeldReleaseInterval;
  }

  /**
   * Age of this interface in seconds (Python `age()`).
   * @returns {number}
   */
  age() {
    return (Date.now() - this.created) / 1000;
  }

  /**
   * Records an inbound announce into {@link iaFreqDeque} (Python
   * `received_announce`). Spawned interfaces propagate the sample to their
   * parent so bursts are detected at the medium level.
   * @param {boolean} [fromSpawned] Internal: true when called on a parent.
   */
  receivedAnnounce(fromSpawned = false) {
    this.iaFreqDeque.push(Date.now() / 1000);
    if (this.iaFreqDeque.length > Interface.FREQ_SAMPLES) {
      this.iaFreqDeque.shift();
    }
    if (!fromSpawned && /** @type {any} */ (this).parentInterface) {
      /** @type {any} */ (this).parentInterface.receivedAnnounce(true);
    }
  }

  /**
   * Records an inbound `path?` request into {@link ipFreqDeque} (Python
   * `received_path_request`). Spawned interfaces propagate to their parent.
   * @param {boolean} [fromSpawned] Internal: true when called on a parent.
   */
  receivedPathRequest(fromSpawned = false) {
    this.ipFreqDeque.push(Date.now() / 1000);
    if (this.ipFreqDeque.length > Interface.FREQ_SAMPLES) {
      this.ipFreqDeque.shift();
    }
    if (!fromSpawned && /** @type {any} */ (this).parentInterface) {
      /** @type {any} */ (this).parentInterface.receivedPathRequest(true);
    }
  }

  /**
   * Records an outbound `path?` request into {@link opFreqDeque} (Python
   * `sent_path_request`); consumed by egress PR limiting (work doc #31 step 4).
   * @param {boolean} [fromSpawned] Internal: true when called on a parent.
   */
  sentPathRequest(fromSpawned = false) {
    this.opFreqDeque.push(Date.now() / 1000);
    if (this.opFreqDeque.length > Interface.FREQ_SAMPLES) {
      this.opFreqDeque.shift();
    }
    if (!fromSpawned && /** @type {any} */ (this).parentInterface) {
      /** @type {any} */ (this).parentInterface.sentPathRequest(true);
    }
  }

  /**
   * Incoming announce rate in Hz over the current sample window (Python
   * `incoming_announce_frequency`). Returns 0 with fewer than
   * {@link Interface.IC_DEQUE_MIN_SAMPLE}+1 samples; a sample older than
   * {@link arFreqDecay} decays out of the window.
   * @returns {number}
   */
  incomingAnnounceFrequency() {
    return frequencyOverWindow(
      this.iaFreqDeque,
      Interface.IC_DEQUE_MIN_SAMPLE,
      this.arFreqDecay,
    );
  }

  /**
   * Incoming `path?` request rate in Hz (Python `incoming_pr_frequency`).
   * Same sampling rules as {@link incomingAnnounceFrequency}, with the PR
   * decay window.
   * @returns {number}
   */
  incomingPrFrequency() {
    return frequencyOverWindow(
      this.ipFreqDeque,
      Interface.IC_DEQUE_MIN_SAMPLE,
      this.prFreqDecay,
    );
  }

  /**
   * Outgoing `path?` request rate in Hz (Python `outgoing_pr_frequency`).
   * Needs more than one sample.
   * @returns {number}
   */
  outgoingPrFrequency() {
    return frequencyOverWindow(this.opFreqDeque, 1, this.prFreqDecay);
  }

  /**
   * Whether announce ingress should be limited right now (Python
   * `should_ingress_limit`). Latches a burst when the incoming announce
   * frequency exceeds the threshold for the interface's age — stricter
   * (`icBurstFreqNew`) during the first {@link icNewTime} seconds. Once
   * latched, stays limiting for at least {@link icBurstHold} seconds and
   * until the frequency drops back below the threshold; the call that
   * unlatches still reports `true` (mirroring the Python reference, the
   * next packet after it flows normally).
   *
   * Consumers: held-announce buffering for unknown destinations (work doc
   * #31 step 3). The announce frequency side effects (latching plus arming
   * {@link icHeldRelease} with the {@link icBurstPenalty}) match Python so
   * the state is already correct when that lands.
   *
   * @returns {boolean}
   */
  shouldIngressLimit() {
    if (!this.ingressControl) return false;
    const freqThreshold =
      this.age() < this.icNewTime ? this.icBurstFreqNew : this.icBurstFreq;
    const iaFreq = this.incomingAnnounceFrequency();

    if (this.icBurstActive) {
      if (
        iaFreq < freqThreshold &&
        Date.now() / 1000 > this.icBurstActivated + this.icBurstHold
      ) {
        if (this.iaFreqDeque.length >= Interface.IC_DEQUE_MIN_SAMPLE) {
          this.icBurstActive = false;
        }
      }
      return true;
    }

    if (iaFreq > freqThreshold) {
      this.icBurstActive = true;
      this.icBurstActivated = Date.now() / 1000;
      this.icHeldRelease = this.icBurstActivated + this.icBurstPenalty;
      return true;
    }
    return false;
  }

  /**
   * Whether `path?` request ingress should be limited right now (Python
   * `should_ingress_limit_pr`, incl. the upstream cooldown hysteresis).
   * Latches when the incoming PR frequency exceeds the age-dependent
   * threshold ({@link icPrBurstFreqNew} during the first {@link icNewTime}
   * seconds, {@link icPrBurstFreq} after). Once latched, stays limiting for
   * at least {@link icBurstHold} seconds; after the hold, unlatching takes
   * {@link Interface.IC_PR_BURST_COOLDOWN}+1 consecutive below-threshold
   * evaluations — any above-threshold evaluation resets the cooldown
   * (anti-flapping at the boundary). Consumers: `TransportCore` drops
   * unique-tag path requests while a burst is latched (work doc #31 step 2 —
   * our inline processing equivalent of the Python reference's
   * `TC_INGRESS_LIMITED` traffic-class demotion).
   *
   * @returns {boolean}
   */
  shouldIngressLimitPr() {
    if (!this.ingressControl) return false;
    const freqThreshold =
      this.age() < this.icNewTime ? this.icPrBurstFreqNew : this.icPrBurstFreq;
    const ipFreq = this.incomingPrFrequency();

    if (this.icPrBurstActive) {
      if (
        ipFreq < freqThreshold &&
        Date.now() / 1000 > this.icPrBurstActivated + this.icBurstHold
      ) {
        if (this.icPrBurstCooldown <= 0) {
          this.icPrBurstActive = false;
        } else {
          this.icPrBurstCooldown -= 1;
        }
      } else {
        this.icPrBurstCooldown = Interface.IC_PR_BURST_COOLDOWN;
      }
      return true;
    }

    if (ipFreq > freqThreshold) {
      this.icPrBurstActive = true;
      this.icPrBurstActivated = Date.now() / 1000;
      this.icPrBurstCooldown = Interface.IC_PR_BURST_COOLDOWN;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // IFAC (Interface Authentication Code) — § Transport.transmit/inbound
  // ------------------------------------------------------------------

  /**
   * Shared network name enabling IFAC (`ifac_netname`). When set together
   * with {@link ifacNetkey} (or alone), packets on this interface are
   * authenticated and obfuscated. Both endpoints must share the same value.
   * @type {string|null}
   */
  ifacNetname = null;
  /**
   * Shared passphrase enabling IFAC (`ifac_netkey`). See {@link ifacNetname}.
   * @type {string|null}
   */
  ifacNetkey = null;
  /**
   * IFAC field size in bytes. When a network name / passphrase is set this
   * auto-defaults to {@link DEFAULT_IFAC_SIZE} (mirroring upstream
   * `interface.ifac_size = interface.DEFAULT_IFAC_SIZE`); 0 with no shared
   * secret disables IFAC entirely.
   * @type {number}
   */
  ifacSize = 0;
  /**
   * Per-interface default IFAC size (bytes) when IFAC is enabled but no
   * explicit `ifacSize` was given. Mirrors `DEFAULT_IFAC_SIZE` on each
   * Python interface (16 for Auto/Backbone, 8 for AX.25). Subclasses
   * override; the base default of 16 matches the common case.
   * @type {number}
   */
  DEFAULT_IFAC_SIZE = 16;
  /**
   * Derived IFAC Ed25519 identity (only its signing ability is used).
   * Populated lazily by {@link _ensureIfacMaterial}; `null` while IFAC is
   * disabled or before first use.
   * @type {import("../core/identity.js").Identity|null}
   */
  ifacIdentity = null;
  /**
   * Derived 64-byte IFAC key (HKDF over {@link import("../core/ifac.js").IFAC_SALT}).
   * @type {Uint8Array|null}
   */
  ifacKey = null;
  /**
   * IFAC signature of `fullHash(ifacKey)`, published in the discovery
   * announce. @type {Uint8Array|null}
   */
  ifacSignature = null;
  /**
   * Memoised {@link _ensureIfacMaterial} promise so the HKDF derivation runs
   * at most once per interface.
   * @type {Promise<boolean>|null}
   * @private
   */
  _ifacMaterialPromise = null;

  /**
   * Whether IFAC is enabled on this interface (a shared secret is configured).
   * @returns {boolean}
   */
  get ifacEnabled() {
    return Boolean(this.ifacNetname || this.ifacNetkey);
  }

  /**
   * Whether this interface is currently open/online.
   * @type {boolean}
   */
  get isOpen() {
    return this.online;
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
   * Dials the peer and sets up the RNS streams, resolving once connected and
   * dispatching `connected`. Implemented by reconnect-capable client
   * subclasses; used both for the initial connection and each reconnect
   * attempt by the shared {@link Interface._runReconnectLoop}.
   * @returns {Promise<void>}
   * @protected
   */
  async _establishConnection() {
    throw new Error("Interface._establishConnection is not implemented");
  }

  /**
   * Closes the connection.
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error("Interface.disconnect is not implemented");
  }

  /**
   * Optional hook invoked by {@link import("../transport/transport.js").TransportCore#addInterface}
   * with the transport that owns this interface, right after the interface is
   * attached.
   *
   * The base implementation is a no-op. Interfaces that spawn sub-interfaces
   * dynamically — notably {@link AutoInterface}, which discovers peers and
   * spawns one per peer — override it to remember the transport so the spawned
   * peers can be auto-registered without a separate `Reticulum` global (the
   * Python reference uses the global `RNS.Transport.add_interface` for this).
   *
   * Overriders should also register any peers spawned before the transport was
   * attached, so the `addInterface`/`connect` call order doesn't matter.
   * @param {import("../transport/transport.js").TransportCore} _transport
   */
  attachTransport(_transport) {}

  /**
   * Derives and caches the IFAC key/identity/signature from the configured
   * {@link ifacNetname} / {@link ifacNetkey}, mirroring the per-interface
   * setup in `RNS/Reticulum.py` (~l.975). No-op (resolves `false`) when IFAC
   * is disabled. Memoised so the HKDF + Ed25519 key load runs at most once.
   * @returns {Promise<boolean>} `true` if IFAC material is available.
   * @protected
   */
  _ensureIfacMaterial() {
    if (this._ifacMaterialPromise) return this._ifacMaterialPromise;
    this._ifacMaterialPromise = (async () => {
      if (!this.ifacEnabled) return false;
      const material = await deriveIfac(this.ifacNetname, this.ifacNetkey);
      if (!material) return false;
      this.ifacIdentity = material.ifacIdentity;
      this.ifacKey = material.ifacKey;
      this.ifacSignature = material.ifacSignature;
      if (!this.ifacSize || this.ifacSize < IFAC_MIN_SIZE) {
        this.ifacSize = this.DEFAULT_IFAC_SIZE;
      }
      return true;
    })();
    return this._ifacMaterialPromise;
  }

  /**
   * Seals raw (un-IFACed) wire bytes for transmit (`RNS.Transport.transmit`).
   * No-op passthrough when IFAC is disabled; otherwise derives the IFAC
   * material on first use, then signs, sets the `ifac_flag`, inserts the IFAC
   * field and XOR-masks the packet. Subclasses/interfaces call this at the
   * chokepoint where a packet is serialised to bytes, just before framing.
   * @param {Uint8Array} raw Serialised, unsealed wire bytes.
   * @returns {Promise<Uint8Array>} The bytes to put on the medium.
   * @protected
   */
  async _sealRaw(raw) {
    if (!this.ifacEnabled) return raw;
    await this._ensureIfacMaterial();
    return sealIfac(raw, {
      ifacIdentity: /** @type {import("../core/identity.js").Identity} */ (
        this.ifacIdentity
      ),
      ifacKey: /** @type {Uint8Array} */ (this.ifacKey),
      ifacSize: this.ifacSize,
    });
  }

  /**
   * Verifies and unseals inbound raw wire bytes (`RNS.Transport.inbound`).
   *
   * Enforces the flag-presence rules: an IFAC-enabled interface drops a
   * flag-clear packet, and a plain interface drops a flag-set packet — both
   * return `null` (silent drop). For an IFAC interface it then unmasks,
   * strips the IFAC and verifies it by re-signing; a mismatch also yields
   * `null`. Subclasses/interfaces call this at the chokepoint where a frame
   * has been unframed to bytes, just before `Packet.deserialize`.
   * @param {Uint8Array} raw Sealed or plain wire bytes straight off the medium.
   * @returns {Promise<Uint8Array|null>} The unsealed bytes, or `null` to drop.
   * @protected
   */
  async _openRaw(raw) {
    if (!this.ifacEnabled) {
      // No IFAC configured: reject anything claiming to carry an IFAC.
      return hasIfacFlag(raw) ? null : raw;
    }
    await this._ensureIfacMaterial();
    if (!hasIfacFlag(raw)) return null; // IFAC expected but flag absent.
    return openIfac(raw, {
      ifacIdentity: /** @type {import("../core/identity.js").Identity} */ (
        this.ifacIdentity
      ),
      ifacKey: /** @type {Uint8Array} */ (this.ifacKey),
      ifacSize: this.ifacSize,
    });
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

  // ------------------------------------------------------------------
  // Statistics (Python `self.rxb` / `self.txb` / `self.created`)
  // ------------------------------------------------------------------

  /**
   * Records an outbound packet against {@link txb}. Subclasses (or the
   * interface's outbound stream `write` callback) call this at the point a
   * packet is handed to the medium — the single chokepoint where every
   * transmitted packet passes, whether sent via {@link send}, the transport
   * router, or a broadcast. Mirrors the `self.txb += len(data)` line in each
   * Python interface's `process_outgoing`.
   *
   * RNodeInterface overrides its own counting (it measures the IFAC-inclusive
   * wire payload) and does not call this.
   * @param {import("../core/packet.js").Packet} packet
   * @protected
   */
  _recordOutbound(packet) {
    this.txb += packet.serialize().length;
  }

  /**
   * Counts an inbound packet against {@link rxb} and dispatches the `"packet"`
   * event, the single inbound chokepoint each interface's read loop funnels
   * through. Mirrors the `self.rxb += len(data)` + `self.owner.inbound(...)`
   * pairing in each Python interface's `process_incoming`.
   *
   * Uses the deserialized packet's cached raw bytes when available (set by
   * `Packet.deserialize`), avoiding a re-serialize. RNodeInterface dispatches
   * its own packets (it counts the IFAC-inclusive payload) and does not call
   * this.
   * @param {import("../core/packet.js").Packet} packet
   * @protected
   */
  _dispatchPacket(packet) {
    const raw = /** @type {Uint8Array | undefined} */ (packet.raw);
    this.rxb += raw && raw.length > 0 ? raw.length : packet.serialize().length;
    this.dispatchEvent(new CustomEvent("packet", { detail: { packet } }));
  }

  /**
   * Returns a snapshot of traffic and link statistics for this interface, for
   * observability and UIs. Mirrors the fields apps derive from the Python
   * reference's `self.rxb` / `self.txb` / `self.bitrate` / `self.created`.
   *
   * Subclasses that carry medium-specific telemetry (notably
   * {@link import("./rnode.js").RNodeInterface}, which exposes RNode airtime,
   * channel load and signal quality) override this to extend the snapshot.
   * @returns {InterfaceStats}
   */
  getStats() {
    return {
      name: this.name,
      online: this.online,
      bitrate: this.bitrate,
      gravity: this.gravity,
      rxb: this.rxb,
      txb: this.txb,
      created: this.created,
    };
  }

  // ------------------------------------------------------------------
  // Shared reconnection machinery (used by client interfaces)
  // ------------------------------------------------------------------

  /**
   * Whether automatic reconnection is enabled for this initiator interface.
   * @type {boolean}
   */
  autoReconnect = RECONNECT_DEFAULTS.autoReconnect;
  /**
   * Seconds to wait between reconnection attempts.
   * @type {number}
   */
  reconnectWait = RECONNECT_DEFAULTS.reconnectWait;
  /**
   * Maximum reconnection attempts per drop. `Infinity` retries forever.
   * @type {number}
   */
  maxReconnectTries = RECONNECT_DEFAULTS.maxReconnectTries;
  /**
   * Per-dial connect timeout in seconds.
   * @type {number}
   */
  connectTimeout = RECONNECT_DEFAULTS.connectTimeout;

  /**
   * Permanent stop signal read by the reconnect loop. Set by `disconnect()`.
   * @type {boolean}
   */
  detached = false;

  /**
   * Single-flight guard: only one reconnect loop runs at a time.
   * @type {boolean}
   * @protected
   */
  _reconnecting = false;

  /**
   * Reconnect attempt counter for the current drop episode. Reset to 0 at the
   * start of each {@link Interface._runReconnectLoop} run.
   * @type {number}
   * @protected
   */
  _reconnectAttempts = 0;

  /**
   * AbortController for the current reconnect wait, so `disconnect()` can
   * cancel an in-flight backoff immediately.
   * @type {AbortController | null}
   * @protected
   */
  _reconnectAbort = null;

  /**
   * Whether a terminal `closed` event has already been dispatched for the
   * current connection episode (dedupe guard).
   * @type {boolean}
   * @protected
   */
  _closed = false;

  /**
   * Initializes shared reconnect state from constructor options. Called by
   * client interface subclasses (TCP, WebSocket) that support reconnection.
   *
   * Subclasses must also set {@link Interface.initiator}: `true` for an
   * outbound dialer, `false` for an adopted/server-spawned socket.
   * @param {ReconnectOptions} options
   * @protected
   */
  _initReconnectState(options) {
    this.autoReconnect =
      options.autoReconnect !== undefined
        ? options.autoReconnect
        : RECONNECT_DEFAULTS.autoReconnect;
    this.reconnectWait =
      options.reconnectWait !== undefined
        ? options.reconnectWait
        : RECONNECT_DEFAULTS.reconnectWait;
    // Python treats `max_reconnect_tries = None` as "retry forever".
    this.maxReconnectTries =
      options.maxReconnectTries === undefined ||
      options.maxReconnectTries === null
        ? Number.POSITIVE_INFINITY
        : options.maxReconnectTries;
    this.connectTimeout =
      options.connectTimeout !== undefined
        ? options.connectTimeout
        : RECONNECT_DEFAULTS.connectTimeout;
    this._reconnecting = false;
    this._reconnectAttempts = 0;
    this._reconnectAbort = null;
    this.detached = false;
  }

  /**
   * Signals the reconnect loop to stop and cancels any in-flight backoff.
   * Client subclasses call this at the top of their `disconnect()`.
   * @protected
   */
  _cancelReconnect() {
    this.detached = true;
    if (this._reconnectAbort) {
      this._reconnectAbort.abort();
      this._reconnectAbort = null;
    }
  }

  /**
   * Dispatches a terminal `closed` event exactly once per connection episode.
   * @protected
   */
  _dispatchClosed() {
    if (this._closed) return;
    this._closed = true;
    this.online = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  /**
   * Called when the underlying connection drops (the inbound stream ends or
   * errors). For an initiator with auto-reconnect enabled and not deliberately
   * detached, dispatches `disconnected` and kicks off the reconnect loop;
   * otherwise dispatches a terminal `closed` event.
   *
   * Matches the Python reference `read_loop`, which reconnects the initiator
   * on any termination and tears down (non-reconnecting) everyone else.
   * @protected
   */
  _handleConnectionLost() {
    this.online = false;
    if (this.detached) {
      this._dispatchClosed();
      return;
    }
    if (this.initiator && this.autoReconnect) {
      this.dispatchEvent(new CustomEvent("disconnected"));
      this._runReconnectLoop();
    } else {
      this._dispatchClosed();
    }
  }

  /**
   * Runs the single-flight reconnect loop. Repeatedly waits `reconnectWait`
   * seconds then attempts to re-establish the connection via the subclass
   * `_establishConnection()` hook, until it succeeds, the interface is
   * detached, or `maxReconnectTries` is exceeded (terminal `closed`).
   *
   * Each attempt fires a `reconnecting` event with the upcoming attempt
   * number, the wait, and the cap, for observability. A successful reconnect
   * fires `connected` (via `_establishConnection`).
   * @protected
   */
  async _runReconnectLoop() {
    if (this._reconnecting) return; // single-flight
    this._reconnecting = true;
    this._reconnectAttempts = 0;
    this._closed = false;
    this._reconnectAbort = new AbortController();
    const abortSignal = this._reconnectAbort.signal;
    try {
      while (!this.detached) {
        this._reconnectAttempts += 1;
        if (
          this.maxReconnectTries !== Number.POSITIVE_INFINITY &&
          this._reconnectAttempts > this.maxReconnectTries
        ) {
          log(
            this.name,
            `Max reconnection attempts (${this.maxReconnectTries}) reached; giving up`,
            LogLevel.ERROR,
          );
          this._dispatchClosed();
          return;
        }

        this.dispatchEvent(
          new CustomEvent("reconnecting", {
            detail: {
              attempt: this._reconnectAttempts,
              waitSeconds: this.reconnectWait,
              maxTries: this.maxReconnectTries,
            },
          }),
        );

        await this._sleepInterruptible(this.reconnectWait * 1000, abortSignal);
        if (this.detached) break;

        try {
          await this._establishConnection();
          return; // reconnected; the new inbound loop owns the next episode
        } catch (e) {
          log(
            this.name,
            `Reconnection attempt ${this._reconnectAttempts} failed: ${/** @type {any} */ (e).message}`,
            LogLevel.DEBUG,
          );
          // loop and try again
        }
      }
    } finally {
      this._reconnecting = false;
    }
  }

  /**
   * Resolves after `ms`, or immediately if `signal` aborts. Used so
   * `disconnect()` can cancel an in-flight reconnect backoff at once.
   * @param {number} ms
   * @param {AbortSignal} signal
   * @returns {Promise<void>}
   * @protected
   */
  _sleepInterruptible(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      // The backoff timer intentionally keeps the event loop alive. An
      // interface that is actively reconnecting is doing real work: the
      // process should not exit while it still has a live transport retrying.
      // Earlier this was `timer.unref()`'d to be "daemon-like", but that made
      // Deno's test runner treat the loop as idle and bail out of tests that
      // `await` the terminal `closed`/`connected` event ("Promise resolution
      // is still pending but the event loop has already resolved"). Cancelling
      // via `disconnect()` aborts `signal` and clears the timer regardless.
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export { reconnectSchemaProperties };
