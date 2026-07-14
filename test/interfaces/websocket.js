import assert from "node:assert";
import crypto from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { WebSocketClientInterface } from "../../src/interfaces/websocket.js";

/**
 * @file websocket.js
 * @description Tests for the WebSocket client interface.
 *
 * These tests spin up a minimal in-process RFC 6455 WebSocket server (no
 * external dependencies) to exercise the client. They assert the wire model
 * that is compatible with the Python reference `WebSocketServer.py`: each
 * WebSocket binary message carries exactly one raw RNS packet — no HDLC
 * (0x7E) framing, no compression.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * @typedef {Object} TestConnection
 * @property {(bytes: Uint8Array) => void} send - Send raw bytes as one binary frame.
 * @property {((bytes: Uint8Array) => void) | null} onMessage - Set by the caller to receive frames.
 * @property {(() => void) | null} onClose - Set by the caller to observe close.
 * @property {() => void} close - Initiate a close (sends a close frame and tears down).
 */

/**
 * Minimal RFC 6455 WebSocket server for testing. Compression is not negotiated
 * (matching `WebSocketServer.py`'s `compression=None`) and the close handshake
 * is completed so clients can shut down cleanly.
 * @param {number} port
 * @param {(conn: TestConnection) => void} onConnection
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
function startWebSocketServer(port, onConnection) {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  /** @type {import('node:net').Socket[]} */
  const sockets = [];

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    sockets.push(socket);

    /** Send a raw binary frame (unmasked, server -> client). */
    const sendFrame = (/** @type {Uint8Array} */ bytes) => {
      const payload = Buffer.from(bytes);
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x82, len]); // FIN + binary
      } else if (len < 65536) {
        header = Buffer.from([0x82, 126, (len >> 8) & 0xff, len & 0xff]);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 127;
        header.writeUInt32BE(len, 6);
      }
      socket.write(Buffer.concat([header, payload]));
    };
    /** Send a close frame (no status code) and destroy the socket. */
    const sendClose = () => {
      try {
        socket.write(Buffer.from([0x88, 0x00]));
      } catch (_e) {
        // ignore
      }
      socket.destroy();
    };

    /** @type {TestConnection} */
    const connection = {
      send: sendFrame,
      close: sendClose,
      onMessage: null,
      onClose: null,
    };

    let buffer = Buffer.alloc(0);
    let closed = false;
    socket.on("data", (/** @type {Buffer} */ chunk) => {
      if (closed) return;
      buffer = Buffer.concat([buffer, chunk]);
      buffer = consumeFrames(buffer, {
        onData: (payload) => {
          if (connection.onMessage) connection.onMessage(payload);
        },
        onClose: () => {
          closed = true;
          // Echo the close to finish the handshake, then tear down.
          sendClose();
          if (connection.onClose) connection.onClose();
        },
      });
    });
    socket.on("close", () => {
      if (!closed && connection.onClose) connection.onClose();
    });
    socket.on("error", () => {
      /* ignore */
    });

    onConnection(connection);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        close: () => {
          for (const s of sockets) s.destroy();
          return new Promise((resolve) => server.close(() => resolve()));
        },
      }),
    );
  });
}

/**
 * Parses zero or more (masked) WebSocket frames from `buffer`. Invokes
 * `handlers.onData(payload)` for each complete binary/text frame, and
 * `handlers.onClose()` for the first close frame. Returns the leftover
 * (incomplete) buffer.
 * @param {Buffer} buffer
 * @param {{ onData: (payload: Uint8Array) => void, onClose: () => void }} handlers
 * @returns {Buffer}
 */
function consumeFrames(buffer, handlers) {
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let ptr = offset + 2;
    if (len === 126) {
      if (buffer.length - ptr < 2) break;
      len = (buffer[ptr] << 8) | buffer[ptr + 1];
      ptr += 2;
    } else if (len === 127) {
      if (buffer.length - ptr < 8) break;
      len = Number(buffer.readBigUInt64BE(ptr));
      ptr += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length - ptr < 4) break;
      mask = buffer.subarray(ptr, ptr + 4);
      ptr += 4;
    }
    if (buffer.length - ptr < len) break;
    let payload = buffer.subarray(ptr, ptr + len);
    if (masked && mask) {
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
      payload = unmasked;
    }
    if (opcode === 0x8) {
      handlers.onClose();
      return buffer.subarray(buffer.length);
    }
    if (opcode === 0x1 || opcode === 0x2) {
      handlers.onData(payload);
    }
    offset = ptr + len;
  }
  return buffer.subarray(offset);
}

