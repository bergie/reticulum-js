#!/usr/bin/env python3
"""
Generate an RNS 1.6.1 discovery dual-stamp fixture from the Python reference
(RNS/Discovery.py) for the JS parser's transitional acceptance tests.

RNS 1.6.1 discovery validators accept stamps mined against either the
non-expanded or the expanded (InterfaceAnnouncer.WORKBLOCK_EXPAND_ROUNDS)
workblock — the non-expanded workblock is checked first. This script mints
one stamp of each kind over the *same* packed info dict, runs both app_data
blobs through the real Python InterfaceAnnounceHandler to prove the reference
accepts both, and emits the blobs for the JS suite to assert against.

Outputs JSON on stdout describing: the announcing identity (pub key + hash),
the packed info dict, each variant's app_data (hex) and Python-validated
stamp value.

Run: python3 scripts/gen-discovery-stamps-fixture.py > test/fixtures/discovery-stamps-rns161.json
"""
import json
import os
import sys

# Make the vendored reference importable regardless of cwd.
sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "Reticulum"))
)

import RNS
# Force the single-process stamp generator (job_simple). Under Termux,
# platformutils.is_android() is True, which routes the stamper to
# job_android's multiprocessing.Manager path — and that deadlocks here.
# job_simple is the portable fall-back used on Windows/macOS.
RNS.vendor.platformutils.is_android = lambda: False
RNS.vendor.platformutils.is_darwin = lambda: True
RNS.vendor.platformutils.is_windows = lambda: False
# The handler queries RNS.Reticulum.interface_discovery_sources() — a
# classmethod that reads instance state — and RNS.Transport.hops_to(). Stub
# both so validation proceeds without a live Reticulum instance.
RNS.Reticulum.interface_discovery_sources = lambda *a, **k: None
RNS.Transport.hops_to = lambda *a, **k: 0
from RNS.vendor import umsgpack as msgpack
from RNS.Discovery import (
    InterfaceAnnouncer,
    InterfaceAnnounceHandler,
    HEIGHT,
    INTERFACE_TYPE,
    LATITUDE,
    LONGITUDE,
    NAME,
    PORT,
    REACHABLE_ON,
    TRANSPORT,
    TRANSPORT_ID,
)


def build_packed():
    info = {
        INTERFACE_TYPE: "TCPServerInterface",
        TRANSPORT: True,
        TRANSPORT_ID: bytes.fromhex("bf3fc6d179a3bc4bad91f9ac038ecc9e"),
        NAME: "Stamp Mode Node",
        LATITUDE: 51.5074,
        LONGITUDE: -0.1278,
        HEIGHT: 35.0,
        REACHABLE_ON: "stamps.example.reticulum.network",
        PORT: 42424,
    }
    return msgpack.packb(info), info


def validate(handler, app_data, announced_identity, label):
    """Runs the real Python 1.6.1 handler on an app_data blob and asserts it
    is accepted. Returns the stamp value the handler reported."""
    captured = {}

    def cb(info):
        captured.update(info)

    handler.callback = cb
    handler.received_announce(
        destination_hash=bytes(16),
        announced_identity=announced_identity,
        app_data=app_data,
    )
    if not captured:
        raise SystemExit(f"Python handler rejected the {label} stamp — reference behavior mismatch")
    return captured.get("value")


def main():
    RNS.loglevel = RNS.LOG_CRITICAL
    required_value = InterfaceAnnouncer.DEFAULT_STAMP_VALUE

    announced_identity = RNS.Identity(create_keys=True)
    packed, info = build_packed()
    infohash = RNS.Identity.full_hash(packed)

    # Non-expanded stamp (RNS 1.6.1 fast path, expand_rounds=0).
    stamp_ne, _ = RNS.Stamps.generate_stamp(
        infohash, stamp_cost=required_value, expand_rounds=0, size=RNS.Stamps.STAMP_SIZE
    )
    # Expanded stamp (the classic generation path, 20 rounds).
    stamp_ex, _ = RNS.Stamps.generate_stamp(
        infohash,
        stamp_cost=required_value,
        expand_rounds=InterfaceAnnouncer.WORKBLOCK_EXPAND_ROUNDS,
        size=RNS.Stamps.STAMP_SIZE,
    )

    app_data_ne = bytes([0x00]) + packed + stamp_ne
    app_data_ex = bytes([0x00]) + packed + stamp_ex

    handler = InterfaceAnnounceHandler(required_value=required_value)
    value_ne = validate(handler, app_data_ne, announced_identity, "non-expanded")
    value_ex = validate(handler, app_data_ex, announced_identity, "expanded")

    fixture = {
        "_about": (
            "RNS 1.6.1 discovery dual-stamp vectors, generated with the Python"
            " reference implementation. Both stamps are mined over the same"
            " packed info dict: 'nonExpanded' with expand_rounds=0 (the fast"
            " path RNS 1.6.1 validators check first) and 'expanded' with"
            " InterfaceAnnouncer.WORKBLOCK_EXPAND_ROUNDS=20 (the fallback)."
            " The real Python InterfaceAnnounceHandler accepted both, reporting"
            " the recorded values."
        ),
        "required_value": required_value,
        "workblock_expand_rounds": InterfaceAnnouncer.WORKBLOCK_EXPAND_ROUNDS,
        "announced_identity_pub_hex": announced_identity.get_public_key().hex(),
        "announced_identity_hash_hex": announced_identity.hash.hex(),
        "packed_hex": packed.hex(),
        "nonExpanded": {
            "app_data_hex": app_data_ne.hex(),
            "stamp_hex": stamp_ne.hex(),
            "value": value_ne,
        },
        "expanded": {
            "app_data_hex": app_data_ex.hex(),
            "stamp_hex": stamp_ex.hex(),
            "value": value_ex,
        },
        "raw_info": {k: (v.hex() if isinstance(v, bytes) else v) for k, v in info.items()},
    }
    json.dump(fixture, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
