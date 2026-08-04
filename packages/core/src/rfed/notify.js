/**
 * @file notify.js
 * @description rfed notify system — registration registry, command parsing,
 *   and the §9.3 wake-packet codec (work doc #25, Phase 5).
 *
 * When a blob is deferred for an offline subscriber, the node sends a
 * lightweight wake-up to each notify relay the subscriber has registered for
 * that channel. The wake packet is a msgpack Map of destination hashes only
 * (no message content) so a relay (APNs/FCM/UnifiedPush bridge) can poke the
 * device without the node holding platform credentials. Mirrors Rust
 * `rfed::notify` (`NotifyRegistry`, `dispatch_notify`, `rns::dispatch`).
 *
 * Registration protocol (SPEC §9.1): the subscriber signs a command and sends
 * `[bin(command), bin(64) pubkey, bin(64) sig]` (the shared
 * `verify_signed_payload` contract) to `/rfed/notify/register`,
 * `/rfed/notify/unregister`, or `/rfed/notify/clear` on `rfed.notify` (legacy)
 * or `rfed.notify.register` / `rfed.notify.unregister` (split). The command is
 * either the modern `["register"|"unregister"|"clear", relay_hex_str|nil,
 * bin(16) channel_hash|nil]` or the legacy `[relay_hex_str, bin(16) ch|nil]`.
 *
 * `NotifyRegistry` is per-node and never synced (privacy + exactly-once wake).
 */

import { MicroMsgPack } from "../utils/msgpack.js";
import { fromHex } from "../utils/encoding.js";

/** Valid notify command operations (SPEC §9.1). */
export const NOTIFY_REGISTER = "register";
export const NOTIFY_UNREGISTER = "unregister";
export const NOTIFY_CLEAR = "clear";

/**
 * Validates a relay destination hash: exactly 32 lowercase ASCII hex digits
 * (16-byte RNS truncated hash). Returns `null` when valid, else an error
 * reason (Rust `validate_relay_hash`).
 *
 * @param {string} hash
 * @returns {string|null}
 */
export function validateRelayHash(hash) {
  if (typeof hash !== "string" || hash.length !== 32) {
    return "relay hash must be a 32-char lowercase hex destination hash";
  }
  if (!/^[0-9a-f]{32}$/.test(hash)) {
    return "relay hash must be a 32-char lowercase hex destination hash";
  }
  return null;
}

/**
 * Parses a signed notify command's inner value (Rust `parse_notify_command`).
 *
 * Modern form: `["register"|"unregister"|"clear", relay_hex_str|nil,
 * bin(16) channel_hash|nil]`. Legacy form (when `defaultKind` is set and the
 * value isn't a 3-array): `[relay_hex_str, bin(16) ch|nil]`, or a bare string
 * for clear.
 *
 * @param {Uint8Array} valueBytes
 * @param {string} [defaultKind] - Inferred from the request path; `op` in the
 *   modern form must match it when provided.
 * @returns {{ kind: string, relayHash: string|null, channelHash: Uint8Array|null }}
 */
export function parseNotifyCommand(valueBytes, defaultKind) {
  if (defaultKind === NOTIFY_CLEAR && valueBytes.length === 0) {
    return { kind: NOTIFY_CLEAR, relayHash: null, channelHash: null };
  }

  let decoded = null;
  try {
    decoded = MicroMsgPack.decode(valueBytes);
  } catch {
    decoded = null;
  }

  // Modern 3-array form with an explicit op string.
  if (Array.isArray(decoded) && decoded.length >= 3) {
    const [opVal, relayVal, chVal] = decoded;
    if (typeof opVal === "string") {
      const kind = opVal;
      if (![NOTIFY_REGISTER, NOTIFY_UNREGISTER, NOTIFY_CLEAR].includes(kind)) {
        throw new Error(`unknown notify op '${kind}'`);
      }
      if (defaultKind && defaultKind !== kind) {
        throw new Error(
          `notify op mismatch: payload=${kind} handler=${defaultKind}`,
        );
      }
      const relayHash =
        typeof relayVal === "string" && relayVal.length > 0 ? relayVal : null;
      const channelHash =
        chVal instanceof Uint8Array && chVal.length === 16 ? chVal : null;
      return { kind, relayHash, channelHash };
    }
  }

  // Legacy 2-array form `[relay_hex_str, bin(16) ch|nil]` (op from the path).
  if (!defaultKind) {
    throw new Error("notify DATA payload missing op");
  }
  if (Array.isArray(decoded) && decoded.length >= 2) {
    const relay =
      typeof decoded[0] === "string" ? decoded[0] : "";
    const ch =
      decoded[1] instanceof Uint8Array && decoded[1].length === 16
        ? decoded[1]
        : null;
    return {
      kind: defaultKind,
      relayHash: relay.length > 0 ? relay : null,
      channelHash: ch,
    };
  }
  // Bare string fallback (e.g. legacy register with just a relay hash).
  if (typeof decoded === "string") {
    return {
      kind: defaultKind,
      relayHash: decoded.length > 0 ? decoded : null,
      channelHash: null,
    };
  }
  return { kind: defaultKind, relayHash: null, channelHash: null };
}

