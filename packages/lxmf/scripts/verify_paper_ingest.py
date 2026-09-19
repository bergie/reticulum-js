#!/usr/bin/env python3
"""JS → Python paper-message interop verifier.

Reads an `lxm://` URI produced by the JavaScript implementation and ingests it
through the Python LXMF reference's paper-message path, printing whether the
recipient could decrypt and unpack it (and the recovered title/content).

Usage:
    verify_paper_ingest.py <recipient_identity_128_hex> <lxm_uri> [out_json]

The 128-byte identity is the JS export layout
([x25519 priv][x25519 pub][ed25519 priv][ed25519 pub]); RNS only wants the
64-byte private key ([x25519 priv][ed25519 priv]).
"""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.environ.get("RNS_PY_PATH", ""))

import RNS  # noqa: E402
import LXMF  # noqa: E402

RECEIVED = {}


def on_message(message):  # noqa: ANN001
    RECEIVED["title"] = message.title_as_string()
    RECEIVED["content"] = message.content_as_string()
    RECEIVED["hash"] = message.hash.hex()


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: verify_paper_ingest.py <recipient_128_hex> <lxm_uri> [out_json]")
        return 2

    recipient_128 = bytes.fromhex(sys.argv[1])
    uri = sys.argv[2]
    out_json = sys.argv[3] if len(sys.argv) > 3 else None

    # Headless Reticulum with no interfaces (we only need crypto/decode paths).
    cfgdir = tempfile.mkdtemp()
    Path(cfgdir, "config").write_text(
        "[reticulum]\nenable_transport = False\nshare_instance = No\n"
    )
    RNS.Reticulum(configdir=cfgdir, loglevel=RNS.LOG_ERROR)

    recipient = RNS.Identity.from_bytes(recipient_128[0:32] + recipient_128[64:96])

    router = LXMF.LXMRouter(identity=recipient, storagepath=tempfile.mkdtemp())
    router.register_delivery_identity(recipient)
    router.register_delivery_callback(on_message)

    ok = router.ingest_lxm_uri(uri)
    result = {"ok": bool(ok), **RECEIVED}
    print(json.dumps(result))
    if out_json:
        with open(out_json, "w") as f:
            json.dump(result, f)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
