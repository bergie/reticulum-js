import assert from "node:assert";
import { execSync, spawn } from "node:child_process";
import net from "node:net";
import { test } from "node:test";
import {
  ContextType,
  DestType,
  HeaderType,
  Packet,
  PacketType,
} from "@reticulum/core/src/core/packet.js";
import {
  BackboneClientInterface,
  BackboneInterface,
} from "../../src/interfaces/backbone.js";

/**
 * @file backbone_python.js
 * @description Integration tests against the Python reference backbone wire
 *   protocol (work doc #34).
 *
 * The Python ``BackboneInterface`` itself is Linux-only (its epoll
 * architecture), so these tests exercise the *wire protocol and IFAC byte
 * format* through a fixture (`fixtures/backbone_server.py`) that uses the
 * reference's own HDLC unframing, IFAC sealing/unsealing and Packet
 * parsing — byte-for-byte parity without needing epoll. The fixture runs
 * wherever Python + RNS do.
 *
 * Both directions are covered:
 *
 * - JS ``BackboneClientInterface`` → Python backbone listener (the JS
 *   initiator peers with a Python transport node's backbone endpoint).
 * - Python backbone client (raw socket speaking the same wire format) →
 *   JS ``BackboneInterface`` listener (a Python transport node peers with
 *   our listener).
 *
 * Plus IFAC-protected peering with a network name and passphrase.
 *
 * Skipped automatically when `python3` or `RNS` are not available.
 */

const FIXTURE = new URL("fixtures/backbone_server.py", import.meta.url)
  .pathname;
/**
 * The real-class fixture: instantiates the actual Python reference
 * ``BackboneInterface`` (Linux/epoll only).
 */
const REAL_FIXTURE = new URL(
  "fixtures/backbone_real_server.py",
  import.meta.url,
).pathname;

/**
 * Whether the Python toolchain needed for the integration tests is
 * available. When false, the tests are skipped (e.g. in CI without Python).
 */
const pythonAvailable = (() => {
  try {
    execSync('python3 -c "import RNS"', { stdio: "ignore" });
    return true;
  } catch (_e) {
    return false;
  }
})();

/**
 * Whether the *real* Python ``BackboneInterface`` can run here: it needs
 * ``select.epoll``, which only exists on Linux (the Python class is
 * deliberately Linux-only). The wire-format tests above run anywhere;
 * the real-class tests gated on this run on CI's ubuntu runners and skip
 * on e.g. macOS dev machines.
 */
const epollAvailable = (() => {
  try {
    execSync("python3 -c \"import select; assert hasattr(select, 'epoll')\"", {
      stdio: "ignore",
    });
    return true;
  } catch (_e) {
    return false;
  }
})();

const t = pythonAvailable ? test : test.skip;
const tReal = pythonAvailable && epollAvailable ? test : test.skip;

/**
 * Starts the Python reference backbone listener fixture and resolves once
 * it reports its listening port.
 * @param {number} port
 * @param {string|null} netname
 * @param {string|null} netkey
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, port: number }>}
 */
function startPythonBackbone(port, netname = null, netkey = null) {
  const args = [
    FIXTURE,
    "127.0.0.1",
    String(port),
    netname ?? "-",
    netkey ?? "-",
  ];
  const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
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
          "Python backbone server did not announce a port in time. stderr: " +
            Buffer.concat(stderrChunks).toString("utf8"),
        ),
      );
    }, 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(
          new Error(
            `Python backbone server exited with ${code}. stderr: ` +
              Buffer.concat(stderrChunks).toString("utf8"),
          ),
        );
      }
    });
  });

  return /** @type {Promise<{ child: import("node:child_process").ChildProcess, port: number }>} */ (
    portPromise.then((resolved) => ({ child, port: resolved }))
  );
}

/**
 * Allocates a free TCP port on localhost by briefly opening a server.
 * @returns {Promise<number>}
 */
function allocatePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (
        srv.address()
      );
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Builds a minimal valid DATA packet.
 * @param {string} payload
 */
function buildTestPacket(payload) {
  return new Packet({
    headerType: HeaderType.HEADER_1,
    hops: 0,
    transportType: 0,
    destinationType: DestType.PLAIN,
    packetType: PacketType.DATA,
    contextFlag: false,
    destinationHash: new Uint8Array(16).fill(0),
    contextByte: ContextType.NONE,
    payload: new TextEncoder().encode(payload),
  });
}

t(
  "backbone client interoperates with the Python reference backbone listener",
  { timeout: 30000 },
  async () => {
    const port = await allocatePort();
    const { child, port: realPort } = await startPythonBackbone(port);
    try {
      const client = new BackboneClientInterface({
        host: "127.0.0.1",
        port: realPort,
      });
      await client.connect();
      assert.ok(client.isOpen, "client should connect to the Python listener");

      // 1. JS -> Python: an HDLC-framed RNS packet.
      const writer = client.writable.getWriter();
      await writer.write(buildTestPacket("ping from js"));
      writer.releaseLock();

      // 2. Python -> JS: a packet independently constructed by RNS.
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

t(
  "backbone client interoperates with the Python reference over an IFAC-protected link",
  { timeout: 30000 },
  async () => {
    const port = await allocatePort();
    const { child, port: realPort } = await startPythonBackbone(
      port,
      "interop-net",
      "backbone-secret",
    );
    try {
      const client = new BackboneClientInterface({
        host: "127.0.0.1",
        port: realPort,
        networkName: "interop-net",
        passphrase: "backbone-secret",
      });
      await client.connect();

      // IFAC-sealed round trip: the fixture verifies our seal and replies
      // with its own (reference-format) seal, which our open path must
      // accept.
      const writer = client.writable.getWriter();
      await writer.write(buildTestPacket("sealed ping from js"));
      writer.releaseLock();

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
      assert.strictEqual(
        new TextDecoder().decode(reply.payload),
        "pong from python",
        "IFAC-sealed payload must round-trip with the reference",
      );

      await client.disconnect();
    } finally {
      child.kill("SIGTERM");
    }
  },
);

t(
  "Python backbone wire client interoperates with the JS backbone listener",
  { timeout: 30000 },
  async () => {
    // The Python reference's BackboneClientInterface needs epoll (Linux);
    // the wire format it speaks is plain HDLC, so a raw socket speaking that
    // format (via a small Python client fixture) verifies our listener
    // against the reference byte format.
    const server = new BackboneInterface({ listenPort: 0 });
    await server.connect();

    const connectionPromise = new Promise((resolve) => {
      server.addEventListener("connection", (event) => resolve(event.detail));
    });

    // Python dials us, sends an RNS packet, and reads our reply.
    const clientScript = `
import socket, sys
import RNS
from RNS.Interfaces.BackboneInterface import HDLC

s = socket.create_connection(("127.0.0.1", ${server.bindPort}), timeout=10)
dest = RNS.Destination(None, RNS.Destination.OUT, RNS.Destination.PLAIN, "test", "echo")
packet = RNS.Packet(dest, b"ping from python")
packet.pack()
s.sendall(bytes([HDLC.FLAG]) + HDLC.escape(packet.raw) + bytes([HDLC.FLAG]))
print("SENT", flush=True)

data = s.recv(1048576)
frame_start = data.find(bytes([HDLC.FLAG]))
frame_end = data.find(bytes([HDLC.FLAG]), frame_start + 1)
frame = data[frame_start + 1 : frame_end]
frame = frame.replace(bytes([HDLC.ESC, HDLC.FLAG ^ HDLC.ESC_MASK]), bytes([HDLC.FLAG]))
frame = frame.replace(bytes([HDLC.ESC, HDLC.ESC ^ HDLC.ESC_MASK]), bytes([HDLC.ESC]))
reply = RNS.Packet(None, frame)
assert reply.unpack(), "could not parse reply"
assert reply.data == b"pong from js", f"unexpected reply {reply.data!r}"
print("RECEIVED", flush=True)
s.close()
`;
    const child = spawn("python3", ["-c", clientScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    /** @type {Buffer[]} */
    const stderrChunks = [];
    child.stderr.on("data", (c) => stderrChunks.push(c));
    const pythonDone = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Python client timed out. stderr: " +
                Buffer.concat(stderrChunks).toString("utf8"),
            ),
          ),
        15000,
      );
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(undefined);
        else
          reject(
            new Error(
              `Python client exited with ${code}. stdout: ` +
                Buffer.concat(stdoutChunks).toString("utf8") +
                " stderr: " +
                Buffer.concat(stderrChunks).toString("utf8"),
            ),
          );
      });
    });

    try {
      const spawned = await connectionPromise;

      // Reply to the Python ping from the spawned interface.
      const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for Python ping")),
          10000,
        );
        spawned.addEventListener("packet", (event) => {
          clearTimeout(timer);
          resolve(event.detail.packet);
        });
      });
      assert.strictEqual(
        new TextDecoder().decode(received.payload),
        "ping from python",
        "payload must be the Python-constructed packet",
      );
      const writer = spawned.writable.getWriter();
      await writer.write(buildTestPacket("pong from js"));
      writer.releaseLock();

      await pythonDone;
      await server.disconnect();
    } finally {
      child.kill("SIGTERM");
    }
  },
);

