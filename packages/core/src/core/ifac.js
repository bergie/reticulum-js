/**
 * @file ifac.js
 * @description Interface Authentication Code (IFAC) derivation, sealing and
 *   verification.
 *
 * IFAC authenticates and lightly obfuscates every packet on an interface that
 * shares an out-of-band secret (a network name and/or passphrase). Both
 * endpoints derive the same {@link deriveIfac IFAC identity} from those shared
 * secrets; the sender signs each packet (the last `ifacSize` bytes of the
 * Ed25519 signature is the IFAC), sets the header's `ifac_flag`, inserts the
 * IFAC between byte 2 and the addresses, and XOR-masks the rest with an
 * HKDF keystream. The receiver reverses it and silently drops packets that
 * fail verification.
 *
 * Mirrors the Python reference `RNS/Transport.py::transmit`/`inbound` and the
 * per-interface setup in `RNS/Reticulum.py` (and `AutoInterface`/`Backbone`
 * spawn). These functions operate on **raw wire bytes** — they are deliberately
 * decoupled from {@link import("../core/packet.js").Packet} so the transport
 * layer can call them immediately before framing (transmit) and immediately
 * after unframing (inbound), matching upstream where `Transport.transmit`/
 * `Transport.inbound` run on already-serialised bytes.
 */

/* @ts-self-types="../../types/src/core/ifac.d.ts" */

import { hkdf } from "../crypto/ciphers.js";
import { bytesEqual, concatBytes } from "../utils/encoding.js";
import { Identity } from "./identity.js";

/**
 * Minimum IFAC size in bytes (`RNS.Reticulum.IFAC_MIN_SIZE`). Re-exported as a
 * `Reticulum` static for upstream parity.
 */
export const IFAC_MIN_SIZE = 1;

/**
 * The fixed IFAC salt (`RNS.Reticulum.IFAC_SALT`), shared by every node so the
 * same network name / passphrase derives the same key everywhere.
 */
export const IFAC_SALT = new Uint8Array([
  0xad, 0xf5, 0x4d, 0x88, 0x2c, 0x9a, 0x9b, 0x80, 0x77, 0x1e, 0xb4, 0x99, 0x5d,
  0x70, 0x2d, 0x4a, 0x3e, 0x73, 0x33, 0x91, 0xb2, 0xa0, 0xf5, 0x3f, 0x41, 0x6d,
  0x9f, 0x90, 0x7e, 0x55, 0xcf, 0xf8,
]);

/**
 * @typedef {Object} IfacMaterial
 * @property {Uint8Array} ifacKey - 64-byte HKDF-derived IFAC key.
 * @property {import("./identity.js").Identity} ifacIdentity - Identity loaded
 *   from {@link ifacKey} via {@link Identity.fromPrivateKey}; only its Ed25519
 *   signing ability is used.
 * @property {Uint8Array} ifacSignature - 64-byte Ed25519 signature of
 *   `fullHash(ifacKey)`, published in the discovery announce so peers can
 *   recognise a matching key without revealing it.
 */

/**
 * Derives the IFAC key, identity and signature from a shared network name
 * and/or passphrase.
 *
 * Reproduces `RNS/Reticulum.py` interface setup (~l.975) and the per-peer
 * re-derivation in `AutoInterface`/`Backbone` spawn: either secret may be
 * omitted, but at least one must be provided.
 *
 *   origin       = fullHash(netname?) || fullHash(netkey?)
 *   originHash   = fullHash(origin)
 *   ifacKey      = HKDF(deriveFrom=originHash, salt=IFAC_SALT, info="", L=64)
 *   ifacIdentity = Identity.fromPrivateKey(ifacKey)
 *   ifacSignature= ifacIdentity.sign(fullHash(ifacKey))
 *
 * @param {string|null|undefined} netname The interface `network_name`
 *   (`ifac_netname`). May be null/empty.
 * @param {string|null|undefined} netkey The interface `passphrase`
 *   (`ifac_netkey`). May be null/empty.
 * @returns {Promise<IfacMaterial|null>} The derived material, or `null` when
 *   neither secret is provided (IFAC disabled).
 */
export async function deriveIfac(netname, netkey) {
  const encoder = new TextEncoder();
  /** @type {Uint8Array[]} */
  const parts = [];
  if (netname) parts.push(await Identity.fullHash(encoder.encode(netname)));
  if (netkey) parts.push(await Identity.fullHash(encoder.encode(netkey)));
  if (parts.length === 0) return null;

  const origin = concatBytes(...parts);
  const originHash = await Identity.fullHash(origin);
  const ifacKey = await hkdf(originHash, IFAC_SALT, new Uint8Array(), 64);
  const ifacIdentity = /** @type {Identity} */ (
    await Identity.fromPrivateKey(ifacKey)
  );
  const ifacSignature = await ifacIdentity.sign(
    await Identity.fullHash(ifacKey),
  );
  return { ifacKey, ifacIdentity, ifacSignature };
}

