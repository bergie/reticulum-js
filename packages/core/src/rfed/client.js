/**
 * @file client.js
 * @description rfed channel client — subscribe, publish, receive, and pull
 *   against a rfed federation node (work doc #25, Phase 1).
 *
 * Speaks the modern split rfed destinations (`RFed/SPEC.md` §2), all sharing
 * the node's single identity:
 *
 *   - `rfed.channel.subscribe` — `/rfed/subscribe` request (caches stamp cost)
 *   - `rfed.channel.publish`   — fire-and-forget DATA SEND (wrapped Phase-0 blob)
 *   - `rfed.channel.pull`      — `/rfed/pull` paging (caller-identified)
 *
 * Delivery arrives on the client's own inbound `rfed.delivery` destination as a
 * fanout payload `[ channel_hash(16) ‖ inner_blob ]`, which is split and fed to
 * the Phase-0 {@link unwrapChannelMessage}.
 *
 * The client is transport-agnostic: it only needs a Reticulum instance whose
 * transport routes Single-destination packets and whose known-destinations
 * cache has the node's identity recalled (e.g. after hearing its announce).
 */

import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { ContextType, DestType, Packet, PacketType } from "../core/packet.js";
import { Message } from "../lxmf/message.js";
import { MicroMsgPack } from "../utils/msgpack.js";
import { toHex } from "../utils/encoding.js";
import {
  parseFanoutPayload,
  unwrapChannelMessage,
  wrapChannelMessage,
} from "./blob.js";
import { deliveryHashFor, deriveChannel } from "./channel.js";

/** `/rfed/subscribe` request path. */
const SUBSCRIBE_PATH = "/rfed/subscribe";
/** `/rfed/unsubscribe` request path. */
const UNSUBSCRIBE_PATH = "/rfed/unsubscribe";
/** `/rfed/pull` request path. */
const PULL_PATH = "/rfed/pull";
/** `/rfed/notify/*` registration paths (SPEC §9.1). */
const NOTIFY_REGISTER_PATH = "/rfed/notify/register";
const NOTIFY_UNREGISTER_PATH = "/rfed/notify/unregister";
const NOTIFY_CLEAR_PATH = "/rfed/notify/clear";

/** Modern split rfed destination names (SPEC §2). Share the node identity. */
const CHANNEL_SUBSCRIBE_NAME = "rfed.channel.subscribe";
const CHANNEL_UNSUBSCRIBE_NAME = "rfed.channel.unsubscribe";
const CHANNEL_PUBLISH_NAME = "rfed.channel.publish";
const CHANNEL_PULL_NAME = "rfed.channel.pull";
/** The client's own inbound delivery destination name. */
const DELIVERY_NAME = "rfed.delivery";
/** Split notify registration destination names (SPEC §2). */
const NOTIFY_REGISTER_NAME = "rfed.notify.register";
const NOTIFY_UNREGISTER_NAME = "rfed.notify.unregister";
const NOTIFY_LEGACY_NAME = "rfed.notify";

/**
 * Builds the msgpack `[bin(16) channel_hash, bin(64) pubkey, bin(64) sig]`
 * subscribe/unsubscribe payload, signing the channel hash with the subscriber
 * identity. Matches the Rust `verify_signed_payload` contract.
 *
 * @param {Identity} identity
 * @param {Uint8Array} channelHash
 * @returns {Promise<[Uint8Array, Uint8Array, Uint8Array]>}
 */
async function signedChannelPayload(identity, channelHash) {
  const pubkey = await identity.getPublicKey();
  const sig = await identity.sign(channelHash);
  return [channelHash, pubkey, sig];
}

/**
 * Builds the msgpack `[bin(value), bin(64) pubkey, bin(64) sig]` signed payload
 * for an arbitrary signed value (used by notify register/unregister/clear).
 * The signature is over `value` (the raw command msgpack bytes). Matches the
 * Rust `verify_signed_payload` contract.
 *
 * @param {Identity} identity
 * @param {Uint8Array} value
 * @returns {Promise<[Uint8Array, Uint8Array, Uint8Array]>}
 */
async function signedValuePayload(identity, value) {
  const pubkey = await identity.getPublicKey();
  const sig = await identity.sign(value);
  return [value, pubkey, sig];
}

/**
 * Decodes a `/rfed/subscribe` response into `{ ok, stampCost }`.
 *
 * The wire form is `msgpack [bool ok, uint stamp_cost | nil]`; `Some(0)` and
 * `nil` both mean stamping is disabled.
 *
 * @param {any} response
 * @returns {{ ok: boolean, stampCost: number|null }}
 */
