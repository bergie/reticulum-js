#!/usr/bin/env python3
"""Minimal WebSocket server for RNS-over-WebSocket compatibility tests.

This mirrors the Python reference ``WebSocketServer.py``: it serves over
``websockets.sync.server`` with ``compression=None`` and exchanges raw RNS
packets as individual binary messages (no HDLC framing).

It accepts exactly one connection, parses the received bytes with the Python
RNS implementation, and replies with an independently-constructed RNS packet
whose payload is ``b"pong from python"``. Once listening it prints
``LISTENING <port>`` so the JS test harness knows it is ready.

Usage: ws_server.py [host] [port]
"""

import sys

import RNS
from websockets.sync.server import serve


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 0

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

    with serve(handle, host, port, compression=None) as server:
        server_ref["server"] = server
        # The port was chosen by the caller; echo it back as a ready signal.
        print(f"LISTENING {port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
