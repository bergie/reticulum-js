#!/usr/bin/env python3
"""
Generate a discovery announce app_data fixture from the Python reference
(RNS/Discovery.py) so the JS parser can be verified byte-for-byte compatible.

Outputs JSON on stdout describing: the announcing identity (private+pub keys),
the network identity, the raw app_data (hex), and the expected parsed info.

Run: python3 scripts/gen-discovery-fixture.py
"""
import json
import os
import sys

import RNS
# Force the single-process stamp generator (job_simple). Under Termux,
# platformutils.is_android() is True, which routes LXStamper to job_android's
# multiprocessing.Manager path — and that deadlocks here. job_simple is the
# portable fall-back used on Windows/macOS.
RNS.vendor.platformutils.is_android = lambda: False
RNS.vendor.platformutils.is_darwin = lambda: True
RNS.vendor.platformutils.is_windows = lambda: False
# The handler queries RNS.Reticulum.interface_discovery_sources() — a classmethod
# that reads instance state, so it throws without a live Reticulum. Stub it to
# None (no source allow-list) so the handler proceeds to stamp validation.
RNS.Reticulum.interface_discovery_sources = lambda *a, **k: None
from RNS.vendor import umsgpack as msgpack
from RNS.Discovery import (
    InterfaceAnnouncer,
    InterfaceAnnounceHandler,
    APP_NAME,
    NAME,
    TRANSPORT_ID,
    INTERFACE_TYPE,
    TRANSPORT,
    REACHABLE_ON,
    LATITUDE,
    LONGITUDE,
    HEIGHT,
    PORT,
    IFAC_NETNAME,
)


def build_app_data(interface_type, transport_id, name, reachable_on, port,
                   latitude=None, longitude=None, height=None,
                   stamp_value=InterfaceAnnouncer.DEFAULT_STAMP_VALUE):
    info = {
        INTERFACE_TYPE: interface_type,
        TRANSPORT: True,
        TRANSPORT_ID: transport_id,
        NAME: name,
        LATITUDE: latitude,
        LONGITUDE: longitude,
        HEIGHT: height,
        REACHABLE_ON: reachable_on,
        PORT: port,
    }
    packed = msgpack.packb(info)
    infohash = RNS.Identity.full_hash(packed)
    from LXMF import LXStamper
    stamp, value = LXStamper.generate_stamp(infohash, stamp_cost=stamp_value,
                                            expand_rounds=InterfaceAnnouncer.WORKBLOCK_EXPAND_ROUNDS)
    payload = packed + stamp
    flags = 0x00
    out = bytes([flags]) + payload
    # Pre-compute what the Python handler would parse it into.
    handler = InterfaceAnnounceHandler(required_value=stamp_value)
    return out, info, value, stamp


def main():
    RNS.loglevel = RNS.LOG_CRITICAL
    # A deterministic transport identity for the fixture.
    transport_identity = RNS.Identity(create_keys=True)
    transport_id_hash = transport_identity.hash  # 16 bytes

    # The "announced identity" — the identity the announce destination is
    # built from (Python: discovery_destination's identity). For a fixture we
    # use a separate identity so we can assert network_id != transport_id.
    announced_identity = RNS.Identity(create_keys=True)

    app_data, info, value, stamp = build_app_data(
        interface_type="TCPServerInterface",
        transport_id=transport_id_hash,
        name="Example Node",
        reachable_on="example.reticulum.network",
        port=42424,
        latitude=51.5074,
        longitude=-0.1278,
        height=35.0,
    )

    # Re-run the handler's validation/parsing to capture the canonical
    # normalized info Python produces (sanitized name, config_entry, etc.).
    captured = {}
    def cb(info):
        captured.update(info)
    handler = InterfaceAnnounceHandler(required_value=InterfaceAnnouncer.DEFAULT_STAMP_VALUE, callback=cb)
    # Python handler expects announced_identity.hash; transport.hops_to is N/A.
    handler.received_announce(destination_hash=bytes(16), announced_identity=announced_identity, app_data=app_data)

    # Serialize keys for the JS side to reconstruct the Identity.
    pub = announced_identity.get_public_key()  # 64-byte concatenated X+Ed? Actually just Ed25519 pub here.

    fixture = {
        "interface_type": "TCPServerInterface",
        "app_data_hex": app_data.hex(),
        "announced_identity_pub_hex": pub.hex(),
        "announced_identity_hash_hex": announced_identity.hash.hex(),
        "transport_id_hex": transport_id_hash.hex(),
        "raw_info": {k: (v.hex() if isinstance(v, bytes) else v) for k, v in info.items()},
        "stamp_value": value,
        "required_value": InterfaceAnnouncer.DEFAULT_STAMP_VALUE,
        "workblock_expand_rounds": InterfaceAnnouncer.WORKBLOCK_EXPAND_ROUNDS,
        "parsed": serialize_parsed(captured),
    }
    json.dump(fixture, sys.stdout, indent=2)
    sys.stdout.write("\n")


def serialize_parsed(info):
    out = {}
    for k, v in info.items():
        if isinstance(v, bytes):
            out[k] = {"__bytes_hex__": v.hex()}
        else:
            out[k] = v
    return out


if __name__ == "__main__":
    main()
