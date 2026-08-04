/**
 * rfed peer-sync primitives (work doc #25, Phase 4).
 *
 * Unit-tests the §3 blob-stream codec and the manifest/gap helpers against the
 * Rust `rfed::sync` semantics (`encode/decodeBlobStream`, `fullManifest`,
 * `gapFromPeer`). End-to-end peer sync (OFFER→GET→ingest over a loopback mesh)
 * is covered in `node.test.js`.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { BlobStore } from "../../src/rfed/blob_store.js";
import {
  decodeBlobStream,
  encodeBlobStream,
  fullManifest,
  gapFromPeer,
} from "../../src/rfed/sync.js";
import { toHex } from "../../src/utils/encoding.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

describe("rfed sync — §3 blob-stream codec", () => {
  test("round-trips a single record", () => {
    const ch = rnd(16);
    const id = rnd(16);
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = encodeBlobStream([{ channelHash: ch, messageId: id, blob }]);
    // 16 + 16 + 4 + 5 = 41 bytes.
    assert.strictEqual(stream.length, 41);

    const [rec] = decodeBlobStream(stream);
    assert.strictEqual(toHex(rec.channelHash), toHex(ch));
    assert.strictEqual(toHex(rec.messageId), toHex(id));
    assert.strictEqual(toHex(rec.blob), toHex(blob));
  });

  test("round-trips multiple records of varying length", () => {
    const records = [
      { channelHash: rnd(16), messageId: rnd(16), blob: rnd(1) },
      { channelHash: rnd(16), messageId: rnd(16), blob: rnd(64) },
      { channelHash: rnd(16), messageId: rnd(16), blob: rnd(1000) },
    ];
    const decoded = decodeBlobStream(encodeBlobStream(records));
    assert.strictEqual(decoded.length, 3);
    for (let i = 0; i < records.length; i++) {
      assert.strictEqual(
        toHex(decoded[i].channelHash),
        toHex(records[i].channelHash),
      );
      assert.strictEqual(
        toHex(decoded[i].messageId),
        toHex(records[i].messageId),
      );
      assert.strictEqual(toHex(decoded[i].blob), toHex(records[i].blob));
    }
  });

  test("empty record list encodes to zero bytes", () => {
    assert.strictEqual(encodeBlobStream([]).length, 0);
    assert.strictEqual(decodeBlobStream(new Uint8Array(0)).length, 0);
  });

  test("ignores a truncated trailing record", () => {
    const ch = rnd(16);
    const id = rnd(16);
    const blob = new Uint8Array([9, 9, 9]);
    const stream = encodeBlobStream([{ channelHash: ch, messageId: id, blob }]);
    // Cut the blob short — the header claims 3 bytes but only 1 remains.
    const truncated = stream.subarray(0, stream.length - 2);
    const decoded = decodeBlobStream(truncated);
    assert.strictEqual(decoded.length, 0); // whole record dropped
  });

  test("pads short hashes to the fixed 16-byte width", () => {
    const shortCh = new Uint8Array([0xaa]); // 1 byte, not 16
    const id = rnd(16);
    const blob = new Uint8Array([7]);
    const stream = encodeBlobStream([
      { channelHash: shortCh, messageId: id, blob },
    ]);
    const [rec] = decodeBlobStream(stream);
    assert.strictEqual(rec.channelHash.length, 16);
    assert.strictEqual(rec.channelHash[0], 0xaa);
    assert.strictEqual(rec.channelHash[15], 0); // zero-padded
  });
});

describe("rfed sync — manifest + gap helpers", () => {
  test("fullManifest lists every stored (channel, id) pair", () => {
    const store = new BlobStore();
    const chA = rnd(16);
    const chB = rnd(16);
    const id1 = store.store(chA, rnd(8));
    const id2 = store.store(chA, rnd(8));
    const id3 = store.store(chB, rnd(8));

    const manifest = fullManifest(store);
    assert.strictEqual(manifest.length, 3);
    const chans = new Set(manifest.map(([ch]) => toHex(ch)));
    assert.ok(chans.has(toHex(chA)));
    assert.ok(chans.has(toHex(chB)));
    const ids = new Set(manifest.map(([, id]) => toHex(id)));
    assert.ok(ids.has(toHex(id1)));
    assert.ok(ids.has(toHex(id2)));
    assert.ok(ids.has(toHex(id3)));
  });

  test("gapFromPeer keeps subscribed channels, drops held + non-subscribed", () => {
    const store = new BlobStore();
    const subCh = rnd(16); // a channel we subscribe to
    const otherCh = rnd(16); // a channel we do NOT subscribe to
    const heldId = store.store(subCh, rnd(8)); // already have this one
    const newId = rnd(16); // missing, subscribed → wanted
    const otherId = rnd(16); // missing, NOT subscribed → dropped

    const peerPairs = [
      [subCh, heldId],
      [subCh, newId],
      [otherCh, otherId],
    ];
    const wanted = gapFromPeer(peerPairs, store, [subCh]);
    assert.strictEqual(wanted.length, 1);
    assert.strictEqual(toHex(wanted[0]), toHex(newId));
  });

  test("gapFromPeer dedupes identical IDs across channels", () => {
    const store = new BlobStore();
    const ch = rnd(16);
    const dupId = rnd(16);
    // Same id offered under two subscribed channels → requested once.
    const wanted = gapFromPeer(
      [
        [ch, dupId],
        [ch, dupId],
      ],
      store,
      [ch],
    );
    assert.strictEqual(wanted.length, 1);
    assert.strictEqual(toHex(wanted[0]), toHex(dupId));
  });

  test("gapFromPeer is empty when subscribed to nothing", () => {
    const store = new BlobStore();
    const ch = rnd(16);
    store.store(ch, rnd(8));
    const wanted = gapFromPeer([[ch, rnd(16)]], store, []);
    assert.strictEqual(wanted.length, 0);
  });
});
