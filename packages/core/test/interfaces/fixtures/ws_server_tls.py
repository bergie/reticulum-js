#!/usr/bin/env python3
"""Minimal TLS WebSocket server for RNS-over-WSS compatibility tests.

This is ``ws_server.py`` with TLS termination, mirroring the Python reference
``WebSocketServer.py`` ``ssl`` setup: it builds an ``ssl.SSLContext`` from a
certificate chain and private key, serves over ``websockets.sync.server`` with
``compression=None``, and exchanges raw RNS packets as individual binary
messages (no HDLC framing) over ``wss://``.

It accepts exactly one connection, parses the received bytes with the Python
RNS implementation, and replies with an independently-constructed RNS packet
whose payload is ``b"pong from python"``. Once listening it prints
``LISTENING <port>`` so the JS test harness knows it is ready.

Usage: ws_server_tls.py <certfile> <keyfile> [host] [port]
"""

import ssl
import sys

import RNS
from websockets.sync.server import serve


def main():
    certfile = sys.argv[1]
    keyfile = sys.argv[2]
    host = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 0

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=certfile, keyfile=keyfile)

    server_ref = {"server": None}

    def handle(conn):
        try:
            data = conn.recv()
            # Wire-model assertion: a raw RNS packet, not an HDLC frame.
            assert data[0] != 0x7E, "expected raw packet, got HDLC frame"

            packet = RNS.Packet(destination=None, data=data)
            if not packet.unpack():
                print("ERROR could not parse packet", flush=True)
                return
            print(f"RECEIVED {packet.data!r}", flush=True)

            # Reply with an independently-constructed RNS packet.
            dest = RNS.Destination(
                None, RNS.Destination.OUT, RNS.Destination.PLAIN, "test", "echo"
            )
            reply = RNS.Packet(dest, b"pong from python")
            reply.pack()
            conn.send(reply.raw)
            print(f"SENT {len(reply.raw)} bytes", flush=True)
        finally:
            conn.close()
            if server_ref["server"] is not None:
                try:
                    server_ref["server"].shutdown()
                except Exception:
                    pass

    with serve(handle, host, port, compression=None, ssl_context=ctx) as server:
        server_ref["server"] = server
        # The port was chosen by the caller; echo it back as a ready signal.
        print(f"LISTENING {port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
