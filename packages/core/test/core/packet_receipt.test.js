/**
 * Tests for `PacketReceipt` regular-PROOF validation (SPEC.md §6.5).
 *
 * A receipt tracks a 32-byte packet hash and the destination the proved packet
 * was sent to; `validateProof` dispatches purely on body length (96 B explicit
 * / 64 B implicit) and verifies the Ed25519 signature over the packet hash
 * with the destination's recalled identity.
 */
import assert from "node:assert";
import test from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { PacketReceipt, ReceiptStatus } from "../../src/core/packet_receipt.js";
import { TransportCore } from "../../src/transport/transport.js";

/**
 * Generates a recipient identity, derives its `lxmf.delivery`-style destination
 * hash, and registers it on the transport so `PacketReceipt.validateProof` can
 * recall the verifying identity by destination hash (work doc #37: the
 * identity cache is instance-scoped).
 *
 * @returns {Promise<{ identity: Identity, destinationHash: Uint8Array, transport: TransportCore }>}
 */
async function setupRecipient() {
  const transport = new TransportCore();
  const identity = await Identity.generate();
  const dest = await Destination.SINGLE("proof.app", Direction.IN, identity);
  await transport.rememberIdentity(
    crypto.getRandomValues(new Uint8Array(32)),
    /** @type {Uint8Array} */ (dest.destinationHash),
    identity.publicKey,
  );
  return {
    identity,
    transport,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
  };
}

/**
 * Builds a receipt owned by `transport` (owner-set, so proof validation can
 * recall identities from the transport's cache).
 *
 * @param {TransportCore} transport
 * @param {Uint8Array} packetHash
 * @param {Uint8Array} destinationHash
 * @returns {PacketReceipt}
 */
function trackedReceipt(transport, packetHash, destinationHash) {
  const receipt = new PacketReceipt(packetHash, destinationHash);
  transport.trackReceipt(receipt);
  return receipt;
}

test("PacketReceipt.validateProof accepts the explicit (96-byte) form", async () => {
  const { identity, destinationHash, transport } = await setupRecipient();
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const signature = await identity.sign(packetHash);

  const explicit = new Uint8Array(96);
  explicit.set(packetHash, 0);
  explicit.set(signature, 32);

  const receipt = trackedReceipt(transport, packetHash, destinationHash);
  assert.ok(await receipt.validateProof(explicit));
});

test("PacketReceipt.validateProof accepts the implicit (64-byte) form", async () => {
  const { identity, destinationHash, transport } = await setupRecipient();
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const signature = await identity.sign(packetHash);

  const receipt = trackedReceipt(transport, packetHash, destinationHash);
  assert.ok(await receipt.validateProof(signature));
});

test("PacketReceipt.validateProof rejects a wrong-length body", async () => {
  const { destinationHash } = await setupRecipient();
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const receipt = new PacketReceipt(packetHash, destinationHash);
  assert.strictEqual(await receipt.validateProof(new Uint8Array(50)), false);
  assert.strictEqual(await receipt.validateProof(new Uint8Array(100)), false);
});

test("PacketReceipt.validateProof rejects a tampered signature", async () => {
  const { identity, destinationHash, transport } = await setupRecipient();
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const signature = await identity.sign(packetHash);
  signature[10] ^= 0xff;

  const receipt = trackedReceipt(transport, packetHash, destinationHash);
  assert.strictEqual(await receipt.validateProof(signature), false);
});

test("PacketReceipt.validateProof rejects an explicit proof with a mismatched packet_hash", async () => {
  const { identity, destinationHash, transport } = await setupRecipient();
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const signature = await identity.sign(packetHash);
  // Valid signature over the real packet_hash, but the embedded hash is bogus.
  const bogusHash = crypto.getRandomValues(new Uint8Array(32));
  const explicit = new Uint8Array(96);
  explicit.set(bogusHash, 0);
  explicit.set(signature, 32);

  const receipt = trackedReceipt(transport, packetHash, destinationHash);
  assert.strictEqual(await receipt.validateProof(explicit), false);
});

test("PacketReceipt.validateProof fails when the destination identity is unknown", async () => {
  const transport = new TransportCore();
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const unknownDest = crypto.getRandomValues(new Uint8Array(16));
  const receipt = trackedReceipt(transport, packetHash, unknownDest);
  // Random 64-byte blob is not a valid signature for any known identity.
  const bogusSignature = crypto.getRandomValues(new Uint8Array(64));
  assert.strictEqual(await receipt.validateProof(bogusSignature), false);
});

test("TransportCore.trackReceipt / findReceipt / setDelivered round-trip via the registry", async () => {
  const { identity, destinationHash, transport } = await setupRecipient();
  const packetHash = crypto.getRandomValues(new Uint8Array(32));
  const signature = await identity.sign(packetHash);

  /** @type {PacketReceipt|null} */
  let delivered = null;
  const receipt = new PacketReceipt(packetHash, destinationHash, {
    delivered: (r) => {
      delivered = r;
    },
  });
  transport.trackReceipt(receipt);

  // An inbound PROOF is addressed to the 16-byte truncation of the packet hash.
  const found = transport.findReceipt(packetHash.slice(0, 16));
  assert.strictEqual(found, receipt);

  assert.ok(await receipt.validateProof(signature));
  receipt.setDelivered();
  assert.strictEqual(receipt.status, ReceiptStatus.DELIVERED);
  assert.strictEqual(delivered, receipt);

  // setDelivered removes the receipt from the registry and is idempotent.
  assert.strictEqual(transport.findReceipt(packetHash.slice(0, 16)), null);
  receipt.setDelivered(); // must not throw or double-fire the callback.
});
