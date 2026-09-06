/**
 * Connectivity lost/regained: the transport must keep using an interface
 * across reconnects.
 *
 * Reconnecting interfaces (TCP client, local client, WebSocket client,
 * WebRTC) replace their readable/writable streams on every re-establishment
 * and drop their stale packet writer. The transport re-acquires the writer on
 * each `connected` event — otherwise the interface could never transmit
 * again after the first reconnect: `broadcast()` silently skips writer-less
 * interfaces (announces and path requests stop leaving the node) and
 * `_transmit()` throws for routed sends.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { Interface } from "../../src/interfaces/base.js";
import { TransportCore } from "../../src/transport/transport.js";
import { bytesEqual } from "../../src/utils/encoding.js";

/**
 * A fake reconnecting client interface that mirrors the stream lifecycle of
 * the real ones (e.g. `TCPClientInterface._setupStreams`): every
 * (re)connection replaces the writable stream and drops the stale writer,
 * then dispatches `connected`.
 */
class ReconnectingFakeInterface extends Interface {
  /**
   * @param {string} [name]
   */
  constructor(name = "fake-tcp") {
    super();
    this.name = name;
    this.bitrate = 1_000_000;
    /** @type {{packets: import("../../src/core/packet.js").Packet[]}[]} */
    this.generations = [];
    /** @type {any} */
    this._writable = null;
  }

  /** @returns {null} */
  get readable() {
    return null;
  }
  /** @returns {any} */
  get writable() {
    return this._writable;
  }

  /**
   * Simulates (re)establishing the connection: fresh writable stream, stale
   * writer dropped — exactly what the real reconnecting interfaces do.
   * @returns {Promise<void>}
   */
  connect() {
    this._packetWriter = null;
    /** @type {{packets: import("../../src/core/packet.js").Packet[]}} */
    const generation = { packets: [] };
    this.generations.push(generation);
    this._writable = new WritableStream({
      /**
       * @param {import("../../src/core/packet.js").Packet} packet
       */
      write(packet) {
        generation.packets.push(packet);
      },
    });
    this.online = true;
    this.dispatchEvent(new CustomEvent("connected"));
    return Promise.resolve();
  }

  /**
   * Simulates the underlying connection dropping.
   */
  drop() {
    this.online = false;
    this.dispatchEvent(new CustomEvent("disconnected"));
  }

  /** @returns {Promise<void>} */
  async disconnect() {
    this.drop();
    this._dispatchClosed();
  }
}

/** Builds a broadcastable DATA packet. */
function mkPacket() {
  return new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.PLAIN,
    destinationHash: crypto.getRandomValues(new Uint8Array(16)),
    contextByte: ContextType.NONE,
    payload: new Uint8Array([1, 2, 3]),
  });
}

/** Resolves once the predicate holds, rejecting after `ms` deadline. */
function waitFor(predicate, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve(undefined);
      if (Date.now() - started > ms)
        return reject(new Error("waitFor deadline exceeded"));
      setTimeout(check, 10);
    };
    check();
  });
}

describe("TransportCore — connectivity lost and regained", () => {
  test("broadcast keeps reaching the interface after a drop and reconnect", async () => {
    const transport = new TransportCore();
    const iface = new ReconnectingFakeInterface();
    await iface.connect();
    transport.addInterface(iface, true);

    const first = mkPacket();
    transport.broadcast(first);
    await waitFor(() => iface.generations[0].packets.length === 1);
    assert.ok(
      bytesEqual(
        await first.getHash(),
        await iface.generations[0].packets[0].getHash(),
      ),
      "pre-drop broadcast should arrive on the first connection",
    );

    // Connectivity lost, then regained.
    iface.drop();
    await iface.connect();

    const second = mkPacket();
    transport.broadcast(second);
    await waitFor(() => iface.generations[1].packets.length === 1);
    assert.ok(
      bytesEqual(
        await second.getHash(),
        await iface.generations[1].packets[0].getHash(),
      ),
      "post-reconnect broadcast should arrive on the new connection",
    );
    assert.strictEqual(
      iface.generations[0].packets.length,
      1,
      "the old connection must not receive anything after the drop",
    );
  });

  test("acquires the first writer when the interface connects after being added", async () => {
    const transport = new TransportCore();
    const iface = new ReconnectingFakeInterface();
    transport.addInterface(iface, true); // added while offline: no writer yet
    assert.strictEqual(iface._packetWriter, null);

    await iface.connect(); // dispatches `connected` → transport acquires

    assert.ok(iface._packetWriter, "writer should be acquired on connect");
    transport.broadcast(mkPacket());
    await waitFor(() => iface.generations[0].packets.length === 1);
  });

  test("routed sends keep working after a drop and reconnect", async () => {
    const transport = new TransportCore();
    const iface = new ReconnectingFakeInterface();
    await iface.connect();
    transport.addInterface(iface, true);

    const destinationHash = crypto.getRandomValues(new Uint8Array(16));
    const nextHop = crypto.getRandomValues(new Uint8Array(16));
    assert.ok(
      transport.routingTable.addOrUpdateRoute(destinationHash, {
        nextHop,
        hops: 1,
        viaInterface: iface,
        randomBlob: crypto.getRandomValues(new Uint8Array(10)),
      }),
      "route should be learned",
    );

    const mkData = () =>
      new Packet({
        packetType: PacketType.DATA,
        destinationType: DestType.SINGLE,
        destinationHash,
        contextByte: ContextType.NONE,
        payload: new Uint8Array([9, 8, 7]),
      });

    await transport.sendPacket(mkData());
    assert.strictEqual(iface.generations[0].packets.length, 1);

    // Connectivity lost, then regained: the stale writer is replaced and the
    // routed send must go out on the new connection instead of throwing
    // "Interface ... has no packet writer".
    iface.drop();
    await iface.connect();

    await transport.sendPacket(mkData());
    await waitFor(() => iface.generations[1].packets.length === 1);
  });
});
