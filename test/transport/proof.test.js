/**
 * Tests for the opportunistic DATA PROOF receipt flow (SPEC.md §6.5).
 *
 * Covers both the receiver side (Destination emits the PROOF after decrypting)
 * and the sender side (TransportCore tracks a PacketReceipt and resolves it
 * when the PROOF comes back). Link DATA proofs (always explicit, resolved on
 * the link) are out of scope here.
 */
import assert from "node:assert";
import test from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { PacketReceipt, ReceiptStatus } from "../../src/core/packet_receipt.js";
import { Reticulum } from "../../src/core/reticulum.js";
import { bytesEqual } from "../../src/utils/encoding.js";

/** Captures broadcast PROOF packets in place of a real interface layer. */
class CapturingLayer {
  /**
   * @param {boolean} useImplicitProof
   */
  constructor(useImplicitProof = true) {
    /** @type {Packet[]} */
    this.packets = [];
    this.useImplicitProof = useImplicitProof;
  }
  /** @param {Packet} pkt */
  broadcast(pkt) {
    this.packets.push(pkt);
  }
}

/**
 * Builds a DATA packet whose payload is encrypted to the destination's
 * identity, so `_handleData` decrypts it successfully and emits a PROOF.
 *
 * @param {import("../../src/core/destination.js").Destination} dest
 * @returns {Promise<Packet>}
 */
async function buildEncryptedDataPacket(dest) {
  const identity = /** @type {Identity} */ (dest.identity);
  const payload = await identity.encrypt(new Uint8Array([1, 2, 3]));
  const packet = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
    contextByte: ContextType.NONE,
    payload,
  });
  packet.raw = packet.serialize();
  return packet;
}

// ---------------------------------------------------------------------------
// Receiver side: Destination emits the PROOF (§6.5)
// ---------------------------------------------------------------------------

test("Destination emits an implicit (64-byte) PROOF by default after decrypting DATA", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer(true);
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );

  const dataPacket = await buildEncryptedDataPacket(dest);
  const dataHash = await dataPacket.getHash();

  await dest.receive(dataPacket);

  assert.strictEqual(layer.packets.length, 1, "one PROOF should be broadcast");
  const proof = layer.packets[0];
  assert.strictEqual(proof.packetType, PacketType.PROOF);
  assert.strictEqual(proof.contextByte, ContextType.NONE);
  assert.ok(
    bytesEqual(
      /** @type {Uint8Array} */ (proof.destinationHash),
      dataHash.slice(0, 16),
    ),
    "PROOF dest_hash must be the truncated packet hash",
  );
  assert.strictEqual(
    proof.payload.length,
    64,
    "implicit form is signature only",
  );
  assert.ok(
    await identity.validate(proof.payload, dataHash),
    "signature must verify over the packet hash",
  );
});

test("Destination emits an explicit (96-byte) PROOF when useImplicitProof is false", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer(false);
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );

  const dataPacket = await buildEncryptedDataPacket(dest);
  const dataHash = await dataPacket.getHash();

  await dest.receive(dataPacket);

  const proof = layer.packets[0];
  assert.strictEqual(proof.payload.length, 96);
  assert.ok(bytesEqual(proof.payload.slice(0, 32), dataHash));
  assert.ok(await identity.validate(proof.payload.slice(32, 96), dataHash));
});

test("Destination does not emit a PROOF for non-DATA / non-NONE packets", async () => {
  const identity = await Identity.generate();
  const layer = new CapturingLayer(true);
  const dest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    identity,
    /** @type {any} */ (layer),
  );
  // A DATA packet with a non-NONE context must not trigger an opportunistic proof.
  const payload = await identity.encrypt(new Uint8Array([9]));
  const packet = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
    contextByte: ContextType.RESOURCE,
    payload,
  });
  packet.raw = packet.serialize();
  await dest.receive(packet);
  assert.strictEqual(layer.packets.length, 0);
});

// ---------------------------------------------------------------------------
// End-to-end: send DATA → receiver proves → sender receipt resolves
// ---------------------------------------------------------------------------

/**
 * Creates a Reticulum instance with a single loopback interface: every packet
 * written to it is routed back into the transport asynchronously (modelling
 * real network transit so the send→track→prove→resolve ordering holds).
 *
 * @param {import("../../src/transport/transport.js").TransportCore} transport
 */
function attachLoopback(transport) {
  const iface = Object.assign(new EventTarget(), {
    name: "loopback",
    _packetWriter: {
      write: async (/** @type {Packet} */ pkt) => {
        // setImmediate (macrotask) runs after the sendPacket `await` resumes
        // and tracks the receipt, so the proof never arrives before tracking.
        setImmediate(() => {
          transport._routeIncomingPacket(pkt, iface);
        });
      },
    },
  });
  transport.addInterface(iface, true);
  return iface;
}

test("end-to-end: an opportunistic DATA packet's PROOF resolves the sender receipt", async () => {
  const rns = new Reticulum();
  const transport = rns.transport;
  attachLoopback(transport);

  // Receiver: an lxmf.delivery destination with a private key.
  const recvIdentity = await Identity.generate();
  const recvDest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    recvIdentity,
    /** @type {any} */ (rns),
  );
  transport.bindLocalDestination(recvDest);

  // Sender must know the receiver's identity to verify the proof signature.
  await Destination.remember(
    crypto.getRandomValues(new Uint8Array(32)),
    /** @type {Uint8Array} */ (recvDest.destinationHash),
    recvIdentity.publicKey,
  );

  // Send an opportunistic DATA packet to the receiver.
  const payload = await recvIdentity.encrypt(new Uint8Array([42]));
  const dataPacket = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: /** @type {Uint8Array} */ (recvDest.destinationHash),
    contextByte: ContextType.NONE,
    payload,
  });
  await transport.sendPacket(dataPacket);

  // Capture the tracked receipt by reference (registered synchronously in
  // sendPacket) and let the async proof round-trip complete.
  const dataHash = await dataPacket.getHash();
  const receipt = PacketReceipt.find(dataHash.slice(0, 16));
  assert.ok(receipt, "sendPacket should track a PacketReceipt");

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.strictEqual(
    receipt.status,
    ReceiptStatus.DELIVERED,
    "the receiver's PROOF should have resolved the receipt",
  );
  assert.strictEqual(
    PacketReceipt.find(dataHash.slice(0, 16)),
    null,
    "a delivered receipt is removed from the registry",
  );
});

test("end-to-end: explicit-form PROOFs also resolve the sender receipt", async () => {
  const rns = new Reticulum({ useImplicitProof: false });
  const transport = rns.transport;
  attachLoopback(transport);

  const recvIdentity = await Identity.generate();
  const recvDest = await Destination.IN(
    "lxmf.delivery",
    DestType.SINGLE,
    recvIdentity,
    /** @type {any} */ (rns),
  );
  transport.bindLocalDestination(recvDest);
  await Destination.remember(
    crypto.getRandomValues(new Uint8Array(32)),
    /** @type {Uint8Array} */ (recvDest.destinationHash),
    recvIdentity.publicKey,
  );

  const payload = await recvIdentity.encrypt(new Uint8Array([7]));
  const dataPacket = new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: /** @type {Uint8Array} */ (recvDest.destinationHash),
    contextByte: ContextType.NONE,
    payload,
  });
  await transport.sendPacket(dataPacket);

  const dataHash = await dataPacket.getHash();
  const receipt = PacketReceipt.find(dataHash.slice(0, 16));
  assert.ok(receipt);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(receipt.status, ReceiptStatus.DELIVERED);
});
