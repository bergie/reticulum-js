/**
 * @file constants.js
 * @description rfed (Reticulum Federation) wire-format constants.
 *
 * Mirrors the canonical wire format described in `RFed/SPEC.md` ("CANONICAL
 * WIRE FORMAT — ULTIMATE AUTHORITY"). These values are protocol-invariant: any
 * change silently breaks interoperability with the Rust `rfed` reference.
 */

/**
 * The 4-byte ASCII magic that prefixes the RTID source-identity prelude inside
 * the channel EC envelope. Not length-prefixed, not little-endian — just the
 * four bytes `"RTID"`.
 */
export const MAGIC_RTID = new Uint8Array([0x52, 0x54, 0x49, 0x44]); // "RTID"

/** Length of the RTID magic prelude. */
export const MAGIC_LENGTH = 4;

/** Length of an Identity public key bundle (X25519 ‖ Ed25519). */
export const PUBLIC_KEY_LENGTH = 64;

/** Length of a 16-byte channel/destination hash (`TRUNCATED_HASHLENGTH / 8`). */
export const HASH_LENGTH = 16;

/**
 * Proof-of-work stamp expansion rounds for rfed channel messages.
 *
 * This is **16**, deliberately different from LXMF propagation-node stamps
 * (1000) and regular message stamps (3000). Bumping it silently invalidates
 * every cached `stamp_cost` and every in-flight stamp, so it must never be
 * changed without a protocol-version bump.
 */
export const STAMP_EXPAND_ROUNDS = 16;

/** Size in bytes of an LXMF proof-of-work stamp (`HASHLENGTH//8` = 32). */
export const STAMP_SIZE = 32;

/** LXMF application + aspect name for a `delivery` destination. */
export const LXMF_DELIVERY_NAME = "lxmf.delivery";