// ---------------------------------------------------------------------
// Real-class interop (Linux/epoll only; wire-format coverage is above).
// The Python BackboneInterface/BackboneClientInterface deliberately
// require select.epoll, so these tests run on CI's ubuntu runners and
// skip on platforms without it (e.g. macOS dev machines).
// ---------------------------------------------------------------------

/**
 * Starts the real Python reference backbone listener fixture and resolves
 * once it reports its listening port.
 * @param {number} port
 * @param {string|null} netname
 * @param {string|null} netkey
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, port: number }>}
 */
function startPythonRealBackbone(port, netname = null, netkey = null) {
  const args = [
    REAL_FIXTURE,
    "127.0.0.1",
    String(port),
    netname ?? "-",
    netkey ?? "-",
  ];
  const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
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
          "Python real backbone server did not announce a port in time. stderr: " +
            Buffer.concat(stderrChunks).toString("utf8"),
        ),
      );
    }, 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(
          new Error(
            `Python real backbone server exited with ${code}. stderr: ` +
              Buffer.concat(stderrChunks).toString("utf8"),
          ),
        );
      }
    });
  });

  return /** @type {Promise<{ child: import("node:child_process").ChildProcess, port: number }>} */ (
    portPromise.then((resolved) => ({ child, port: resolved }))
  );
}