function decodeSubscribeResponse(response) {
  if (Array.isArray(response)) {
    return { ok: response[0] === true, stampCost: response[1] ?? null };
  }
  // Legacy nodes reply with a bare boolean.
  return { ok: response === true, stampCost: null };
}

/**
 * A rfed channel client.
 */
export class RFedClient {
  /**
   * @param {Object} opts
   * @param {Identity} opts.identity - The subscriber's Identity; owns the
   *   `rfed.delivery` destination that receives fanout.
   * @param {any} opts.rns - The Reticulum instance used as the destinations'
   *   interface layer (its `.transport` routes packets).
   */
  constructor({ identity, rns }) {
    this.identity = identity;
    this.rns = rns;

    /** Cached channel derivations: channel name → derivation entry. */
    this.channels = new Map();
    /** Cached advertised stamp costs: hex(channelHash) → cost (or null). */
    this.stampCosts = new Map();

    /** The inbound `rfed.delivery` destination, once {@link listen} is called. */
    this.deliveryDest = null;
    /**
     * Callback invoked for each decoded fanout message.
     *
     * @type {((decoded: any) => void)|null}
     */
    this.onMessage = null;
  }

  /**
   * Resolves (and caches) a channel's derived identity and hashes.
   * @param {string} name
   * @returns {Promise<{ identity: Identity, channelHash: Uint8Array, deliveryHash: Uint8Array }>}
   * @private
   */
  async _channel(name) {
    const cached = this.channels.get(name);
    if (cached) return cached;
    const { identity, channelHash } = await deriveChannel(name);
    const entry = {
      identity,
      channelHash,
      deliveryHash: await deliveryHashFor(identity),
    };
    this.channels.set(name, entry);
    return entry;
  }

  /**
   * Looks up a cached channel derivation by its channel hash (used on the
   * receive path to find the keys for a fanout payload).
   * @param {Uint8Array} channelHash
   * @returns {{ identity: Identity, channelHash: Uint8Array, deliveryHash: Uint8Array, name: string }|null}
   * @private
   */
  _channelByHash(channelHash) {
    for (const [name, entry] of this.channels) {
      if (toHex(entry.channelHash) === toHex(channelHash)) {
        return { ...entry, name };
      }
    }
    return null;
  }

  /**
   * Recalls the node's shared identity from any of its destination hashes.
   * @param {Uint8Array} nodeHash
   * @returns {Promise<Identity>}
   * @private
   */
  async _nodeIdentity(nodeHash) {
    const id = await Destination.recall(nodeHash);
    if (!id) {
      throw new Error(
        `rfed node identity unknown for ${toHex(nodeHash)}; wait for its announce`,
      );
    }
    return id;
  }

  /**
   * Subscribes to a channel on a node and caches the advertised PoW stamp cost.
   *
   * Opens a link to the node's `rfed.channel.subscribe` destination, identifies
   * as the subscriber, and sends `/rfed/subscribe` with the signed channel
   * hash. Re-subscribing refreshes the cached stamp cost — do this at least once
   * per session and after any publish rejection.
   *
   * @param {Uint8Array} nodeHash - Any `rfed.*` destination hash of the node
   *   (they all share one identity).
   * @param {string} channelName
   * @returns {Promise<{ ok: boolean, stampCost: number|null }>}
   */
  async subscribe(nodeHash, channelName) {
    const { channelHash } = await this._channel(channelName);
    const nodeIdentity = await this._nodeIdentity(nodeHash);

    const payload = await signedChannelPayload(this.identity, channelHash);
    const dest = await Destination.OUT(
      CHANNEL_SUBSCRIBE_NAME,
      DestType.SINGLE,
      nodeIdentity,
      this.rns,
    );
    const link = await dest.createLink();
    await link.identify(this.identity);
    const response = await link.request(SUBSCRIBE_PATH, payload);
    const decoded = decodeSubscribeResponse(response);
    if (decoded.ok) {
      this.stampCosts.set(toHex(channelHash), decoded.stampCost);
    }
    return decoded;
  }

