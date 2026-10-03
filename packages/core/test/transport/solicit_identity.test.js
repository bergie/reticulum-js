import assert from "node:assert";
import test from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType } from "../../src/core/packet.js";
import { Reticulum } from "../../src/core/reticulum.js";
import { MemoryStorageAdapter } from "../../src/storage/storage.js";
import {
  TransportCore,
  UnknownIdentityError,
} from "../../src/transport/transport.js";
import { toHex } from "../../src/utils/encoding.js";

test("recallOrSolicitIdentity returns already known identity immediately", async () => {
  const transport = new TransportCore();
  const identity = await Identity.generate();
  const dest = await Destination.OUT("test.app", DestType.SINGLE, identity, {
    transport,
  });

  await transport.rememberIdentity(
    new Uint8Array(32),
    dest.destinationHash,
    identity.publicKey,
  );

  const recalled = await transport.recallOrSolicitIdentity(
    dest.destinationHash,
    1000,
  );
  assert.ok(recalled);
  assert.deepStrictEqual(recalled.publicKey, identity.publicKey);
});

test("recallOrSolicitIdentity solicits via path request and resolves on announce", async () => {
  const transport = new TransportCore();
  const identity = await Identity.generate();
  const destHash = new Uint8Array(16).fill(0x42);

  let pathRequestedWith = null;
  transport.requestPath = async (dh) => {
    pathRequestedWith = dh;
    // Simulate delayed announce arriving in response to path request
    setTimeout(async () => {
      await transport.rememberIdentity(
        new Uint8Array(32),
        destHash,
        identity.publicKey,
      );
      transport.dispatchEvent(
        new CustomEvent("announce", {
          detail: {
            destinationHash: destHash,
            identity,
          },
        }),
      );
    }, 20);
  };

  const recalled = await transport.recallOrSolicitIdentity(destHash, 1000);
  assert.ok(recalled);
  assert.deepStrictEqual(recalled.publicKey, identity.publicKey);
  assert.deepStrictEqual(pathRequestedWith, destHash);
});

test("recallOrSolicitIdentity throws UnknownIdentityError on timeout", async () => {
  const transport = new TransportCore();
  const destHash = new Uint8Array(16).fill(0x99);

  transport.requestPath = async () => {};

  await assert.rejects(
    async () => {
      await transport.recallOrSolicitIdentity(destHash, 50);
    },
    (err) => {
      assert.ok(err instanceof UnknownIdentityError);
      assert.deepStrictEqual(err.destinationHash, destHash);
      assert.match(err.message, new RegExp(toHex(destHash)));
      return true;
    },
  );
});

test("recallOrSolicitIdentity dedupes concurrent calls for the same destination hash", async () => {
  const transport = new TransportCore();
  const identity = await Identity.generate();
  const destHash = new Uint8Array(16).fill(0x77);

  let prCount = 0;
  transport.requestPath = async () => {
    prCount++;
    setTimeout(async () => {
      await transport.rememberIdentity(
        new Uint8Array(32),
        destHash,
        identity.publicKey,
      );
      transport.dispatchEvent(
        new CustomEvent("announce", {
          detail: {
            destinationHash: destHash,
            identity,
          },
        }),
      );
    }, 20);
  };

  const [res1, res2] = await Promise.all([
    transport.recallOrSolicitIdentity(destHash, 1000),
    transport.recallOrSolicitIdentity(destHash, 1000),
  ]);

  assert.strictEqual(
    prCount,
    1,
    "path request should be sent only once for concurrent solicitations",
  );
  assert.deepStrictEqual(res1.publicKey, identity.publicKey);
  assert.deepStrictEqual(res2.publicKey, identity.publicKey);
});

test("rns.ready() awaits persistor hydration", async () => {
  const adapter = new MemoryStorageAdapter();
  const rns = new Reticulum({ storageAdapter: adapter });
  let readyDone = false;
  const p = rns.ready().then(() => {
    readyDone = true;
  });
  await p;
  assert.strictEqual(readyDone, true);
  assert.strictEqual(rns.persistor.loaded, true);
});

test("recallIdentity awaits persistor hydration if load is pending", async () => {
  const adapter = new MemoryStorageAdapter();
  const identity = await Identity.generate();
  const destHash = new Uint8Array(16).fill(0x33);

  // Pre-seed storage with an identity
  const entry = [
    Date.now() / 1000,
    new Uint8Array(32),
    identity.publicKey,
    null,
  ];
  const { MicroMsgPack } = await import("../../src/utils/msgpack.js");
  const { StorageNamespace } = await import("../../src/storage/storage.js");
  await adapter.set(
    StorageNamespace.IDENTITIES,
    toHex(destHash),
    MicroMsgPack.encode(entry),
  );

  const rns = new Reticulum({ storageAdapter: adapter });
  // Call recallIdentity immediately without manually awaiting persistorLoadPromise
  const recalled = await rns.transport.recallIdentity(destHash);
  assert.ok(recalled);
  assert.deepStrictEqual(recalled.publicKey, identity.publicKey);
});
