#!/usr/bin/env python3
"""JS → Python propagation-decrypt interop verifier.

Reads a propagation-form `lxmf_data` blob produced by the JavaScript
implementation and decrypts + unpacks it through the Python LXMF reference,
printing whether the recipient could decrypt it and the recovered title/content.

Usage:
    verify_propagation_decrypt.py <recipient_identity_128_hex> <lxmf_data_hex> [out_json]

The 128-byte identity is the JS export layout
([x25519 priv][x25519 pub][ed25519 priv][ed25519 pub]); RNS only wants the
64-byte private key ([x25519 priv][ed25519 priv]).

The propagation form is:

    lxmf_data = destination_hash(16)
              || E_outbound(source_hash(16) || signature(64) || payload)

Only the leading destination hash is cleartext (so a node can route by
recipient); the body is encrypted to the recipient's lxmf.delivery destination.
This script mirrors the decrypt + unpack steps of LXMRouter.lxmf_propagation
(LXMRouter.py), without the propagation-node admission/stamp policy, so it
exercises exactly the bytes under test.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.environ.get("RNS_PY_PATH", ""))

import RNS  # noqa: E402
import LXMF  # noqa: E402


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "usage: verify_propagation_decrypt.py "
            "<recipient_128_hex> <lxmf_data_hex> [out_json]"
        )
        return 2

    recipient_128 = bytes.fromhex(sys.argv[1])
    lxmf_data = bytes.fromhex(sys.argv[2])
    out_json = sys.argv[3] if len(sys.argv) > 3 else None

    # Headless Reticulum with no interfaces (we only need crypto/decode paths).
    cfgdir = tempfile.mkdtemp()
    Path(cfgdir, "config").write_text(
        "[reticulum]\nenable_transport = False\nshare_instance = No\n"
    )
    RNS.Reticulum(configdir=cfgdir, loglevel=RNS.LOG_ERROR)

    # 64-byte private key from the JS 128-byte layout.
    recipient = RNS.Identity.from_bytes(recipient_128[0:32] + recipient_128[64:96])

    # Build the recipient's inbound lxmf.delivery destination exactly as
    # LXMRouter.register_delivery_identity does (IN/SINGLE/lxmf/delivery, with
    # ratchets enabled on a fresh, empty ring -> falls back to the long-term key).
    router = LXMF.LXMRouter(identity=recipient, storagepath=tempfile.mkdtemp())
    delivery_destination = router.register_delivery_identity(recipient)

    destination_hash = lxmf_data[: LXMF.LXMessage.DESTINATION_LENGTH]
    encrypted = lxmf_data[LXMF.LXMessage.DESTINATION_LENGTH :]
    decrypted = delivery_destination.decrypt(encrypted)

    result = {"ok": False}
    if decrypted is not None:
        delivery_data = destination_hash + decrypted
        message = LXMF.LXMessage.unpack_from_bytes(delivery_data)
        result = {
            "ok": True,
            "title": message.title_as_string(),
            "content": message.content_as_string(),
            "hash": message.hash.hex(),
        }

    print(json.dumps(result))
    if out_json:
        with open(out_json, "w") as f:
            json.dump(result, f)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
