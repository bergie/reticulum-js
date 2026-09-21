#!/usr/bin/env python3
"""Minimal backbone listener for RNS-over-TCP backbone compatibility tests.

Mirrors the Python reference ``BackboneInterface`` at the wire level: it
accepts a backbone connection, unframes the first inbound HDLC frame with
the reference's own unframing logic, verifies/unseals the IFAC when
credentials are given (byte-for-byte the reference ``Transport`` IFAC
inbound path), parses the packet with the Python RNS implementation, and
replies with an independently-constructed RNS packet whose payload is
``b"pong from python"`` (IFAC-sealed via the reference ``Transport.transmit``
path when credentials are given).

This deliberately taps the socket layer instead of spawning a full
``BackboneClientInterface`` (which requires a running transport and Linux
epoll), so the fixture runs anywhere Python does — what is under test is
the wire protocol and the IFAC byte format, which this exercises exactly.

Prints ``LISTENING <port>`` once the listener is up so the JS test harness
knows it is ready.

Usage: backbone_server.py [host] [port] [ifac_netname] [ifac_netkey]
"""

import socket
import sys

import RNS
from RNS.Interfaces.BackboneInterface import (
    BackboneClientInterface,
    BackboneInterface,
    HDLC,
)


def unframe(data):
    """Extracts complete frames from a buffer, using the reference's
    BackboneClientInterface.receive frame logic."""
    frames = []
    frame_buffer = data
    flags_remaining = True
    while flags_remaining:
        frame_start = frame_buffer.find(bytes([HDLC.FLAG]))
        if frame_start != -1:
            frame_end = frame_buffer.find(bytes([HDLC.FLAG]), frame_start + 1)
            if frame_end != -1:
                frame = frame_buffer[frame_start + 1 : frame_end]
                frame = frame.replace(
                    bytes([HDLC.ESC, HDLC.FLAG ^ HDLC.ESC_MASK]),
                    bytes([HDLC.FLAG]),
                )
                frame = frame.replace(
                    bytes([HDLC.ESC, HDLC.ESC ^ HDLC.ESC_MASK]),
                    bytes([HDLC.ESC]),
                )
                frames.append(frame)
                frame_buffer = frame_buffer[frame_end:]
            else:
                flags_remaining = False
        else:
            flags_remaining = False
    return frames


def ifac_unseal(raw, ifac_identity, ifac_key, ifac_size):
    """Reverses the reference Transport.transmit IFAC sealing."""
    assert raw[0] & 0x80 == 0x80, "IFAC flag missing"
    ifac = raw[2 : 2 + ifac_size]
    mask = RNS.Cryptography.hkdf(
        length=len(raw), derive_from=ifac, salt=ifac_key, context=None
    )
    unmasked_raw = b""
    for i, byte in enumerate(raw):
        if i <= 1 or i > ifac_size + 1:
            unmasked_raw += bytes([byte ^ mask[i]])
        else:
            unmasked_raw += bytes([byte])
    new_header = bytes([unmasked_raw[0] & 0x7F, unmasked_raw[1]])
    new_raw = new_header + unmasked_raw[2 + ifac_size :]
    expected_ifac = ifac_identity.sign(new_raw)[-ifac_size:]
    assert ifac == expected_ifac, "IFAC verification failed"
    return new_raw


def ifac_seal(raw, ifac_identity, ifac_key, ifac_size):
    """The reference Transport.transmit IFAC sealing, byte for byte."""
    ifac = ifac_identity.sign(raw)[-ifac_size:]
    mask = RNS.Cryptography.hkdf(
        length=len(raw) + ifac_size, derive_from=ifac, salt=ifac_key, context=None
    )
    new_header = bytes([raw[0] | 0x80, raw[1]])
    new_raw = new_header + ifac + raw[2:]
    masked_raw = b""
    for i, byte in enumerate(new_raw):
        if i == 0:
            masked_raw += bytes([byte ^ mask[i] | 0x80])
        elif i == 1 or i > ifac_size + 1:
            masked_raw += bytes([byte ^ mask[i]])
        else:
            masked_raw += bytes([byte])
    return masked_raw


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    netname = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
    netkey = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "-" else None

    # Derive the same IFAC material the reference derives at interface
    # setup (Reticulum._add_interface / spawned-backbone-client sites).
    ifac_size = 0
    ifac_identity = None
    ifac_key = None
    if netname is not None or netkey is not None:
        ifac_origin = b""
        if netname is not None:
            ifac_origin += RNS.Identity.full_hash(netname.encode("utf-8"))
        if netkey is not None:
            ifac_origin += RNS.Identity.full_hash(netkey.encode("utf-8"))
        ifac_origin_hash = RNS.Identity.full_hash(ifac_origin)
        ifac_key = RNS.Cryptography.hkdf(
            length=64,
            derive_from=ifac_origin_hash,
            salt=RNS.Reticulum.IFAC_SALT,
            context=None,
        )
        ifac_identity = RNS.Identity.from_bytes(ifac_key)
        ifac_size = BackboneClientInterface.DEFAULT_IFAC_SIZE

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(1)
    print(f"LISTENING {server.getsockname()[1]}", flush=True)

    conn, addr = server.accept()
    try:
        data = conn.recv(BackboneInterface.HW_MTU)
        frames = unframe(data)
        assert len(frames) == 1, f"expected one frame, got {len(frames)}"
        raw = frames[0]

        if ifac_identity is not None:
            raw = ifac_unseal(raw, ifac_identity, ifac_key, ifac_size)

        packet = RNS.Packet(destination=None, data=raw)
        if not packet.unpack():
            print("ERROR could not parse packet", flush=True)
            return
        print(f"RECEIVED {packet.data!r}", flush=True)

        dest = RNS.Destination(
            None, RNS.Destination.OUT, RNS.Destination.PLAIN, "test", "echo"
        )
        reply = RNS.Packet(dest, b"pong from python")
        reply.pack()
        reply_raw = reply.raw
        if ifac_identity is not None:
            reply_raw = ifac_seal(reply_raw, ifac_identity, ifac_key, ifac_size)
        conn.sendall(
            bytes([HDLC.FLAG]) + HDLC.escape(reply_raw) + bytes([HDLC.FLAG])
        )
        print(f"SENT {len(reply.raw)} bytes", flush=True)
    finally:
        conn.close()
        server.close()


if __name__ == "__main__":
    main()