/**
 * @typedef {Object} IfacConfig
 * @property {Identity} ifacIdentity
 * @property {Uint8Array} ifacKey
 * @property {number} ifacSize - IFAC field length in bytes
 *   (`>= IFAC_MIN_SIZE`, `<= 64`).
 */

/**
 * Seals a raw (un-IFACed) packet for an authenticated interface
 * (`RNS/Transport.py::transmit`, ~l.1066).
 *
 * The input **must** be an unsealed packet — i.e. header byte 0 has the
 * `ifac_flag` (bit 7) clear, which is the normal state of a freshly
 * serialised packet. The output has the flag set, the `ifacSize`-byte IFAC
 * inserted between the hops byte and the addresses, and every non-IFAC byte
 * XOR-masked with an HKDF keystream derived from the IFAC itself.
 * @param {Uint8Array} raw Unsealed wire bytes (header bit 7 clear).
 * @param {IfacConfig} cfg
 * @returns {Promise<Uint8Array>} The sealed wire bytes.
 */
export async function seal(raw, cfg) {
  const { ifacIdentity, ifacKey, ifacSize } = cfg;
  const fullSig = await ifacIdentity.sign(raw);
  const ifac = fullSig.subarray(fullSig.length - ifacSize);

  const mask = await hkdf(
    ifac,
    ifacKey,
    new Uint8Array(),
    raw.length + ifacSize,
  );

  // new_raw = [raw[0] | 0x80, raw[1], ifac..., raw[2:]]
  const newRaw = new Uint8Array(raw.length + ifacSize);
  newRaw[0] = raw[0] | 0x80;
  newRaw[1] = raw[1];
  newRaw.set(ifac, 2);
  newRaw.set(raw.subarray(2), 2 + ifacSize);

  const masked = new Uint8Array(newRaw.length);
  for (let i = 0; i < newRaw.length; i++) {
    if (i === 0) {
      // Mask first header byte but keep the IFAC flag set.
      masked[i] = (newRaw[i] ^ mask[i]) | 0x80;
    } else if (i === 1 || i > ifacSize + 1) {
      masked[i] = newRaw[i] ^ mask[i];
    } else {
      masked[i] = newRaw[i]; // the IFAC field itself is never masked.
    }
  }
  return masked;
}

/**
 * Verifies and unseals an IFAC-sealed packet (`RNS/Transport.py::inbound`,
 * ~l.1438).
 *
 * Reverses {@link seal}: extracts the IFAC, regenerates the mask, unmasks,
 * clears the flag, strips the IFAC, re-signs the result and compares the last
 * `ifacSize` bytes. IFAC verification works by **re-signing** with the local
 * identity (both sides derived the same key) rather than public-key
 * verification, so only the Ed25519 private key is exercised.
 * @param {Uint8Array} raw Sealed wire bytes (header bit 7 set).
 * @param {IfacConfig} cfg
 * @returns {Promise<Uint8Array|null>} The unsealed wire bytes, or `null` if the
 *   packet is too short or the IFAC does not verify (drop silently).
 */
export async function open(raw, cfg) {
  const { ifacIdentity, ifacKey, ifacSize } = cfg;
  if (raw.length <= 2 + ifacSize) return null;

  const ifac = raw.subarray(2, 2 + ifacSize);
  const mask = await hkdf(ifac, ifacKey, new Uint8Array(), raw.length);

  const unmasked = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (i <= 1 || i > ifacSize + 1) {
      unmasked[i] = raw[i] ^ mask[i];
    } else {
      unmasked[i] = raw[i]; // the IFAC field itself was never masked.
    }
  }

  // new_raw = [unmasked[0] & 0x7f, unmasked[1], unmasked[2+ifacSize:]]
  const newRaw = new Uint8Array(raw.length - ifacSize);
  newRaw[0] = unmasked[0] & 0x7f;
  newRaw[1] = unmasked[1];
  newRaw.set(unmasked.subarray(2 + ifacSize), 2);

  const expectedFull = await ifacIdentity.sign(newRaw);
  const expected = expectedFull.subarray(expectedFull.length - ifacSize);
  return bytesEqual(ifac, expected) ? newRaw : null;
}

/**
 * Whether a raw packet carries the IFAC flag (header byte 0, bit 7). Used by
 * the transport inbound path to enforce the flag-presence rules: an IFAC
 * interface must drop a flag-clear packet, and a plain interface must drop a
 * flag-set packet.
 * @param {Uint8Array} raw
 * @returns {boolean}
 */
export function hasIfacFlag(raw) {
  return raw.length > 0 && (raw[0] & 0x80) !== 0;
}
