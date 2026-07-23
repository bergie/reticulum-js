/**
 * @file buffer.js
 * @description Web Stream adapters over a {@link Channel} — the JS analog of
 *   Python's `RNS/Buffer.py`.
 *
 * Python exposes byte streams over a Channel as `BufferedReader` /
 * `BufferedWriter` / `BufferedRWPair` (Python file objects). The idiomatic JS
 * replacement is **Web Streams**: `ReadableStream<Uint8Array>` /
 * `WritableStream<Uint8Array>` / a `{ readable, writable }` duplex pair.
 *
 *   - `openReadable(channel, streamId)`  ≈ `Buffer.create_reader`
 *   - `openWritable(channel, streamId)`  ≈ `Buffer.create_writer`
 *   - `openDuplex(channel, rxId, txId)`  ≈ `Buffer.create_bidirectional_buffer`
 *
 * Frames are `StreamDataMessage` (MSGTYPE 0xff00), multiplexed by `stream_id`.
 * Backpressure on the writable side follows the channel's send window; the
 * readable side is a push source (each frame enqueues one chunk) whose flow
 * control is the channel window underneath.
 *
 * Compression mirrors the resource layer: a bz2 module injected on the link
 * (`link.bz2`) is reused here — pass `options.bz2` to override per stream.
 */

import { LogLevel, log } from "../utils/log.js";
import {
  _setStreamAdapters,
  CEType,
  Channel,
  ChannelException,
  MessageBase,
  StreamDataMessage,
} from "./channel.js";

/**
 * Largest single uncompressed chunk the writer will accept from one `write()`
 * (`RNS/Buffer.py` `RawChannelWriter.MAX_CHUNK_LEN`). Also the decompress
 * bound on the reader.
 */
const MAX_CHUNK_LEN = 16384;

/** Compression segment-size probe count (`RawChannelWriter.COMPRESSION_TRIES`). */
const COMPRESSION_TRIES = 4;

/**
 * Resolves the bz2 module to use for a stream: an explicit override, else the
 * one injected on the link (`link.bz2`, shared with Resources).
 * @param {Channel} channel
 * @param {any} [override]
 * @returns {any}
 */
