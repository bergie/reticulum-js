import { strict as assert } from "node:assert";
import test from "node:test";
import { Destination, Direction } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Link } from "../../src/transport/link.js";

class MockTransport {
  constructor() {
    this.receivedPackets = [];
    this.onPacketReceived = null;
  }
  async sendPacket(packet) {
    this.receivedPackets.push(packet);
    if (this.onPacketReceived) {
      await this.onPacketReceived(packet);
    }
    return true;
  }
}

test("Link identity proof", async (t) => {
  const identityA = await Identity.generate();
  const identityB = await Identity.generate();

  const linkId = new Uint8Array(16).fill(0xaa);

  const transportA = new MockTransport();
  const transportB = new MockTransport();

  // Link A (Initiator)
  const destB = await Destination.create(
    "B",
    Direction.OUT,
    DestType.SINGLE,
    identityB,
    null,
  );
  const ephemeralKeyPairA = {
    publicKey: identityA.x25519Pub,
    privateKey: identityA.x25519Priv,
  };

  const sigPrvA = identityA.ed25519Priv;
  const sigPubBytesA = (await identityA.getPublicKey()).slice(32);
  console.log("sigPubBytesA length:", sigPubBytesA.length);

  const linkA = new Link(
    destB,
    linkId,
    ephemeralKeyPairA,
    (await identityB.getPublicKey()).slice(0, 32), // peerPubBytes (X25519)
    sigPrvA,
    sigPubBytesA,
    transportA,
  );

  // Link B (Responder)
  const destA = await Destination.create(
    "A",
    Direction.OUT,
    DestType.SINGLE,
    identityA,
    null,
  );
  const ephemeralKeyPairB = {
    publicKey: identityB.x25519Pub,
    privateKey: identityB.x25519Priv,
  };

  const sigPrvB = identityB.ed25519Priv;
  const sigPubBytesB = (await identityB.getPublicKey()).slice(32);
  console.log("sigPubBytesB length:", sigPubBytesB.length);

  const linkB = new Link(
    destA,
    linkId,
    ephemeralKeyPairB,
    (await identityA.getPublicKey()).slice(0, 32), // peerPubBytes (X25519)
    sigPrvB,
    sigPubBytesB,
    transportB,
  );

  // Connect them
  transportA.onPacketReceived = async (packet) => {
    await linkB.receive(packet);
  };
  transportB.onPacketReceived = async (packet) => {
    await linkA.receive(packet);
  };

  // 1. Establish the link (derive keys)
  await linkA.deriveKeys();
  await linkB.deriveKeys();

  // 2. Link A proves its identity
  let proofReceived = false;
  linkB.addEventListener("lrproof", (event) => {
    proofReceived = true;
    const { packet } = event.detail;
    assert.strictEqual(packet.contextByte, ContextType.LRPROOF);
    assert.strictEqual(packet.packetType, PacketType.PROOF);
  });

  await linkA.prove();

  // 3. Verify proof was received
  assert.ok(proofReceived, "LRPROOF event was not received by Link B");
});