  /**
   * Removes a subscription. Same payload shape as {@link subscribe}.
   *
   * @param {Uint8Array} nodeHash
   * @param {string} channelName
   * @returns {Promise<{ ok: boolean }>}
   */
  async unsubscribe(nodeHash, channelName) {
    const { channelHash } = await this._channel(channelName);
    const nodeIdentity = await this._nodeIdentity(nodeHash);

    const payload = await signedChannelPayload(this.identity, channelHash);
    const dest = await Destination.OUT(
      CHANNEL_UNSUBSCRIBE_NAME,
      DestType.SINGLE,
      nodeIdentity,
      this.rns,
    );
    const link = await dest.createLink();
    await link.identify(this.identity);
    const response = await link.request(UNSUBSCRIBE_PATH, payload);
    return {
      ok: Array.isArray(response) ? response[0] === true : response === true,
    };
  }

  /**
   * Publishes a message to a channel (fire-and-forget SEND).
   *
   * Wraps the LXMF message with the Phase-0 codec using the cached stamp cost
   * (from the last {@link subscribe}) and sends it as an encrypted DATA packet
   * to the node's `rfed.channel.publish` destination. If no stamp cost is
   * cached, the message is sent without a stamp.
   *
   * SEND is fire-and-forget — there is no acceptance response. Call
   * {@link subscribe} again to refresh the stamp cost if publishes seem to be
   * dropped (the node silently rejects under-stamped blobs).
   *
   * @param {Uint8Array} nodeHash
   * @param {string} channelName
   * @param {Message} lxmMessage
   * @returns {Promise<void>}
   */
  async publish(nodeHash, channelName, lxmMessage) {
    const channel = await this._channel(channelName);
    const nodeIdentity = await this._nodeIdentity(nodeHash);
    const senderDeliveryHash = await deliveryHashFor(this.identity);

    const stampCost = this.stampCosts.get(toHex(channel.channelHash)) ?? null;
    const { rfedPayload } = await wrapChannelMessage({
      channelIdentity: channel.identity,
      senderIdentity: this.identity,
      senderLxmDeliveryHash: senderDeliveryHash,
      lxmMessage,
      stampCost,
    });

    const dest = await Destination.OUT(
      CHANNEL_PUBLISH_NAME,
      DestType.SINGLE,
      nodeIdentity,
      this.rns,
    );
    const packet = new Packet({
      packetType: PacketType.DATA,
      contextFlag: true,
      contextByte: ContextType.NONE,
      destinationType: DestType.SINGLE,
      destinationHash: /** @type {Uint8Array} */ (dest.destinationHash),
      payload: rfedPayload,
    });
    await dest.send(packet);
  }

  /**
   * Pulls one page of pending blobs for a channel from the node's deferred
   * queue (user-initiated paging).
   *
   * Opens an identified link to `rfed.channel.pull` and sends `/rfed/pull` with
   * the channel hash. The response is `[[[channel_hash, blob], …],
   * more_pending]`; repeat while `morePending` is true to drain the queue.
   *
   * @param {Uint8Array} nodeHash
   * @param {string} channelName
   * @returns {Promise<{ items: Array<{ channelHash: Uint8Array, blob: Uint8Array }>, morePending: boolean }>}
   */
  async pull(nodeHash, channelName) {
    const { channelHash } = await this._channel(channelName);
    const nodeIdentity = await this._nodeIdentity(nodeHash);

    const dest = await Destination.OUT(
      CHANNEL_PULL_NAME,
      DestType.SINGLE,
      nodeIdentity,
      this.rns,
    );
    const link = await dest.createLink();
    await link.identify(this.identity);
    const response = await link.request(PULL_PATH, channelHash);

    if (!Array.isArray(response) || response.length < 2) {
      return { items: [], morePending: false };
    }
    /** @type {any[]} */
    const pairs = response[0];
    const morePending = response[1] === true;
    const items = (Array.isArray(pairs) ? pairs : []).map(
      /** @param {any} pair */ (pair) => ({
        channelHash: pair[0],
        blob: pair[1],
      }),
    );
    return { items, morePending };
  }

  /**
   * Registers a notify relay for wake-ups (SPEC §9.1). When a blob is deferred
   * for this subscriber on the given channel (or globally if `channelName` is
   * omitted), the node sends a §9.3 wake packet to the relay.
   *
   * `relayHash` is the 32-char lowercase hex destination hash of the relay's
   * `rfed.notify` destination.
   *
   * @param {Uint8Array} nodeHash
   * @param {string} relayHash
   * @param {string} [channelName] - Optional channel scope; omit for LXMF/global.
   * @returns {Promise<boolean>} `true` if the node accepted the registration.
   */
  async registerNotify(nodeHash, relayHash, channelName) {
    return this._notifyCommand(
      nodeHash,
      "register",
      relayHash,
      channelName,
      NOTIFY_REGISTER_PATH,
      NOTIFY_REGISTER_NAME,
    );
  }

