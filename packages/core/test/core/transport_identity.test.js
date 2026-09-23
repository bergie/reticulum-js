/**
 * Transport-node identity + flag wiring (work doc #23 Phase 0).
 *
 * Verifies the `enableTransport` / `staticTransportIdentity` config flags
 * gate the transport identity the way Python's `Transport.start` does:
 *   - disabled (default) → leaf, no transport identity loaded, `identity` null;
 *   - enabled → persistent transport identity loaded/generated, advertised;
 *   - disabled + staticTransportIdentity → persistent id held in `_identity`
 *     with an ephemeral in `identity` (a leaf never advertises the real id).
 *
 * Python reference: `RNS/Transport.py:293-308` — `Transport.identity` is the
 * advertised id; when transport is disabled but `static_transport_identity`
 * is set, the persistent id is kept in `Transport._identity` and an ephemeral
 * is used for `Transport.identity`.
 */
import assert from "node:assert";
import test from "node:test";

import { Reticulum } from "../../src/core/reticulum.js";
import { MemoryStorageAdapter } from "../../src/storage/storage.js";

test("Reticulum default (leaf) loads no transport identity", async () => {
  const rns = new Reticulum({});
  await rns.transportIdentityLoadPromise;
  assert.strictEqual(rns.transport.transportEnabled, false);
  assert.strictEqual(
    rns.transport.identity,
    null,
    "leaf advertises no transport id",
  );
  assert.strictEqual(rns.transport._identity, null);
});

test("Reticulum({ enableTransport: true }) loads a persistent transport identity", async () => {
  const adapter = new MemoryStorageAdapter();
  const rns = new Reticulum({ enableTransport: true, storageAdapter: adapter });
  await rns.transportIdentityLoadPromise;
  assert.strictEqual(rns.transport.transportEnabled, true);
  assert.ok(rns.transport.identity, "transport identity loaded");
  // The identity was persisted on the dedicated transport-key slot.
  const saved = await adapter.loadTransportKey();
  assert.ok(saved, "transport identity persisted");
  assert.strictEqual(saved.length, 128);
  // The local-identity slot is untouched — the two identities are distinct.
  assert.strictEqual(await adapter.loadKey(), null);
});

test("enableTransport resumes the same transport identity across a restart", async () => {
  // First boot: generates + persists.
  const adapter = new MemoryStorageAdapter();
  const rns1 = new Reticulum({
    enableTransport: true,
    storageAdapter: adapter,
  });
  await rns1.transportIdentityLoadPromise;
  const hash1 = rns1.transport.identity.identityHash;

  // Second boot: loads the same key — the transport_id is stable.
  const rns2 = new Reticulum({
    enableTransport: true,
    storageAdapter: adapter,
  });
  await rns2.transportIdentityLoadPromise;
  assert.ok(
    Buffer.from(rns2.transport.identity.identityHash).equals(
      Buffer.from(hash1),
    ),
    "transport identity is stable across restart",
  );
});

test("enableTransport without a storage adapter uses an ephemeral identity", async () => {
  const rns = new Reticulum({ enableTransport: true });
  await rns.transportIdentityLoadPromise;
  assert.ok(rns.transport.identity, "ephemeral transport identity generated");
  // Nothing to persist against — but the node still has an identity to use.
  assert.strictEqual(rns.transport.identity.identityHash.length, 16);
});

test("staticTransportIdentity (transport disabled) holds the persistent id in _identity with an ephemeral identity", async () => {
  const adapter = new MemoryStorageAdapter();
  const rns = new Reticulum({
    staticTransportIdentity: true,
    storageAdapter: adapter,
  });
  await rns.transportIdentityLoadPromise;
  assert.strictEqual(rns.transport.transportEnabled, false, "still a leaf");
  assert.ok(rns.transport._identity, "persistent transport identity held");
  assert.ok(rns.transport.identity, "ephemeral identity in use");
  assert.ok(
    !Buffer.from(rns.transport.identity.identityHash).equals(
      Buffer.from(rns.transport._identity.identityHash),
    ),
    "the disabled leaf does NOT advertise the persistent transport id",
  );
  // The persistent id is preserved for a future enableTransport toggle.
  const saved = await adapter.loadTransportKey();
  assert.ok(saved, "static transport identity persisted");
});

test("staticTransportIdentity without a storage adapter is a no-op (no persistent id to hold)", async () => {
  const rns = new Reticulum({ staticTransportIdentity: true });
  await rns.transportIdentityLoadPromise;
  assert.strictEqual(rns.transport._identity, null);
  assert.strictEqual(
    rns.transport.identity,
    null,
    "no ephemeral minted without storage",
  );
});

test("staticTransportIdentity is ignored when enableTransport is true", async () => {
  const adapter = new MemoryStorageAdapter();
  const rns = new Reticulum({
    enableTransport: true,
    staticTransportIdentity: true,
    storageAdapter: adapter,
  });
  await rns.transportIdentityLoadPromise;
  assert.strictEqual(rns.transport.transportEnabled, true);
  // enableTransport wins: identity IS the persistent one, _identity stays null.
  assert.ok(rns.transport.identity);
  assert.strictEqual(rns.transport._identity, null);
});

test("a leaf (default) does not touch the transport-key storage slot", async () => {
  const adapter = new MemoryStorageAdapter();
  const rns = new Reticulum({ storageAdapter: adapter });
  await rns.transportIdentityLoadPromise;
  assert.strictEqual(await adapter.loadTransportKey(), null);
  assert.strictEqual(rns.transport.identity, null);
});
