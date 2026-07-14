import assert from "node:assert";
import { execSync, spawn } from "node:child_process";
import net from "node:net";
import { test } from "node:test";
import {
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "../../src/core/packet.js";
import { WebSocketClientInterface } from "../../src/interfaces/websocket.js";

/**
 * @file websocket_python.js
 * @description Integration test against the Python reference WebSocket server.
 *
 * Spawns the Python `websockets.sync.server`-based server in
 * `fixtures/ws_server.py` (the same library `WebSocketServer.py` uses, with
 * `compression=None`) and verifies end-to-end compatibility: the JS client and
 * the Python reference exchange raw RNS packets as individual WebSocket binary
 * messages, and each side can decode packets independently constructed by the
 * other.
 *
 * Skipped automatically when `python3`, the `websockets` package, or `RNS` are
 * not available (e.g. in CI without a Python toolchain).
 */

const FIXTURE = new URL("fixtures/ws_server.py", import.meta.url).pathname;

/**
 * Whether the Python toolchain needed for the integration test is available.
 * When false, the test is skipped (e.g. in CI without Python).
 */
const pythonAvailable = (() => {
  try {
    execSync('python3 -c "import websockets, RNS"', { stdio: "ignore" });
    return true;
  } catch (_e) {
    return false;
  }
})();

// `t` resolves to `test.skip` when the Python toolchain is unavailable so the
// test is reported as skipped rather than failing.
const t = pythonAvailable ? test : test.skip;

/** Resolves to the first line of stdout containing `LISTENING <port>`. */
function startPythonServer(port) {
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
  const child = spawn("python3", [FIXTURE, "127.0.0.1", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  /** @type {Buffer[]} */
  const stdoutChunks = [];
  child.stdout.on("data", (c) => stdoutChunks.push(c));
  /** @type {Buffer[]} */
  const stderrChunks = [];
  child.stderr.on("data", (c) => stderrChunks.push(c));

  const portPromise = new Promise((resolve, reject) => {
    const check = () => {
      const text = Buffer.concat(stdoutChunks).toString("utf8");
      const match = text.match(/LISTENING (\d+)/);
      if (match) return resolve(Number(match[1]));
      setImmediate(check);
    };
    check();
    const timer = setTimeout(() => {
      reject(
        new Error(
          "Python server did not announce a port in time. stderr: " +
            Buffer.concat(stderrChunks).toString("utf8"),
        ),
      );
    }, 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(
          new Error(
            `Python server exited with ${code}. stderr: ` +
              Buffer.concat(stderrChunks).toString("utf8"),
          ),
        );
      }
    });
  });

  return { child, portPromise };
}

/** Allocates a free TCP port on localhost by briefly opening a server. */
function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function buildTestPacket(payload) {
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

t(
  "WebSocket client interoperates with the Python reference server",
  { timeout: 30000 },
  async () => {
    const port = await allocatePort();
    const { child, portPromise } = startPythonServer(port);
    await portPromise;

    try {
      const client = new WebSocketClientInterface({
        url: `ws://127.0.0.1:${port}`,
      });
      await client.connect();
      assert.ok(client.isOpen, "client should connect to the Python server");

      // 1. JS -> Python: send a raw RNS packet.
      const writer = client.writable.getWriter();
      await writer.write(buildTestPacket("ping from js"));
      writer.releaseLock();

      // 2. Python -> JS: receive a packet independently constructed by RNS.
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for Python reply")),
          10000,
        );
        client.addEventListener("packet", (event) => {
          clearTimeout(timer);
          resolve(event.detail.packet);
        });
      });

      assert.ok(reply, "client should receive a packet from Python");
      assert.strictEqual(
        new TextDecoder().decode(reply.payload),
        "pong from python",
        "payload must be the Python-constructed reply",
      );

      await client.disconnect();
    } finally {
      child.kill("SIGTERM");
    }
  },
);
