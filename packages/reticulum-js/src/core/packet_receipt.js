/**
 * @file packet_receipt.js
 * @description Regular `PROOF` packet receipts (SPEC.md §6.5).
 *
 * A `PacketReceipt` tracks an outbound CTX_NONE DATA packet awaiting the
 * receiver's `PROOF` reply. When the PROOF arrives (addressed to the 16-byte
 * truncation of the packet hash), {@link PacketReceipt.validateProof}
 * dispatches purely on body length:
 *
 *   explicit (96 B) = packet_hash(32) || signature(64)
 *   implicit (64 B) = signature(64)
 *
 * The signature is an Ed25519 signature **over the 32-byte packet hash**
 * (`SHA-256(get_hashable_part(original_packet))`), verified with the
 * recipient destination's recalled identity. Link DATA proofs (always
 * explicit) and LRPROOFs are separate paths not handled here.
 */

import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { Destination } from "./destination.js";
import { Identity } from "./identity.js";

/**
 * Packet-receipt lifecycle states.
 * @enum {number}
 */
export const ReceiptStatus = {
  /** Sent, awaiting the receiver's PROOF. */
  SENDING: 0,
  /** PROOF received and validated — delivery confirmed. */
  DELIVERED: 1,
  /** Timed out or PROOF failed validation. */
  FAILED: 2,
  /** Evicted from the registry (e.g. after resolution or culling). */
  CULLED: 3,
};

/** Proof-body lengths (§6.5.1): `HASHLENGTH//8 + SIGLENGTH//8` and `SIGLENGTH//8`. */
const PROOF_EXPLICIT_LENGTH = 96;
const PROOF_IMPLICIT_LENGTH = 64;

/**
 * Tracks a single outbound packet's delivery receipt.
 */
export class PacketReceipt {
  /**
   * Outstanding receipts, keyed by the hex of the 16-byte truncated packet
   * hash — the synthetic `dest_hash` an inbound PROOF is addressed to.
   *
   * @type {Map<string, PacketReceipt>}
   */
  static receipts = new Map();

  /**
   * @param {Uint8Array} packetHash - 32-byte `SHA-256(get_hashable_part(packet))`.
   * @param {Uint8Array} destinationHash - 16-byte destination the proved packet was sent to;
   *   used to recall the verifying identity.
   * @param {Object} [callbacks]
   * @param {function(PacketReceipt): void|Promise<void>} [callbacks.delivered]
   *   Fired once when the PROOF validates.
   * @param {function(PacketReceipt): void|Promise<void>} [callbacks.failed]
   *   Fired once if the PROOF fails validation.
   */
  constructor(packetHash, destinationHash, callbacks = {}) {
    /** @type {Uint8Array} */
    this.packetHash = packetHash;
    /** @type {Uint8Array} */
    this.truncatedHash = packetHash.slice(0, 16);
    /** @type {Uint8Array} */
    this.destinationHash = destinationHash;
    this.callbacks = callbacks;
    /** @type {ReceiptStatus} */
    this.status = ReceiptStatus.SENDING;
    this.sentAt = Date.now();
  }

  /**
   * Registers a receipt so an inbound PROOF (whose `dest_hash` equals the
   * truncated packet hash) can find it via {@link PacketReceipt.find}.
   *
   * @param {PacketReceipt} receipt
   */
  static track(receipt) {
    PacketReceipt.receipts.set(toHex(receipt.truncatedHash), receipt);
  }

  /**
   * Looks up an outstanding receipt by the 16-byte `dest_hash` of an inbound
   * PROOF packet.
   *
   * @param {Uint8Array} proofDestHash
   * @returns {PacketReceipt|null}
   */
  static find(proofDestHash) {
    return PacketReceipt.receipts.get(toHex(proofDestHash)) ?? null;
  }

  /**
   * Validates an inbound proof body (§6.5.1 / §6.5.5), dispatching purely on
   * length. The verifying identity is recalled by {@link destinationHash} —
   * the destination the original packet was addressed to — so receipt
   * creation never needs to thread the recipient identity through.
   *
   * @param {Uint8Array} proofData
   * @returns {Promise<boolean>} `true` if the signature verifies over the
   *   packet hash (and, for explicit proofs, the embedded hash matches).
   */
  async validateProof(proofData) {
    if (proofData.length === PROOF_EXPLICIT_LENGTH) {
      const packetHash = proofData.slice(0, 32);
      const signature = proofData.slice(32, 96);
      if (!bytesEqual(packetHash, this.packetHash)) {
        log(
          "PacketReceipt",
          "explicit proof packet_hash does not match the tracked receipt",
          LogLevel.DEBUG,
        );
        return false;
      }
      return this._verify(signature, this.packetHash);
    }
    if (proofData.length === PROOF_IMPLICIT_LENGTH) {
      return this._verify(proofData, this.packetHash);
    }
    log(
      "PacketReceipt",
      `proof length ${proofData.length} matches neither 64 (implicit) nor 96 (explicit)`,
      LogLevel.DEBUG,
    );
    return false;
  }

  /**
   * Recalls the recipient identity and verifies an Ed25519 signature over `data`.
   *
   * @param {Uint8Array} signature
   * @param {Uint8Array} data
   * @returns {Promise<boolean>}
   * @private
   */
  async _verify(signature, data) {
    const identity = await Destination.recall(this.destinationHash);
    if (!identity) {
      log(
        "PacketReceipt",
        `no identity recalled for destination ${toHex(this.destinationHash)}; cannot verify proof`,
        LogLevel.DEBUG,
      );
      return false;
    }
    return identity.validate(signature, data);
  }

  /**
   * Marks the receipt delivered, removes it from the registry, and fires the
   * `delivered` callback once. Idempotent.
   */
  setDelivered() {
    if (this.status === ReceiptStatus.DELIVERED) return;
    this.status = ReceiptStatus.DELIVERED;
    PacketReceipt.receipts.delete(toHex(this.truncatedHash));
    if (this.callbacks.delivered) {
      try {
        this.callbacks.delivered(this);
      } catch (err) {
        log(
          "PacketReceipt",
          `delivered callback threw: ${err}`,
          LogLevel.ERROR,
        );
      }
    }
  }

  /**
   * Marks the receipt failed and fires the `failed` callback once. Does not
   * remove from the registry (the caller decides whether to retry or cull).
   */
  setFailed() {
    if (this.status === ReceiptStatus.FAILED) return;
    this.status = ReceiptStatus.FAILED;
    if (this.callbacks.failed) {
      try {
        this.callbacks.failed(this);
      } catch (err) {
        log("PacketReceipt", `failed callback threw: ${err}`, LogLevel.ERROR);
      }
    }
  }
}

// Re-exported so callers can reference the proving identity type without a
// separate import line; kept here to avoid a circular type-only cycle.
export { Identity };