/** Builds a minimal valid RNS DATA packet. */
function buildTestPacket(payload = "Hello over WebSocket!") {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: 0,
    payload: new TextEncoder().encode(payload),
  });
}

test("WebSocket client sends raw packets per message (no HDLC framing)", async () => {
  const port = 13901;
  /** @type {Promise<Uint8Array>} */
  let resolveReceived;
  const receivedPromise = new Promise((resolve) => {
    resolveReceived = resolve;
  });
  const server = await startWebSocketServer(port, (conn) => {
    conn.onMessage = (bytes) => resolveReceived(bytes);
  });

  const client = new WebSocketClientInterface({
    url: `ws://127.0.0.1:${port}`,
    name: "ws-test",
  });
  await client.connect();
  assert.ok(client.isOpen);

  const packet = buildTestPacket("HDLC check");
  const expected = packet.serialize();

  const writer = client.writable.getWriter();
  await writer.write(packet);
  writer.releaseLock();

  const observed = await receivedPromise;

  // The bytes on the wire must be exactly the raw packet, with no HDLC
  // 0x7E flag bytes wrapping it.
  assert.deepEqual(Array.from(observed), Array.from(expected));
  assert.notStrictEqual(observed[0], 0x7e);
  assert.notStrictEqual(observed[observed.length - 1], 0x7e);

  await client.disconnect();
  await server.close();
});

test("WebSocket client receives raw packets as messages", async () => {
  const port = 13902;
  /** @type {TestConnection | null} */
  let connection = null;
  const server = await startWebSocketServer(port, (conn) => {
    connection = conn;
  });

  const client = new WebSocketClientInterface({
    url: `ws://127.0.0.1:${port}`,
  });

  await client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(connection, "server should have accepted the connection");

  const inboundPacket = buildTestPacket("from server");
  connection.send(inboundPacket.serialize());

  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 3000);
    client.addEventListener("packet", (event) => {
      clearTimeout(timer);
      resolve(event.detail.packet);
    });
  });

  assert.ok(received);
  assert.deepEqual(new TextDecoder().decode(received.payload), "from server");

  await client.disconnect();
  await server.close();
});

test("WebSocket client lifecycle events (connected, packet, closed)", async () => {
  const port = 13903;
  /** @type {TestConnection | null} */
  let connection = null;
  const server = await startWebSocketServer(port, (conn) => {
    connection = conn;
  });

  const client = new WebSocketClientInterface({
    url: `ws://127.0.0.1:${port}`,
  });

  let connectedFired = false;
  client.addEventListener("connected", () => {
    connectedFired = true;
  });
  await client.connect();
  assert.ok(connectedFired, "connected event should fire");
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(connection);
  connection.send(buildTestPacket("lifecycle").serialize());

  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 3000);
    client.addEventListener("packet", (event) => {
      clearTimeout(timer);
      resolve(event.detail.packet);
    });
  });
  assert.strictEqual(new TextDecoder().decode(received.payload), "lifecycle");

  let closedFired = false;
  client.addEventListener("closed", () => {
    closedFired = true;
  });

  // Server-initiated close should surface as a `closed` event on the client.
  connection.close();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    client.addEventListener("closed", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.ok(closedFired, "closed event should fire on remote disconnect");

  await server.close();
});

test("WebSocket client connect failure rejects", async () => {
  const client = new WebSocketClientInterface({
    url: "ws://127.0.0.1:1", // nothing listening
  });
  await assert.rejects(() => client.connect());
  assert.ok(!client.isOpen);
});

test("WebSocket client builds URL from host and port", () => {
  const a = new WebSocketClientInterface({ host: "example.com", port: 8080 });
  assert.strictEqual(a.url, "ws://example.com:8080");
  const b = new WebSocketClientInterface({ url: "wss://x/y" });
  assert.strictEqual(b.url, "wss://x/y");
});
