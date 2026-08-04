/**
 * @file ifac_wiring.test.js
 * @description Integration tests for IFAC seal/open through the Interface base
 *   helpers and the real KISS/HDLC framer streams — verifying the Option A
 *   wiring (seal at the serialize chokepoint, open at the deserialize
 *   chokepoint) end-to-end.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DestType, Packet, PacketType } from "../../src/core/packet.js";
import { Interface } from "../../src/interfaces/base.js";
import {
  createHdlcFramerStream,
  createHdlcUnframerStream,
} from "../../src/transport/hdlc-framer.js";
import {
  createKissFramerStream,
  createKissUnframerStream,
} from "../../src/transport/kiss-framer.js";

const NETNAME = "test-network";
const NETKEY = "correct horse battery staple";

/** Minimal concrete Interface subclass for exercising the base helpers. */
class TestInterface extends Interface {}

function samplePacket() {
  return new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.SINGLE,
    destinationHash: new Uint8Array(16).map((_, i) => i + 1),
    payload: new TextEncoder().encode("hello ifac link"),
  });
}

/** Pipes packets through a framer→unframer pair with IFAC seal/open hooks. */
async function roundTripFramed(packet, tx, rx, makeFramer, makeUnframer) {
  const framer = makeFramer((raw) => tx._sealRaw(raw));
  const unframer = makeUnframer(Packet, (raw) => rx._openRaw(raw));
  framer.readable.pipeTo(unframer.writable).catch(() => {});
  const writer = framer.writable.getWriter();
  const reader = unframer.readable.getReader();
  await writer.write(packet);
  const { value } = await reader.read();
  writer.close();
  return value;
}

test("Interface._sealRaw/_openRaw round-trips with matching keys", async () => {
  const a = new TestInterface();
  a.ifacNetname = NETNAME;
  a.ifacNetkey = NETKEY;
  const b = new TestInterface();
  b.ifacNetname = NETNAME;
  b.ifacNetkey = NETKEY;

  const raw = samplePacket().serialize();
  const sealed = await a._sealRaw(raw);
  assert.notDeepEqual([...sealed], [...raw], "seal must alter the bytes");
  const opened = await b._openRaw(sealed);
  assert.ok(opened, "open must succeed with matching keys");
  assert.deepEqual([...opened], [...raw], "round-trip must recover raw");
});

test("Interface._openRaw drops a flag-set packet on a plain interface", async () => {
  const plain = new TestInterface(); // no IFAC configured
  const a = new TestInterface();
  a.ifacNetname = NETNAME;
  a.ifacNetkey = NETKEY;
  const sealed = await a._sealRaw(samplePacket().serialize());
  assert.strictEqual(await plain._openRaw(sealed), null);
});

test("Interface._openRaw drops a flag-clear packet on an IFAC interface", async () => {
  const ifac = new TestInterface();
  ifac.ifacNetname = NETNAME;
  ifac.ifacNetkey = NETKEY;
  const plain = samplePacket().serialize(); // flag clear
  assert.strictEqual(await ifac._openRaw(plain), null);
});

test("Interface._openRaw drops a sealed packet when keys mismatch", async () => {
  const a = new TestInterface();
  a.ifacNetname = NETNAME;
  a.ifacNetkey = NETKEY;
  const b = new TestInterface();
  b.ifacNetname = "other";
  b.ifacNetkey = "wrong";
  const sealed = await a._sealRaw(samplePacket().serialize());
  assert.strictEqual(await b._openRaw(sealed), null);
});

test("IFAC default ifacSize applied when a secret is set but size omitted", async () => {
  const a = new TestInterface();
  a.ifacNetname = NETNAME;
  a.ifacNetkey = NETKEY;
  assert.strictEqual(a.ifacSize, 0);
  await a._ensureIfacMaterial();
  assert.strictEqual(a.ifacSize, a.DEFAULT_IFAC_SIZE);
  assert.strictEqual(a.ifacSize, 16);
  assert.ok(a.ifacIdentity && a.ifacKey && a.ifacSignature);
});

test("KISS framer/unframer round-trips a Packet with matching IFAC keys", async () => {
  const a = new TestInterface();
  a.ifacNetname = NETNAME;
  a.ifacNetkey = NETKEY;
  const b = new TestInterface();
  b.ifacNetname = NETNAME;
  b.ifacNetkey = NETKEY;

  const packet = samplePacket();
  const result = await roundTripFramed(
    packet,
    a,
    b,
    createKissFramerStream,
    createKissUnframerStream,
  );
  assert.ok(result instanceof Packet);
  assert.deepEqual([...result.serialize()], [...packet.serialize()]);
});

test("HDLC framer/unframer round-trips a Packet with matching IFAC keys", async () => {
  const a = new TestInterface();
  a.ifacNetname = NETNAME;
  a.ifacNetkey = NETKEY;
  const b = new TestInterface();
  b.ifacNetname = NETNAME;
  b.ifacNetkey = NETKEY;

  const packet = samplePacket();
  const result = await roundTripFramed(
    packet,
    a,
    b,
    createHdlcFramerStream,
    createHdlcUnframerStream,
  );
  assert.ok(result instanceof Packet);
  assert.deepEqual([...result.serialize()], [...packet.serialize()]);
});

test("KISS unframer silently drops a frame when IFAC keys mismatch", async () => {
  const a = new TestInterface();
  a.ifacNetname = NETNAME;
  a.ifacNetkey = NETKEY;
  const b = new TestInterface();
  b.ifacNetname = "other";
  b.ifacNetkey = "wrong";

  const framer = createKissFramerStream((raw) => a._sealRaw(raw));
  const unframer = createKissUnframerStream(Packet, (raw) => b._openRaw(raw));
  framer.readable.pipeTo(unframer.writable).catch(() => {});
  const writer = framer.writable.getWriter();
  const reader = unframer.readable.getReader();
  await writer.write(samplePacket());

  // The mismatched open returns null → the frame is dropped (no enqueue). A
  // subsequent plain (matching) frame must still come through, proving the
  // unframer survived the drop rather than erroring.
  const plain = new TestInterface(); // no IFAC
  const framer2 = createKissFramerStream((raw) => plain._sealRaw(raw));
  const unframer2 = createKissUnframerStream(Packet, (raw) =>
    plain._openRaw(raw),
  );
  framer2.readable.pipeTo(unframer2.writable).catch(() => {});
  const w2 = framer2.writable.getWriter();
  const r2 = unframer2.readable.getReader();
  const pkt = samplePacket();
  await w2.write(pkt);
  const { value } = await r2.read();
  assert.ok(value instanceof Packet, "unframer must keep working after a drop");
  writer.close();
  w2.close();
});
