/**
 * @module @reticulum/core/src/transport/identity-cache.js
 * @description Instance-scoped identity, ratchet and receipt caches (work doc #37).
 *
 * Historically these three caches were **class-level statics**
 * (`Destination.knownDestinations`, `Destination.knownRatchets`,
 * `PacketReceipt.receipts`). That made them process-global singletons, which
 * breaks in a real-world failure mode: Node dedupes ES modules by *resolved
 * file path*, so an install tree with two physical copies of
 * `@reticulum/core` (a stale hoisted copy plus npm-nested copies, which npm
 * produces whenever a hoisted version stops satisfying a semver range) runs
 * two module instances with two divergent caches — the transport ingests
 * announces into one copy while a dependent package reads a forever-empty
 * cache from the other ("split-brain"; see work doc #37 for the production
 * outage this caused).
 *
 * The fix is instance scoping: a `TransportCore` owns its caches, dependents
 * reach them through the `Reticulum` instance they already hold
 * (`rns.transport.recallIdentity(…)`), and module duplication becomes
 * harmless — two copies of an ESM class with no class-level mutable state
 * share everything through the instance. The former class statics are gone;
 * each `IdentityCache` owns fresh maps by default, so two `Reticulum`
 * instances in one process are fully isolated unless they deliberately
 * share a cache.
 *
 * The per-copy module token ({@link CORE_INSTANCE_TOKEN}) enables the
 * companion self-check: each physical copy of the package gets its own
 * token value, so a dependent package holding a `Reticulum` instance can
 * compare its own token against the instance's and warn loudly on a
 * mismatch — catching a fragmented install at first boot instead of
 * through field debugging.
 */

/* @ts-self-types="../../types/src/transport/identity-cache.d.ts" */

import { LogLevel, log } from "../utils/log.js";

/**
 * Marker identifying the physical copy of `@reticulum/core` that evaluated
 * this module. A fresh object per module instance (Node dedupes ES modules
 * by resolved file path, so two physical copies evaluate this module twice
 * and get distinct tokens). Dependent packages compare the token they were
 * bundled with against a `Reticulum` instance's token
 * ({@link Reticulum#coreInstanceToken}); a mismatch means two module copies
 * share the process — see {@link warnIfFragmented}.
 *
 * @type {object}
 */
export const CORE_INSTANCE_TOKEN = {};

/**
 * The caches owned by one `TransportCore` instance. Constructed with the
 * legacy static maps by default (see the module description); pass explicit
 * maps for hard isolation.
 */
export class IdentityCache {
  /**
   * @param {Object} [options]
   * @param {Map<string, import("../core/destination.js").KnownDestination>} [options.knownDestinations]
   *   Defaults to a fresh map.
   * @param {Map<string, {ratchet: Uint8Array, received: number}>} [options.knownRatchets]
   *   Defaults to a fresh map.
   * @param {Map<string, import("../core/packet_receipt.js").PacketReceipt>} [options.receipts]
   *   Defaults to a fresh map.
   * @param {object} [options.instanceToken] Identity token of the module
   *   copy that created this cache; defaults to {@link CORE_INSTANCE_TOKEN}
   *   of this copy.
   */
  constructor({
    knownDestinations,
    knownRatchets,
    receipts,
    instanceToken,
  } = {}) {
    /**
     * Learned peer identities keyed by hex destination hash.
     * @type {Map<string, import("../core/destination.js").KnownDestination>}
     */
    this.knownDestinations = knownDestinations ?? new Map();
    /**
     * Newest announced ratchet public key per destination, keyed by hex.
     * @type {Map<string, {ratchet: Uint8Array, received: number}>}
     */
    this.knownRatchets = knownRatchets ?? new Map();
    /**
     * Outstanding proof receipts keyed by hex truncated packet hash.
     * @type {Map<string, import("../core/packet_receipt.js").PacketReceipt>}
     */
    this.receipts = receipts ?? new Map();
    /**
     * Module-instance identity of the copy that built this cache. Used by
     * {@link warnIfFragmented} to detect a fragmented install.
     * @type {object}
     */
    this.instanceToken = instanceToken ?? CORE_INSTANCE_TOKEN;
  }
}

/** @type {Set<object>|null} Token pairs already warned about (dedup). @private */
let _warnedPairs = null;

/**
 * Warns (once per token pair) when the module copy a dependent package was
 * bundled with differs from the copy that created a `Reticulum` instance —
 * i.e. the install tree contains two physical copies of `@reticulum/core`
 * (the npm nesting / stale-hoist layout). With the instance-scoped caches
 * this is *not* fatal anymore (state converges through the shared
 * instance), but it still means duplicate protocol code in the process and
 * divergent class identity (`instanceof` across copies fails), so it
 * deserves a loud warning.
 *
 * Dependent packages pass their own copy's {@link CORE_INSTANCE_TOKEN}
 * import and the instance's token (e.g. `rns.coreInstanceToken`).
 *
 * @param {string} packageName Name of the dependent package, for the log
 *   message (e.g. `"@reticulum/lxmf"`).
 * @param {object} dependentToken The dependent's `CORE_INSTANCE_TOKEN` import.
 * @param {object} coreToken The `Reticulum` instance's core token.
 * @returns {boolean} `true` when the install is fragmented (a warning was
 *   emitted), `false` when both sides come from the same module copy.
 */
export function warnIfFragmented(packageName, dependentToken, coreToken) {
  // A missing core token means a hand-rolled Reticulum double (tests) or a
  // pre-#37 instance — stay silent rather than cry wolf.
  if (!coreToken || dependentToken === coreToken) return false;
  _warnedPairs ??= new Set();
  const key = coreToken;
  if (_warnedPairs.has(key)) return true;
  _warnedPairs.add(key);
  log(
    packageName,
    `This package and the provided Reticulum instance come from two physical ` +
      `copies of @reticulum/core (split-brain install layout — e.g. a stale ` +
      `hoisted copy blocking npm dedupe). Shared state is safe (it travels ` +
      `through the Reticulum instance), but the process runs duplicate ` +
      `protocol code and cross-copy instanceof checks will fail. Reinstall ` +
      `with a clean tree to resolve.`,
    LogLevel.WARNING,
  );
  return true;
}