function resolveBz2(channel, override) {
  return override ?? /** @type {any} */ (channel)._link?.bz2 ?? null;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Feeds a `ReadableStream` controller from inbound `StreamDataMessage` frames
 * for one `stream_id`. Internal; use {@link openReadable}.
 */
class ChannelStreamReader {
  /**
   * @param {Channel} channel
   * @param {number} streamId
   * @param {any} bz2
   */
  constructor(channel, streamId, bz2) {
    this._channel = channel;
    this._streamId = streamId;
    this._bz2 = bz2;
    /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
    this._controller = null;
    this._done = false;
    /** @param {MessageBase} msg */
    this._handler = (msg) => this._onMessage(msg);
    channel._registerSystemMessageType(StreamDataMessage);
    channel.addMessageHandler(this._handler);
  }

  /** @param {ReadableStreamDefaultController<Uint8Array>} controller */
  attach(controller) {
    this._controller = controller;
  }

  /** Stop receiving (consumer cancelled the stream). */
  detach() {
    this._done = true;
    this._channel.removeMessageHandler(this._handler);
  }

  /**
   * @param {MessageBase} msg
   * @returns {boolean}
   * @private
   */
  _onMessage(msg) {
    if (
      !(msg instanceof StreamDataMessage) ||
      msg.streamId !== this._streamId
    ) {
      return false;
    }
    if (this._done) return true;
    const c = this._controller;
    if (!c) return true;

    let data = msg.data;
    if (msg.compressed) {
      if (!this._bz2) {
        this._fail(
          c,
          new Error(
            "Received a compressed StreamDataMessage but no bz2 module is available",
          ),
        );
        return true;
      }
      try {
        data = this._bz2.decompress(data, MAX_CHUNK_LEN);
      } catch (err) {
        this._fail(
          c,
          new Error(`StreamDataMessage decompression failed: ${err}`),
        );
        return true;
      }
    }

    if (data.length > 0) {
      try {
        c.enqueue(data);
      } catch (err) {
        // Controller was closed/cancelled by the consumer; stop tracking.
        log("Buffer", `reader enqueue failed: ${err}`, LogLevel.DEBUG);
        this._done = true;
        return true;
      }
    }
    if (msg.eof) {
      this._done = true;
      try {
        c.close();
      } catch (err) {
        log("Buffer", `reader close failed: ${err}`, LogLevel.DEBUG);
      }
    }
    return true;
  }

  /**
   * @param {ReadableStreamDefaultController<Uint8Array>} c
   * @param {Error} err
   * @private
   */
  _fail(c, err) {
    this._done = true;
    try {
      c.error(err);
    } catch (e) {
      log("Buffer", `reader error failed: ${e}`, LogLevel.DEBUG);
    }
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Backs a `WritableStream`: chunks writes into `StreamDataMessage`-sized frames
 * (optionally bz2-compressed) and honors the channel send window. Internal;
 * use {@link openWritable}.
 */
class ChannelStreamWriter {
  /**
   * @param {Channel} channel
   * @param {number} streamId
   * @param {any} bz2
   */
  constructor(channel, streamId, bz2) {
    this._channel = channel;
    this._streamId = streamId;
    this._bz2 = bz2;
    // Max uncompressed data bytes per frame = channel MDU − 2-byte stream header.
    this._maxDataLen = channel.mdu - StreamDataMessage.HEADER_SIZE;
    this._closed = false;
  }

  /**
   * Wait until the channel send window has room (poll, like Python's
   * `RawChannelWriter.close`). Bails if the channel shuts down.
   * @returns {Promise<void>}
   * @private
   */
  async _awaitReady() {
    while (!this._channel.isReadyToSend()) {
      if (this._channel._shutDown) {
        throw new ChannelException(
          CEType.ME_LINK_NOT_READY,
          "channel shut down",
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Send one message, retrying while the window is momentarily full.
   * @param {StreamDataMessage} msg
   * @private
   */
  async _send(msg) {
    for (;;) {
      await this._awaitReady();
      try {
        await this._channel.send(msg);
        return;
      } catch (err) {
        if (
          err instanceof ChannelException &&
          err.type === CEType.ME_LINK_NOT_READY
        ) {
          continue; // window filled between the check and the serialized send
        }
        throw err;
      }
    }
  }

  /**
   * Send one frame's worth of `remaining` (compressed if beneficial) and return
   * how many source bytes were consumed. Ports `RawChannelWriter.write`.
   * @param {Uint8Array} remaining
   * @returns {Promise<number>}
   * @private
   */
  async _writeOne(remaining) {
    const cap = Math.min(remaining.length, MAX_CHUNK_LEN);

    let processedLen = 0;
    /** @type {Uint8Array} */
    let chunk = new Uint8Array(0);
    let compressed = false;

    if (this._bz2 && cap > 32) {
      for (let compTry = 1; compTry < COMPRESSION_TRIES; compTry++) {
        const segmentLength = Math.floor(cap / compTry);
        if (segmentLength <= 32) break;
        let compressedChunk;
        try {
          compressedChunk = this._bz2.compress(
            remaining.subarray(0, segmentLength),
          );
        } catch (err) {
          log("Buffer", `compress failed: ${err}`, LogLevel.DEBUG);
          break;
        }
        if (
          compressedChunk.length < this._maxDataLen &&
          compressedChunk.length < segmentLength
        ) {
          compressed = true;
          chunk = compressedChunk;
          processedLen = segmentLength;
          break;
        }
      }
    }

    if (!compressed) {
      processedLen = Math.min(cap, this._maxDataLen);
      chunk = remaining.subarray(0, processedLen);
    }

    const msg = new StreamDataMessage();
    msg.streamId = this._streamId;
    msg.data = chunk;
    msg.eof = false;
    msg.compressed = compressed;
    await this._send(msg);
    return processedLen;
  }

  /**
   * Write a whole chunk (possibly across several frames).
   * @param {Uint8Array} chunk
   * @returns {Promise<void>}
   */
  async write(chunk) {
    if (this._closed) throw new Error("stream is closed");
    let offset = 0;
    while (offset < chunk.length) {
      const consumed = await this._writeOne(chunk.subarray(offset));
      offset += consumed;
      if (consumed === 0) break; // defensive; _writeOne always sends ≥1 byte
    }
  }

  /** Send the terminal `eof` frame (empty data, eof=true). */
  async close() {
    if (this._closed) return;
    this._closed = true;
    const msg = new StreamDataMessage();
    msg.streamId = this._streamId;
    msg.data = new Uint8Array(0);
    msg.eof = true;
    msg.compressed = false;
    await this._send(msg);
  }
}

// ---------------------------------------------------------------------------
// Public adapter factories
// ---------------------------------------------------------------------------

/**
 * Open a `ReadableStream<Uint8Array>` that receives byte-stream frames
 * addressed to `streamId`. See {@link Channel#openReadable}.
 * @param {Channel} channel
 * @param {number} streamId
 * @param {{ bz2?: any }} [options]
 * @returns {ReadableStream<Uint8Array>}
 */
export function openReadable(channel, streamId, options = {}) {
  const bz2 = resolveBz2(channel, options.bz2);
  const reader = new ChannelStreamReader(channel, streamId, bz2);
  return new ReadableStream({
    start(controller) {
      reader.attach(controller);
    },
    cancel() {
      reader.detach();
    },
  });
}

/**
 * Open a `WritableStream<Uint8Array>` that sends byte-stream frames to the
 * peer's `streamId`. See {@link Channel#openWritable}.
 * @param {Channel} channel
 * @param {number} streamId
 * @param {{ bz2?: any }} [options]
 * @returns {WritableStream<Uint8Array>}
 */
export function openWritable(channel, streamId, options = {}) {
  const bz2 = resolveBz2(channel, options.bz2);
  const writer = new ChannelStreamWriter(channel, streamId, bz2);
  return new WritableStream({
    async write(chunk) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("WritableStream chunk must be a Uint8Array");
      }
      await writer.write(chunk);
    },
    async close() {
      await writer.close();
    },
    abort() {
      // Producer aborted: stop locally. The protocol has no abort frame, so the
      // peer only learns via link teardown / its own read timeout.
      writer._closed = true;
    },
  });
}

/**
 * Open a duplex `{ readable, writable }` pair: `readable` receives
 * `receiveStreamId`, `writable` sends `sendStreamId`. See
 * {@link Channel#openDuplex}.
 * @param {Channel} channel
 * @param {number} receiveStreamId
 * @param {number} sendStreamId
 * @param {{ bz2?: any }} [options]
 * @returns {{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> }}
 */
export function openDuplex(
  channel,
  receiveStreamId,
  sendStreamId,
  options = {},
) {
  return {
    readable: openReadable(channel, receiveStreamId, options),
    writable: openWritable(channel, sendStreamId, options),
  };
}

// Wire the adapters into Channel.prototype's openReadable/openWritable/
// openDuplex (declared in channel.js) without a static module cycle.
_setStreamAdapters({ openReadable, openWritable, openDuplex });