  /**
   * Removes a specific notify relay registration (SPEC §9.1).
   *
   * @param {Uint8Array} nodeHash
   * @param {string} relayHash
   * @param {string} [channelName]
   * @returns {Promise<boolean>}
   */
  async unregisterNotify(nodeHash, relayHash, channelName) {
    return this._notifyCommand(
      nodeHash,
      "unregister",
      relayHash,
      channelName,
      NOTIFY_UNREGISTER_PATH,
      NOTIFY_UNREGISTER_NAME,
    );
  }

  /**
   * Removes ALL notify relay registrations for this subscriber (every channel
   * + LXMF). Served on the legacy `rfed.notify` destination (SPEC §9.1).
   *
   * @param {Uint8Array} nodeHash
   * @returns {Promise<boolean>}
   */
  async clearNotify(nodeHash) {
    const nodeIdentity = await this._nodeIdentity(nodeHash);
    // Clear carries no relay/channel — an empty signed value.
    const value = new Uint8Array(0);
    const payload = await signedValuePayload(this.identity, value);
    const dest = await Destination.OUT(
      NOTIFY_LEGACY_NAME,
      DestType.SINGLE,
      nodeIdentity,
      this.rns,
    );
    const link = await dest.createLink();
    await link.identify(this.identity);
    const response = await link.request(NOTIFY_CLEAR_PATH, payload);
    return response === true;
  }

  /**
   * Shared register/unregister driver: builds the modern
   * `[op, relay_hex, channel_hash_bin|null]` command, signs it, and sends it.
   *
   * @param {Uint8Array} nodeHash
   * @param {"register"|"unregister"} op
   * @param {string} relayHash
   * @param {string|undefined} channelName
   * @param {string} path
   * @param {string} destName
   * @returns {Promise<boolean>}
   * @private
   */
  async _notifyCommand(nodeHash, op, relayHash, channelName, path, destName) {
    const nodeIdentity = await this._nodeIdentity(nodeHash);
    const channelHash =
      channelName !== undefined ? (await this._channel(channelName)).channelHash : null;
    const command = [op, relayHash, channelHash];
    const value = MicroMsgPack.encode(command);
    const payload = await signedValuePayload(this.identity, value);
    const dest = await Destination.OUT(
      destName,
      DestType.SINGLE,
      nodeIdentity,
      this.rns,
    );
    const link = await dest.createLink();
    await link.identify(this.identity);
    const response = await link.request(path, payload);
    return response === true;
  }

  /**
   * Starts listening for live fanout deliveries on the local `rfed.delivery`
   * destination and announces it so the node can route to it.
   *
   * Each incoming fanout payload `[ channel_hash ‖ inner_blob ]` is matched to
   * a subscribed channel, EC-decrypted, and passed to `onMessage` along with
   * the verified LXMF message.
   *
   * @param {(decoded: { message: Message, senderIdentity: Identity, senderPub: Uint8Array, sourceHash: Uint8Array, signatureValid: boolean, channelHash: Uint8Array, channelName: string }) => void} onMessage
   * @returns {Promise<Uint8Array>} the `rfed.delivery` destination hash.
   */
  async listen(onMessage) {
    this.onMessage = onMessage;
    if (!this.deliveryDest) {
      const dest = await Destination.IN(
        DELIVERY_NAME,
        DestType.SINGLE,
        this.identity,
        this.rns,
      );
      // Register the inbound destination with the transport so fanout packets
      // routed to its hash are delivered here. Mirrors LXMRouter.init.
      this.rns.transport.bindLocalDestination(dest);
      dest.addEventListener("data", (/** @type {any} */ event) => {
        this._handleDelivery(event.detail.plaintext).catch(() => {
          // A foreign/unparsable fanout packet is dropped, not fatal.
        });
      });
      this.deliveryDest = dest;
    }
    await this.deliveryDest.announce();
    return /** @type {Uint8Array} */ (this.deliveryDest.destinationHash);
  }

  /**
   * Splits and decodes a fanout delivery plaintext.
   * @param {Uint8Array} plaintext
   * @private
   */
  async _handleDelivery(plaintext) {
    const { channelHash, innerBlob } = parseFanoutPayload(plaintext);
    const channel = this._channelByHash(channelHash);
    if (!channel) return; // not subscribed to this channel

    const decoded = await unwrapChannelMessage({
      innerBlob,
      channelIdentity: channel.identity,
      channelDeliveryHash: channel.deliveryHash,
    });
    this.onMessage?.({ ...decoded, channelHash, channelName: channel.name });
  }
}
