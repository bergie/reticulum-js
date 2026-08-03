/**
 * @file sync.js
 * @description rfed inter-node manifest/gap-pull sync primitives
 *   (work doc #25, Phase 4).
 *
 * Mirrors the Rust `rfed::sync` protocol (SPEC §3/§4):
 *
 *   OFFER       peer → rfed.node   `msgpack [id, …]`            → `msgpack [[ch, id], …]`
 *   MESSAGE_GET peer → rfed.node   `msgpack [id, …]`            → `msgpack bin(blob_stream)`
 *
 * The blob stream (SPEC §3 "MESSAGE_GET Response") is a sequence of records:
 *
 *   channel_hash(16) | message_id(16) | length(4, BE u32) | blob(length)
 *
 * `rfed.node`'s `/rfed/offer` returns the node's **full** store manifest; the
 * caller filters it to channels it has local subscribers for and doesn't already
 * hold (`gapFromPeer`), then `/rfed/get`s those IDs. Blobs transit
 * stamp-stripped (the origin node validated+stripped on first ingest), so sync
 * ingest performs **no** stamp check — it stores under the upstream message id
 * and fans the clean blob out to local subscribers.
 *
 * Pure helpers + codec only; `RFedNode` wires the handlers and the
 * `syncWithPeer` driver.
 */

import { toHex } from "../utils/encoding.js";

/** Record header length: channel_hash(16) + message_id(16) + length(4). */
const RECORD_HEADER_LENGTH = 16 + 16 + 4;

/**
 * Pads or truncates a hash to exactly 16 bytes (rfed hashes are already 16, but
 * the wire format is fixed-width so we defend against short/long inputs).
 *
 * @param {Uint8Array} hash
 * @returns {Uint8Array}
 */
function toFixed16(hash) {
  if (hash.length === 16) return hash;
  const out = new Uint8Array(16);
  out.set(hash.subarray(0, Math.min(hash.length, 16)));
  return out;
}

/**
 * Encodes blob-store records into the §3 wire stream.
 *
 * @param {Array<{ channelHash: Uint8Array, messageId: Uint8Array, blob: Uint8Array }>} records
 * @returns {Uint8Array}
 */
export function encodeBlobStream(records) {
  let total = 0;
  for (const r of records) total += RECORD_HEADER_LENGTH + r.blob.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const r of records) {
    const ch = toFixed16(r.channelHash);
    const id = toFixed16(r.messageId);
    out.set(ch, off);
    off += 16;
    out.set(id, off);
    off += 16;
    const len = r.blob.length;
    // 4-byte big-endian u32 length.
    out[off] = (len >>> 24) & 0xff;
    out[off + 1] = (len >>> 16) & 0xff;
    out[off + 2] = (len >>> 8) & 0xff;
    out[off + 3] = len & 0xff;
    off += 4;
    out.set(r.blob, off);
    off += len;
  }
  return out;
}

/**
 * Decodes a §3 blob stream into records. Stops cleanly on a truncated trailing
 * record (mirrors Rust's `cursor + 36 <= data.len()` guard).
 *
 * @param {Uint8Array} stream
 * @returns {Array<{ channelHash: Uint8Array, messageId: Uint8Array, blob: Uint8Array }>}
 */
export function decodeBlobStream(stream) {
  /** @type {Array<{ channelHash: Uint8Array, messageId: Uint8Array, blob: Uint8Array }>} */
  const records = [];
  let cursor = 0;
  const data =
    stream instanceof Uint8Array ? stream : new Uint8Array(stream ?? []);
  while (cursor + RECORD_HEADER_LENGTH <= data.length) {
    const channelHash = data.subarray(cursor, cursor + 16);
    cursor += 16;
    const messageId = data.subarray(cursor, cursor + 16);
    cursor += 16;
    const len =
      (data[cursor] * 0x1000000 +
        ((data[cursor + 1] << 16) | (data[cursor + 2] << 8) | data[cursor + 3])) >>>
      0;
    cursor += 4;
    if (cursor + len > data.length) break;
    const blob = data.subarray(cursor, cursor + len);
    cursor += len;
    records.push({
      channelHash: new Uint8Array(channelHash),
      messageId: new Uint8Array(messageId),
      blob: new Uint8Array(blob),
    });
  }
  return records;
}

/**
 * Builds the node's **full** store manifest as `[[channelHash, messageId], …]`
 * — the `/rfed/offer` response (Rust `handle_offer`). Unfiltered: a peer may
 * want blobs for channels with no local subscribers on us.
 *
 * @param {import("./blob_store.js").BlobStore} blobStore
 * @returns {Array<[Uint8Array, Uint8Array]>}
 */
export function fullManifest(blobStore) {
  return blobStore.manifest();
}

/**
 * The set of message IDs a node should request from a peer: blobs for channels
 * it has local subscribers for, that it doesn't already hold (Rust
 * `gap_from_peer`).
 *
 * @param {Array<[Uint8Array, Uint8Array]>} peerPairs - Peer manifest `[[ch, id], …]`.
 * @param {import("./blob_store.js").BlobStore} blobStore - Our store (held IDs).
 * @param {Uint8Array[]} subscribedChannelHashes - Channels with local subscribers.
 * @returns {Uint8Array[]}
 */
export function gapFromPeer(peerPairs, blobStore, subscribedChannelHashes) {
  /** @type {Set<string>} */
  const subscribed = new Set(
    subscribedChannelHashes.map((h) => toHex(h)),
  );
  /** @type {Uint8Array[]} */
  const wanted = [];
  const seen = new Set();
  for (const [ch, id] of peerPairs) {
    if (!subscribed.has(toHex(ch))) continue;
    if (blobStore.get(id)) continue; // already held
    const idHex = toHex(id);
    if (seen.has(idHex)) continue;
    seen.add(idHex);
    wanted.push(new Uint8Array(id));
  }
  return wanted;
}
