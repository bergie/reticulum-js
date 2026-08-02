/**
 * @file channel.js
 * @description Deterministic rfed channel derivation.
 *
 * A channel is a deterministic Reticulum {@link Identity} derived from a
 * plain-text channel name. Any party that knows the name independently arrives
 * at the same {@link Identity.identityHash} ("channel hash") and keypair, so
 * senders can encrypt to the channel and subscribers can decrypt — with no
 * server-side registration.
 *
 * Algorithm (`RFed/SPEC.md` §1):
 * ```
 * seed          = SHA-256(channel_name)                 → 32 bytes
 * x25519_priv   = seed
 * ed25519_priv  = seed
 * x25519_pub    = X25519_public_key(seed)               → 32 bytes
 * ed25519_pub   = Ed25519_public_key(seed)              → 32 bytes
 * bundle        = x25519_pub ‖ ed25519_pub              → 64 bytes
 * channel_hash  = SHA-256(bundle)[0..16]                → 16 bytes
 * ```
 *
 * Matches the Rust `make_channel_identity` / `ChannelKeypair::from_name` and
 * the Python `channel_hash.compute_channel_hash` reference vectors.
 */

import { Identity } from "../core/identity.js";
import {
  importEd25519PublicKey,
  importRawEd25519PrivateKey,
  importRawX25519PrivateKey,
  importX25519PublicKey,
} from "../crypto/keys.js";
import { base64UrlToBytes, concatBytes } from "../utils/encoding.js";
import { LXMF_DELIVERY_NAME } from "./constants.js";

/**
 * The RFC 7748 X25519 base-point u-coordinate (`9`). Used to derive a public
 * key from a private scalar — Web Crypto exposes no "derive public from
 * private" primitive for X25519, so we do the scalar multiplication ourselves
 * by ECDH against the public base point.
 */
const X25519_BASEPOINT = (() => {
  const b = new Uint8Array(32);
  b[0] = 9;
  return b;
})();

/**
 * Derives the 32-byte X25519 public key from a 32-byte private seed.
 *
 * Uses the standard X25519 base-point multiplication: `X25519(seed, 9)` yields
 * exactly the public key that `X25519PrivateKey.from_private_bytes(seed)`
 * produces in the Rust/Python references.
 *
 * @param {Uint8Array} seed - 32-byte private scalar.
 * @returns {Promise<Uint8Array>} 32-byte public key.
 */
async function x25519PublicFromSeed(seed) {
  const basepointKey = await importX25519PublicKey(X25519_BASEPOINT);
  const privKey = await importRawX25519PrivateKey(seed);
  const bits = await crypto.subtle.deriveBits(
    { name: "X25519", public: basepointKey },
    /** @type {any} */ (privKey),
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Derives the 32-byte Ed25519 public key from a 32-byte private seed.
 *
 * Web Crypto populates the public `x` coordinate in the JWK export of an
 * imported OKP private key (RFC 8037 §2), so we round-trip the raw seed
 * through a PKCS#8-wrapped private key and read `x` back.
 *
 * @param {Uint8Array} seed - 32-byte Ed25519 seed.
 * @returns {Promise<Uint8Array>} 32-byte public key.
 */
async function ed25519PublicFromSeed(seed) {
  const privKey = await importRawEd25519PrivateKey(seed);
  const jwk = await crypto.subtle.exportKey("jwk", privKey);
  if (!jwk.x) {
    throw new Error(
      "Ed25519 public key derivation failed: JWK export omitted 'x' (unsupported runtime)",
    );
  }
  return base64UrlToBytes(jwk.x);
}

/**
 * Derives a channel's deterministic {@link Identity} and 16-byte channel hash
 * from its plain-text name.
 *
 * The channel's private key bundle is `seed ‖ seed` (the same 32-byte
 * `SHA-256(name)` scalar used for both X25519 and Ed25519), matching the Rust
 * reference's `private_key_bundle = seed || seed` convention.
 *
 * @param {string} name - Dot-separated channel name (e.g. `"public.news.tech"`
 *   or a `<hex>.<segments>` private channel).
 * @returns {Promise<{ identity: Identity, channelHash: Uint8Array }>}
 *   `identity` is a full Reticulum Identity (holds both private keys, so it can
 *   encrypt, decrypt, and derive its `lxmf.delivery` hash); `channelHash` is
 *   the 16-byte channel identity hash used as the rfed routing label.
 */
export async function deriveChannel(name) {
  const nameBytes = new TextEncoder().encode(name);
  const seedBuffer = await crypto.subtle.digest(
    "SHA-256",
    /** @type {any} */ (nameBytes),
  );
  const seed = new Uint8Array(seedBuffer); // 32 bytes

  // Both private keys are the channel seed — `seed ‖ seed`.
  const x25519Priv = await importRawX25519PrivateKey(seed);
  const ed25519Priv = await importRawEd25519PrivateKey(seed);
  const x25519PubBytes = await x25519PublicFromSeed(seed);
  const ed25519PubBytes = await ed25519PublicFromSeed(seed);

  const x25519Pub = await importX25519PublicKey(x25519PubBytes);
  const ed25519Pub = await importEd25519PublicKey(ed25519PubBytes);

  const publicKey = concatBytes(x25519PubBytes, ed25519PubBytes);
  const channelHash = await Identity.truncatedHash(publicKey);

  const identity = new Identity(
    x25519Priv,
    ed25519Priv,
    x25519Pub,
    ed25519Pub,
    publicKey,
    channelHash,
  );

  return { identity, channelHash };
}

/**
 * Computes the `lxmf.delivery` destination hash for an Identity — the 16-byte
 * truncated `SHA-256(name_hash("lxmf.delivery") ‖ identity_hash)`.
 *
 * For a channel message this is the LXMF `destination_hash` the sender signs
 * over (the channel's delivery address), **not** the bare channel identity
 * hash. Confusing the two is the classic rfed bug — see `RFed/SPEC.md`
 * "CANONICAL WIRE FORMAT" invariants.
 *
 * @param {Identity} identity
 * @returns {Promise<Uint8Array>} 16-byte `lxmf.delivery` destination hash.
 */
export async function deliveryHashFor(identity) {
  const nameBytes = new TextEncoder().encode(LXMF_DELIVERY_NAME);
  const nameHashBuffer = await crypto.subtle.digest(
    "SHA-256",
    /** @type {any} */ (nameBytes),
  );
  const nameHash = new Uint8Array(nameHashBuffer).slice(0, 10);
  const combined = concatBytes(nameHash, identity.identityHash);
  const fullBuffer = await crypto.subtle.digest(
    "SHA-256",
    /** @type {any} */ (combined),
  );
  return new Uint8Array(fullBuffer).slice(0, 16);
}

/**
 * Joins channel-name segments with `.` to form a channel name, mirroring
 * Reticulum's aspect notation.
 *
 * @param {...string} segments
 * @returns {string}
 */
export function channelPath(...segments) {
  return segments.join(".");
}
