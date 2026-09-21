#!/usr/bin/env python3
"""Real Python reference ``BackboneInterface`` for backbone interop tests.

Unlike ``backbone_server.py`` (which re-implements the wire protocol so it
runs on any OS), this fixture instantiates the **real**
``RNS.Interfaces.BackboneInterface`` listener on a minimal but fully started
Reticulum instance, so the epoll machinery, spawned-interface derivation,
HDLC framing and IFAC handling all run end to end. The real class needs
Linux (``select.epoll``); the JS tests gate on epoll availability and skip
elsewhere (e.g. macOS dev machines). CI's ubuntu runners execute this path.

The first packet arriving on a spawned client interface is decoded by the
reference's inbound path and answered on the same interface with an
independently-constructed RNS packet whose payload is ``b"pong from python"``
(sent via ``RNS.Transport.transmit``, so the reference's own IFAC sealing
applies when credentials are configured).

Prints ``LISTENING <port>`` once the listener is up so the JS test harness
knows it is ready.

Usage: backbone_real_server.py [host] [port] [ifac_netname] [ifac_netkey]
"""

import sys
import tempfile
import time

import RNS
from RNS.Interfaces.BackboneInterface import BackboneInterface


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    netname = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
    netkey = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "-" else None

    # Minimal but fully started Reticulum: Transport.start() runs, so the
    # spawned BackboneClientInterface's inbound path (owner.inbound) works.
    configdir = tempfile.mkdtemp(prefix="rns-backbone-real-fixture-")
    reticulum = RNS.Reticulum(configdir=configdir, loglevel=RNS.LOG_ERRORS)

    config = {
        "name": "backbone-fixture",
        "listen_ip": host,
        "listen_port": str(port),
    }

    # The reference node setup passes RNS.Transport as the owner
    # (Reticulum.py:1026); the real class registers spawned client
    # interfaces with the global Transport itself.
    interface = BackboneInterface(RNS.Transport, config)

    # Mirror the node setup's interface_post_init for the IFAC attributes
    # (Reticulum.py:986-1004): the listener carries the derived key, and
    # incoming_connection propagates it to every spawned client.
    if netname is not None or netkey is not None:
        interface.ifac_size = BackboneInterface.DEFAULT_IFAC_SIZE
        interface.ifac_netname = netname
        interface.ifac_netkey = netkey
        ifac_origin = b""
        if netname is not None:
            ifac_origin += RNS.Identity.full_hash(netname.encode("utf-8"))
        if netkey is not None:
            ifac_origin += RNS.Identity.full_hash(netkey.encode("utf-8"))
        ifac_origin_hash = RNS.Identity.full_hash(ifac_origin)
        interface.ifac_key = RNS.Cryptography.hkdf(
            length=64,
            derive_from=ifac_origin_hash,
            salt=RNS.Reticulum.IFAC_SALT,
            context=None,
        )
        interface.ifac_identity = RNS.Identity.from_bytes(interface.ifac_key)
        interface.ifac_signature = interface.ifac_identity.sign(
            RNS.Identity.full_hash(interface.ifac_key)
        )

    # Tap the first inbound packet per spawned interface and answer it on
    # the same interface. Wrapping Transport.inbound keeps the reference's
    # full inbound pipeline (IFAC unsealing, packet parsing) in the loop;
    # the reply rides Transport.transmit, i.e. the reference's own IFAC
    # sealing.
    answered = set()
    original_inbound = RNS.Transport.inbound.__func__

    def inbound(raw, interface=None, tc=None, ifac_handled=False):
        if interface is not None and hasattr(interface, "spawned_at"):
            key = id(interface)
            if key not in answered:
                answered.add(key)
                packet = RNS.Packet(None, raw)
                if packet.unpack():
                    print(f"RECEIVED {packet.data!r}", flush=True)
                    dest = RNS.Destination(
                        None,
                        RNS.Destination.OUT,
                        RNS.Destination.PLAIN,
                        "test",
                        "echo",
                    )
                    reply = RNS.Packet(dest, b"pong from python")
                    reply.pack()
                    RNS.Transport.transmit(interface, reply.raw)
                    print(f"SENT {len(reply.raw)} bytes", flush=True)

    RNS.Transport.inbound = staticmethod(inbound)

    print(f"LISTENING {interface.bind_port}", flush=True)

    # Keep the process alive; the shared epoll job thread does the I/O.
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        RNS.Transport.inbound = staticmethod(original_inbound)
        interface.detach()


if __name__ == "__main__":
    main()