/**
 * Builds the §9.3 wake-packet msgpack Map: `{ "receiver" → bin(16) }` plus an
 * optional `"sender"` (LXMF path) and/or `"channel"` (rfed.channel fanout).
 * String keys, binary values; missing keys are omitted (Rust
 * `encode_wake_payload`).
 *
 * @param {{ receiver: Uint8Array, sender?: Uint8Array|null, channel?: Uint8Array|null }} parts
 * @returns {Uint8Array}
 */
export function encodeWakePayload({ receiver, sender, channel }) {
  /** @type {Record<string, Uint8Array>} */
  const map = { receiver };
  if (sender instanceof Uint8Array && sender.length > 0) map.sender = sender;
  if (channel instanceof Uint8Array && channel.length > 0) map.channel = channel;
  return MicroMsgPack.encode(map);
}

/**
 * A single notify registration record.
 * @typedef {Object} NotifyRegistration
 * @property {Uint8Array} subscriberHash - Subscriber's identity hash.
 * @property {Uint8Array|null} channelHash - Channel hash, or `null` for LXMF/global.
 * @property {string} relayHash - 32-char hex relay destination hash.
 * @property {number} registered - Unix timestamp (seconds) of registration.
 */

/**
 * Per-node notify registration table. Maps
 * `(subscriber_hash, channel_hash|null, relay_hash)` triples. Never synced
 * between peers (Rust `NotifyRegistry`); persistence is a runner concern.
 */
export class NotifyRegistry {
  constructor() {
    /** @type {NotifyRegistration[]} */
    this._registrations = [];
  }

  /** @returns {number} */
  get count() {
    return this._registrations.length;
  }

  /**
   * Register or refresh a relay for `(subscriber, channel)`. `channelHash` is
   * `null` for LXMF propagation; a 16-byte hash for a specific channel.
   *
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array|null} channelHash
   * @param {string} relayHash
   */
  register(subscriberHash, channelHash, relayHash) {
    const existing = this._registrations.find(
      (r) =>
        eq(r.subscriberHash, subscriberHash) &&
        eqOrNull(r.channelHash, channelHash) &&
        r.relayHash === relayHash,
    );
    if (existing) {
      existing.registered = Date.now() / 1000;
    } else {
      this._registrations.push({
        subscriberHash: new Uint8Array(subscriberHash),
        channelHash: channelHash ? new Uint8Array(channelHash) : null,
        relayHash,
        registered: Date.now() / 1000,
      });
    }
  }

  /**
   * Remove a specific `(subscriber, channel, relay)` registration.
   *
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array|null} channelHash
   * @param {string} relayHash
   */
  unregister(subscriberHash, channelHash, relayHash) {
    this._registrations = this._registrations.filter(
      (r) =>
        !(
          eq(r.subscriberHash, subscriberHash) &&
          eqOrNull(r.channelHash, channelHash) &&
          r.relayHash === relayHash
        ),
    );
  }

  /**
   * Remove ALL registrations for a subscriber (every channel + LXMF).
   *
   * @param {Uint8Array} subscriberHash
   */
  clear(subscriberHash) {
    this._registrations = this._registrations.filter(
      (r) => !eq(r.subscriberHash, subscriberHash),
    );
  }

  /**
   * All registrations for `(subscriber, channel)`. `channelHash === null`
   * matches LXMF/global registrations; pass a 16-byte hash for a channel.
   *
   * @param {Uint8Array} subscriberHash
   * @param {Uint8Array|null} channelHash
   * @returns {NotifyRegistration[]}
   */
  getForSubscriber(subscriberHash, channelHash) {
    return this._registrations.filter(
      (r) =>
        eq(r.subscriberHash, subscriberHash) &&
        eqOrNull(r.channelHash, channelHash),
    );
  }

  /**
   * Exports all registrations as serializable records. Used by the
   * `@reticulum/node` FS adapter (Rust `~/.rfed/notify_registrations.rmp`).
   *
   * @returns {Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array|null, relayHash: string, registered: number }>}
   */
  exportRecords() {
    return this._registrations.map((r) => ({
      subscriberHash: new Uint8Array(r.subscriberHash),
      channelHash: r.channelHash ? new Uint8Array(r.channelHash) : null,
      relayHash: r.relayHash,
      registered: r.registered,
    }));
  }

  /**
   * Replaces the registry with the given records (direct population, used on
   * load).
   *
   * @param {Array<{ subscriberHash: Uint8Array, channelHash: Uint8Array|null, relayHash: string, registered: number }>} records
   */
  importRecords(records) {
    this._registrations = records.map((r) => ({
      subscriberHash: new Uint8Array(r.subscriberHash),
      channelHash: r.channelHash ? new Uint8Array(r.channelHash) : null,
      relayHash: r.relayHash,
      registered: r.registered,
    }));
  }
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Equality treating two `null` channel hashes as equal (both = LXMF/global).
 * @param {Uint8Array|null} a
 * @param {Uint8Array|null} b
 */
function eqOrNull(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return eq(a, b);
}

export { fromHex };
