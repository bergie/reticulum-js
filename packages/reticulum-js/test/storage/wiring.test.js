/**
 * Persistence wiring (work doc #16, Step 2): `Reticulum` constructs a
 * `Persistor` from its `storageAdapter` and hydrates at startup, and
 * `TransportCore.sendPacket` marks contacted destinations for real (non-link)
 * outbound traffic. Hydrated path entries (no live interface) fall back to the
 * default interface instead of throwing.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Reticulum } from "../../src/core/reticulum.js";
import { Persistor } from "../../src/storage/persistor.js";
import {
  MemoryStorageAdapter,
  StorageNamespace,
} from "../../src/storage/storage.js";
import { TransportCore } from "../../src/transport/transport.js";
import { toHex } from "../../src/utils/encoding.js";

/** Captures broadcast announce packets in place of a real interface layer. */
class CapturingLayer {
  constructor() {
    /** @type {Packet[]} */
    this.packets = [];
  }
  /** @param {Packet} pkt */
  broadcast(pkt) {
    this.packets.push(pkt);
  }
}

/** A minimal interface that records every packet written to its framer. */
function capturingInterface(name) {
  /** @type {Packet[]} */
  const written = [];
  const iface = Object.assign(new EventTarget(), {
    name,
    _packetWriter: {
      /** @param {Packet} pkt */
      write: async (pkt) => {
        written.push(pkt);
      },
    },
  });
  return { iface, written };
}

/** Builds a real direct (1-hop) announce as it would arrive on the wire. */
async function buildDirectAnnounce(appName) {
  const identity = await Identity.generate();
  const layer = new CapturingLayer();
  const dest = await Destination.IN(appName, DestType.SINGLE, identity, layer);
  await dest.announce();
  const arriving = Packet.deserialize(layer.packets[0].serialize());
  return {
    packet: arriving,
    destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
  };
}

describe("Reticulum — persistence wiring", () => {
  test("constructs an enabled Persistor from storageAdapter and exposes a load promise", async () => {
    const rns = new Reticulum({ storageAdapter: new MemoryStorageAdapter() });
    assert.ok(rns.persistor instanceof Persistor);
    assert.strictEqual(rns.persistor.enabled, true);
    assert.strictEqual(rns.transport.persistor, rns.persistor);
    // The load promise resolves (empty adapter hydrates nothing).
    await rns.persistorLoadPromise;
  });

  test("with no adapter, the Persistor is present but disabled", async () => {
    const rns = new Reticulum({});
    assert.ok(rns.persistor instanceof Persistor);
    assert.strictEqual(rns.persistor.enabled, false);
    await rns.persistorLoadPromise; // no-op, resolves
  });
});

describe("TransportCore.sendPacket — communicate-with marking (#16)", () => {
  test("a routable DATA send marks the destination as contacted", async () => {
    const transport = new TransportCore();
    const { iface, written } = capturingInterface("eth0");
    transport.addInterface(iface, true);
    const { packet: announce, destinationHash } =
      await buildDirectAnnounce("test.mark.data");
    await transport._routeIncomingPacket(announce, iface);

    const persistor = new Persistor({
      adapter: new MemoryStorageAdapter(),
      routingTable: transport.routingTable,
      debounceMs: 0,
    });
    transport.persistor = persistor;

    const data = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.SINGLE,
      destinationHash,
      contextByte: ContextType.NONE,
      payload: new Uint8Array([1, 2, 3]),
    });
    await transport.sendPacket(data);

    assert.strictEqual(written.length, 1, "packet was transmitted");
    assert.ok(
      persistor.persistedDestinations.has(toHex(destinationHash)),
      "contacted destination is slated for persistence",
    );

    // Flushing writes the learned path for it (routingTable is shared).
    await persistor.flush();
    const pathKeys = await persistor.adapter.keys(StorageNamespace.PATHS);
    assert.ok(
      pathKeys.includes(toHex(destinationHash)),
      "path entry persisted for the contacted destination",
    );
  });

  test("a PLAIN broadcast is not marked (not routable to a peer identity)", async () => {
    const transport = new TransportCore();
    const { iface, written } = capturingInterface("eth0");
    transport.addInterface(iface, true);
    const persistor = new Persistor({
      adapter: new MemoryStorageAdapter(),
      routingTable: transport.routingTable,
      debounceMs: 0,
    });
    transport.persistor = persistor;

    const plain = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.PLAIN,
      destinationHash: crypto.getRandomValues(new Uint8Array(16)),
      contextByte: ContextType.NONE,
      payload: new Uint8Array([1]),
    });
    await transport.sendPacket(plain);

    assert.strictEqual(written.length, 1, "PLAIN broadcast still goes out");
    assert.strictEqual(
      persistor.persistedDestinations.size,
      0,
      "PLAIN broadcast must not be persisted",
    );
  });

  test("a hydrated path entry (no live interface) falls back to the default interface", async () => {
    const transport = new TransportCore();
    const { iface, written } = capturingInterface("eth0");
    transport.addInterface(iface, true); // default
    const { packet: announce, destinationHash } = await buildDirectAnnounce(
      "test.hydrated.iface",
    );
    await transport._routeIncomingPacket(announce, iface);

    // Simulate a hydrated route: strip the live interface reference.
    const route = transport.routingTable.routes.get(toHex(destinationHash));
    assert.ok(route, "route learned from the announce");
    route.interface = null;

    const persistor = new Persistor({
      adapter: new MemoryStorageAdapter(),
      routingTable: transport.routingTable,
      debounceMs: 0,
    });
    transport.persistor = persistor;

    const data = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.SINGLE,
      destinationHash,
      contextByte: ContextType.NONE,
      payload: new Uint8Array([4, 5]),
    });
    // Must not throw despite the null interface.
    await transport.sendPacket(data);

    assert.strictEqual(written.length, 1, "fell back to the default interface");
    assert.ok(
      persistor.persistedDestinations.has(toHex(destinationHash)),
      "still marked contacted",
    );
  });
});