tReal(
  "JS backbone client interoperates with the real Python BackboneInterface",
  { timeout: 30000 },
  async () => {
    const port = await allocatePort();
    const { child, port: realPort } = await startPythonRealBackbone(port);
    try {
      const client = new BackboneClientInterface({
        host: "127.0.0.1",
        port: realPort,
      });
      await client.connect();
      assert.ok(client.isOpen, "client should connect to the real listener");

      const writer = client.writable.getWriter();
      await writer.write(buildTestPacket("ping from js"));
      writer.releaseLock();

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

tReal(
  "JS backbone client interoperates with the real Python BackboneInterface over an IFAC-protected link",
  { timeout: 30000 },
  async () => {
    const port = await allocatePort();
    const { child, port: realPort } = await startPythonRealBackbone(
      port,
      "interop-net",
      "backbone-secret",
    );
    try {
      const client = new BackboneClientInterface({
        host: "127.0.0.1",
        port: realPort,
        networkName: "interop-net",
        passphrase: "backbone-secret",
      });
      await client.connect();

      const writer = client.writable.getWriter();
      await writer.write(buildTestPacket("sealed ping from js"));
      writer.releaseLock();

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
      assert.strictEqual(
        new TextDecoder().decode(reply.payload),
        "pong from python",
        "IFAC-sealed payload must round-trip with the real reference listener",
      );

      await client.disconnect();
    } finally {
      child.kill("SIGTERM");
    }
  },
);

tReal(
  "the real Python BackboneClientInterface interoperates with the JS backbone listener",
  { timeout: 30000 },
  async () => {
    const server = new BackboneInterface({ listenPort: 0 });
    await server.connect();

    const connectionPromise = new Promise((resolve) => {
      server.addEventListener("connection", (event) => resolve(event.detail));
    });

    // The real Python BackboneClientInterface (initiator) dials our
    // listener: its SYNCHRONOUS_START connect, HDLC framing and inbound
    // receive path all run for real.
    const clientScript = `
import sys, tempfile, os
import RNS
from RNS.Interfaces.BackboneInterface import BackboneClientInterface

# A no-interface config avoids the default AutoInterface/shared-instance
# sockets (which panic-exit when their ports are taken).
cfgdir = tempfile.mkdtemp()
with open(os.path.join(cfgdir, "config"), "w") as f:
    f.write("[reticulum]\\nenable_transport = False\\nshare_instance = No\\n")
rns = RNS.Reticulum(configdir=cfgdir, loglevel=RNS.LOG_ERROR)
config = {"name": "backbone-client-fixture", "target_host": "127.0.0.1", "target_port": "${server.bindPort}"}
client = BackboneClientInterface(RNS.Transport, config)
assert client.online, "Python backbone client failed to connect"

got_reply = []
def tap(raw, interface=None, tc=None, ifac_handled=False):
    packet = RNS.Packet(None, raw)
    if packet.unpack() and packet.data == b"pong from js":
        got_reply.append(True)

RNS.Transport.inbound = staticmethod(tap)

# Send a ping to the JS listener via the reference transmit path.
dest = RNS.Destination(None, RNS.Destination.OUT, RNS.Destination.PLAIN, "test", "echo")
packet = RNS.Packet(dest, b"ping from python")
packet.pack()
RNS.Transport.transmit(client, packet.raw)
print("SENT", flush=True)

import time
deadline = time.time() + 10
while not got_reply and time.time() < deadline:
    time.sleep(0.1)
assert got_reply, "Python client did not receive the JS reply"
print("RECEIVED", flush=True)
client.detach()
`;
    const child = spawn("python3", ["-c", clientScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    /** @type {Buffer[]} */
    const stderrChunks = [];
    child.stderr.on("data", (c) => stderrChunks.push(c));
    const pythonDone = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Python real client timed out. stdout: " +
                Buffer.concat(stdoutChunks).toString("utf8") +
                " stderr: " +
                Buffer.concat(stderrChunks).toString("utf8"),
            ),
          ),
        15000,
      );
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(undefined);
        else
          reject(
            new Error(
              `Python real client exited with ${code}. stdout: ` +
                Buffer.concat(stdoutChunks).toString("utf8") +
                " stderr: " +
                Buffer.concat(stderrChunks).toString("utf8"),
            ),
          );
      });
    });

    try {
      const spawned = await connectionPromise;

      // Reply to the Python client from the spawned interface; the real
      // Python client's receive path must decode it.
      const received = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for Python ping")),
          10000,
        );
        spawned.addEventListener("packet", (event) => {
          clearTimeout(timer);
          resolve(event.detail.packet);
        });
      });
      assert.strictEqual(
        new TextDecoder().decode(received.payload),
        "ping from python",
        "payload must be the real Python client's packet",
      );
      const writer = spawned.writable.getWriter();
      await writer.write(buildTestPacket("pong from js"));
      writer.releaseLock();

      await pythonDone;
      await server.disconnect();
    } finally {
      child.kill("SIGTERM");
    }
  },
);
