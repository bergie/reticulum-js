#!/usr/bin/env python3
"""Minimal TLS WebSocket client for RNS-over-WSS compatibility tests.

Connects to a ``wss://`` endpoint, skipping certificate verification (the test
server uses a self-signed cert), sends a raw RNS packet, and waits for a reply.
This verifies the JS ``WebSocketServerInterface`` TLS termination is
wire-compatible with the Python reference client.

Prints ``OK`` on success (and exits 0) or ``ERROR …`` / ``FAIL …`` (and exits
non-zero) so the JS test harness can assert the outcome.

Usage: ws_client_tls.py <host> <port>
"""

import ssl
import sys

import RNS
from websockets.sync.client import connect


def main():
    host = sys.argv[1]
    port = int(sys.argv[2])

    # The test server presents a self-signed cert; don't verify it.
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    dest = RNS.Destination(
        None, RNS.Destination.OUT, RNS.Destination.PLAIN, "test", "echo"
    )
    req = RNS.Packet(dest, b"ping from python")
    req.pack()

    try:
        with connect(f"wss://{host}:{port}", ssl=ctx, max_size=None) as ws:
            print("CONNECTED", flush=True)
            ws.send(req.raw)
            print(f"SENT {len(req.raw)} bytes", flush=True)
            reply = ws.recv(timeout=10)
            packet = RNS.Packet(destination=None, data=reply)
            if not packet.unpack():
                print("ERROR could not parse reply", flush=True)
                sys.exit(1)
            print(f"RECEIVED {packet.data!r}", flush=True)
            if packet.data == b"pong from js":
                print("OK", flush=True)
            else:
                print("FAIL wrong payload", flush=True)
                sys.exit(1)
    except Exception as e:
        print(f"ERROR {e}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
