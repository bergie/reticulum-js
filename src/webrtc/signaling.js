import { Destination } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import { DestType } from "../core/packet.js";
import { Resource } from "../core/resource.js";
import { WebRTCInterface } from "../interfaces/webrtc.js";
import { toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";

/**
 * @file signaling.js
 * @description WebRTC transport-upgrade signaling orchestrator (work doc #19).
 *
 * Bridges Reticulum's low-bandwidth discovery protocol with a high-bandwidth
 * WebRTC `RTCDataChannel`. Runs the two-stage connection lifecycle the work
 * document specifies:
 *
 *   1. **Discovery** — each peer owns a SINGLE destination named
 *      {@link DEFAULT_DESTINATION_NAME} (configurable) and announces with a
 *      one-byte capability flag as `app_data`. Peers hear each other through
 *      the standard transport `"announce"` event.
 *   2. **SDP exchange** — the initiator opens an encrypted Reticulum Link to
 *      the responder and exchanges WebRTC SDP (offer/answer) as Reticulum
 *      {@link Resource}s, which transparently fragment the multi-KB SDP across
 *      the 500-byte MTU.
 *   3. **Transport upgrade** — once the `RTCDataChannel` opens it is wrapped in
 *      a {@link WebRTCInterface} and registered with the transport; the
 *      signaling Link is then torn down (it existed only to carry the SDP).
 *
 * **Dependency-injection-first.** The core package stays browser-safe and
 * WinterTC-pure: this module never imports a WebRTC runtime. The concrete
 * `RTCPeerConnection` factory is injected via
 * {@link WebRTCSignalingOptions.createPeerConnection}; when omitted it
 * auto-detects the browser global. Node.js (which has no native WebRTC) gets
 * its `RTCPeerConnection` from the future WebRTC companion package and passes
 * it in — see work doc #19 update #3. This also makes the full negotiation
 * state machine mock-testable in Node with an injected fake.
 *
 * There is no Python reference for this transport; the wire format this module
 * implements is the canonical one and is documented in
 * `documents/WebRTC Transport.md` so other languages can interoperate.
 */

/**
 * Default destination name for the WebRTC signaling family. Both peers must
 * use the same name to discover each other. Override per-application to run
 * multiple isolated WebRTC peer meshes on one Reticulum instance.
 */
export const DEFAULT_DESTINATION_NAME = "rns.webrtc";

/**
 * `app_data` capability flag byte (version 1 = non-trickle WebRTC peer). Sent
 * as a one-byte `Uint8Array` in the announce so peers can cheaply identify
 * WebRTC-capable destinations. Higher bits are reserved for future capability
 * signalling (e.g. trickle ICE).
 */
export const CAPABILITY_FLAG = 0x01;

/** SDP Resource framing: the bytes following this type byte are an offer SDP. */
export const SDP_TYPE_OFFER = 0x01;
/** SDP Resource framing: the bytes following this type byte are an answer SDP. */
export const SDP_TYPE_ANSWER = 0x02;
/**
 * SDP Resource framing: reserved for a future trickle-ICE candidate message.
 * Kept in the type space now so adding trickle later stays wire-compatible.
 */
export const SDP_TYPE_CANDIDATE = 0x03;

/**
 * Cap on an inbound SDP Resource accepted over a signaling link (§10.4 bomb
 * defense). WebRTC SDP is a few KB; 64 KiB is generous and far below the
 * default 32 MiB Resource cap.
 */
export const MAX_SDP_SIZE = 64 * 1024;

/** `RTCDataChannel.label` used for the Reticulum data channel on both sides. */
export const CHANNEL_LABEL = "reticulum";

/**
 * Waits for an `RTCPeerConnection` to finish ICE gathering (the non-trickle
 * first cut ships the full local description only once all candidates are in).
 * Resolves early if gathering is already complete; never rejects — a timeout
 * resolves with whatever candidates have been gathered so far (the local
 * description is still usable, just less optimal).
 *
 * @param {any} pc
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 * @private
 */
async function waitForIceGathering(pc, timeoutMs) {
  // `iceGatheringState` is the spec property; the event is the lowercase
  // `icegatheringstatechange`. Handle both shapes defensively (mocks).
  const state = pc.iceGatheringState ?? pc.icegatheringState;
  if (state === "complete") return;
  await new Promise((/** @type {(v?: unknown) => void} */ resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onChange = () => {
      const s = pc.iceGatheringState ?? pc.icegatheringState;
      if (s === "complete") finish();
    };
    const cleanup = () => {
      pc.removeEventListener?.("icegatheringstatechange", onChange);
      pc.removeEventListener?.("icecandidate", onChange);
    };
    pc.addEventListener?.("icegatheringstatechange", onChange);
    // Some runtimes settle `complete` without a dedicated gathering-state
    // change; a trailing `icecandidate` with `candidate === null` is the other
    // conventional signal that gathering is done.
    pc.addEventListener?.("icecandidate", onChange);
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Waits for an `RTCDataChannel` to reach the `"open"` state.
 * @param {any} channel
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 * @private
 */
function waitForChannelOpen(channel, timeoutMs) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (/** @type {Error|null} */ err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const onOpen = () => finish(null);
    const onError = (/** @type {any} */ e) =>
      finish(new Error(`RTCDataChannel error: ${e?.message ?? e}`));
    const onClose = () =>
      finish(new Error("RTCDataChannel closed before opening"));
    const cleanup = () => {
      channel.removeEventListener?.("open", onOpen);
      channel.removeEventListener?.("error", onError);
      channel.removeEventListener?.("close", onClose);
    };
    channel.addEventListener?.("open", onOpen);
    channel.addEventListener?.("error", onError);
    channel.addEventListener?.("close", onClose);
    setTimeout(
      () => finish(new Error("RTCDataChannel did not open before timeout")),
      timeoutMs,
    );
  });
}

/**
 * @typedef {Object} WebRTCSignalingOptions
 * @property {import("../core/reticulum.js").Reticulum} rns - The owning
 *   Reticulum instance. Used for transport (announce events, addInterface),
 *   identity recall, and destination registration.
 * @property {Identity} [identity] - Identity for the signaling destination.
 *   Generated on {@link WebRTCSignaling#start} if omitted. The destination's
 *   announce is signed by this identity.
 * @property {string} [destinationName] - Destination name both peers must agree
 *   on (default {@link DEFAULT_DESTINATION_NAME}).
 * @property {(config?: RTCConfiguration) => any} [createPeerConnection] - Factory returning a new
 *   `RTCPeerConnection` (or a duck-typed mock). The DI seam that keeps this
 *   module runtime-agnostic: browsers use the global, Node.js injects one from
 *   the WebRTC companion package, tests inject a mock pair. When omitted,
 *   auto-detects the global `RTCPeerConnection` (browser). Throws on
 *   {@link WebRTCSignaling#connect} / link handling if no factory is available.
 * @property {RTCConfiguration} [rtcConfig] - Configuration passed to
 *   `createPeerConnection` (e.g. `{ iceServers: [...] }` for STUN/TURN).
 * @property {Uint8Array} [extraAppData] - Additional capability bytes appended
 *   after the {@link CAPABILITY_FLAG} in the announce `app_data`. Reserved for
 *   application-level signalling; peers that don't understand them ignore them.
 * @property {boolean} [announceOnInit=true] - Whether {@link WebRTCSignaling#start}
 *   announces immediately. Set false to stay silent until
 *   {@link WebRTCSignaling#announce} is called explicitly.
 * @property {number} [iceGatheringTimeoutMs=5000] - Per-connection cap on how
 *   long to wait for ICE gathering before shipping the local description.
 * @property {number} [channelOpenTimeoutMs=15000] - Per-connection cap on how
 *   long to wait for the data channel to open after SDP exchange.
 * @property {number} [answerTimeoutMs=20000] - How long the initiator waits
 *   for the responder's answer Resource before rejecting the connection.
 */

/**
 * Orchestrates the announce → link → SDP-exchange → data-channel lifecycle and
 * registers each resulting `RTCDataChannel` as a {@link WebRTCInterface}.
 *
 * @extends EventTarget
 * @fires WebRTCSignaling#peer
 * @fires WebRTCSignaling#channel
 */
export class WebRTCSignaling extends EventTarget {
  /** @type {boolean} */
  _started = false;
  /** @type {((event: Event) => void) | null} */
  _announceListener = null;
  /** @type {((event: Event) => void) | null} */
  _linkRequestListener = null;
  /** @type {Set<string>} hex peer destination hashes with an active connection attempt. */
  _pending = new Set();

  /**
   * @param {WebRTCSignalingOptions} options
   */
  constructor(options) {
    super();
    if (!options?.rns) {
      throw new Error("WebRTCSignaling requires a Reticulum instance (rns)");
    }
    this.rns = options.rns;
    this.identity = options.identity ?? null;
    this.destinationName = options.destinationName ?? DEFAULT_DESTINATION_NAME;
    this.createPeerConnection = options.createPeerConnection ?? null;
    this.rtcConfig = options.rtcConfig ?? {};
    this.extraAppData = options.extraAppData ?? null;
    this.announceOnInit = options.announceOnInit ?? true;
    this.iceGatheringTimeoutMs = options.iceGatheringTimeoutMs ?? 5000;
    this.channelOpenTimeoutMs = options.channelOpenTimeoutMs ?? 15000;
    this.answerTimeoutMs = options.answerTimeoutMs ?? 20000;
    /** @type {import("../core/destination.js").Destination | null} */
    this.destination = null;
  }

  /**
   * Creates the signaling destination, registers it, subscribes to transport
   * announce events and incoming link requests, and (unless
   * {@link WebRTCSignalingOptions.announceOnInit} is false) announces. Must be
   * called (and awaited, or via {@link WebRTCSignaling#startPromise}) before
   * {@link WebRTCSignaling#connect} or the responder role will work.
   *
   * Idempotent.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._started) return;
    this._started = true;
    if (!this.identity) this.identity = await Identity.generate();
    this.destination = await Destination.IN(
      this.destinationName,
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    this.destination.appData = this._buildAppData();
    // Bind to the transport (not just the Reticulum wrapper) so inbound
    // LINKREQUESTs and link packets addressed to this destination are
    // delivered. Mirrors `src/lxmf/router.js` and the bundled examples.
    this.rns.transport.bindLocalDestination(this.destination);

    this._linkRequestListener = (event) => {
      // Fire-and-forget; errors are logged inside.
      this._onLinkRequest(/** @type {CustomEvent} */ (event)).catch(
        (/** @type {Error} */ e) =>
          log("WebRTC", `Incoming link handling failed: ${e}`, LogLevel.ERROR),
      );
    };
    this.destination.addEventListener(
      "link_request",
      this._linkRequestListener,
    );

    this._announceListener = (event) => {
      this._onAnnounce(/** @type {CustomEvent} */ (event));
    };
    this.rns.transport.addEventListener("announce", this._announceListener);

    if (this.announceOnInit) await this.announce();
    log(
      "WebRTC",
      `Signaling started as ${toHex(/** @type {Uint8Array} */ (this.destination.destinationHash))}`,
      LogLevel.NOTICE,
    );
  }

  /**
   * (Re)broadcasts the capability announce. Also called from {@link start} when
   * {@link WebRTCSignalingOptions.announceOnInit} is true.
   * @returns {Promise<void>}
   */
  async announce() {
    if (!this.destination) {
      throw new Error("WebRTCSignaling.start() must be called first");
    }
    await this.destination.announce();
  }

  /**
   * Tears down the signaling destination and detaches listeners. Already-open
   * WebRTC interfaces are unaffected (they live independently in the transport
   * once registered).
   */
  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._announceListener) {
      this.rns.transport.removeEventListener(
        "announce",
        this._announceListener,
      );
      this._announceListener = null;
    }
    if (this.destination && this._linkRequestListener) {
      this.destination.removeEventListener(
        "link_request",
        this._linkRequestListener,
      );
      this._linkRequestListener = null;
    }
    if (this.destination) {
      this.rns.transport.unbindLocalDestination(this.destination);
    }
    log("WebRTC", "Signaling stopped", LogLevel.NOTICE);
  }

  /**
   * Initiates a WebRTC connection to a peer whose destination hash was learned
   * from a `"peer"` event (or otherwise known). Runs the initiator half of the
   * lifecycle: recall the peer identity, open a link, create the data channel,
   * gather ICE, send the offer as a Resource, await the answer Resource, set
   * the remote description, and adopt the opened channel as an interface.
   *
   * Rejects if the peer identity is unknown (wait for its announce), the
   * `RTCPeerConnection` factory is missing, or any negotiation step fails.
   *
   * @param {Uint8Array} peerDestinationHash - The peer's signaling destination hash.
   * @returns {Promise<WebRTCInterface>} The registered interface wrapping the
   *   opened data channel.
   */
  async connect(peerDestinationHash) {
    this._requireStarted();
    this._requirePeerConnectionFactory();
    const peerHex = toHex(peerDestinationHash);
    if (this._pending.has(peerHex)) {
      throw new Error(`Connection to ${peerHex} already in progress`);
    }
    this._pending.add(peerHex);
    try {
      return await this._connectOnce(peerDestinationHash, peerHex);
    } finally {
      this._pending.delete(peerHex);
    }
  }

  /**
   * The actual initiator flow, isolated so {@link connect} can always clear the
   * pending-connection guard via `finally`.
   * @param {Uint8Array} peerDestinationHash
   * @param {string} peerHex
   * @returns {Promise<WebRTCInterface>}
   * @private
   */
  async _connectOnce(peerDestinationHash, peerHex) {
    const peerIdentity = await Destination.recall(peerDestinationHash);
    if (!peerIdentity) {
      throw new Error(
        `Unknown identity for ${peerHex}; wait for its announce before connecting.`,
      );
    }
    const outDest = await Destination.OUT(
      this.destinationName,
      DestType.SINGLE,
      peerIdentity,
      this.rns,
    );
    const link = await outDest.createLink();
    link.maxResourceSize = MAX_SDP_SIZE;
    link.bz2 = undefined; // SDP ships uncompressed; never needs bz2.

    const pc = this._newPeerConnection();
    /** @type {any} */
    const channel = pc.createDataChannel(CHANNEL_LABEL);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, this.iceGatheringTimeoutMs);

    // Race-safe: arm the answer waiter BEFORE the offer goes out so a
    // same-tick (loopback) responder can't have its answer resource missed.
    const answerPromise = this._receiveSDP(link, SDP_TYPE_ANSWER);
    await this._sendSDP(link, SDP_TYPE_OFFER, pc.localDescription.sdp);
    const answerSdp = await answerPromise;
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    await waitForChannelOpen(channel, this.channelOpenTimeoutMs);
    // Mark connected before wrapping/registration so the interface is added
    // in the same tick the channel became usable.
    return this._adoptChannel(channel, pc, peerDestinationHash, link);
  }

  // ---------------------------------------------------------------------
  // Responder role (incoming link + offer)
  // ---------------------------------------------------------------------

  /**
   * Accepts an incoming LINKREQUEST on the signaling destination and prepares
   * to receive the offer Resource. The actual SDP processing happens in
   * {@link WebRTCSignaling#_handleOffer}.
   * @param {CustomEvent} event
   * @returns {Promise<void>}
   * @private
   */
  async _onLinkRequest(event) {
    this._requirePeerConnectionFactory();
    const packet = event.detail?.packet;
    if (!packet || !this.destination) return;
    /** @type {import("../transport/link.js").Link} */
    const link = await this.destination.acceptLink(packet);
    link.maxResourceSize = MAX_SDP_SIZE;
    link.bz2 = undefined;
    const onResource = (/** @type {any} */ resEvent) => {
      const resource = resEvent.detail?.resource;
      if (!resource) return;
      resource
        .whenComplete()
        .then(
          async (/** @type {import("../core/resource.js").Resource} */ res) => {
            await this._handleOffer(link, res);
          },
        )
        .catch((/** @type {Error} */ e) =>
          log("WebRTC", `Offer resource transfer failed: ${e}`, LogLevel.ERROR),
        );
    };
    link.addEventListener("resource", onResource);
  }

  /**
   * Responder: parse the offer, create a peer connection, answer, and adopt the
   * negotiated data channel once it opens.
   * @param {import("../transport/link.js").Link} link
   * @param {import("../core/resource.js").Resource} offerResource
   * @returns {Promise<void>}
   * @private
   */
  async _handleOffer(link, offerResource) {
    const parsed = this._parseSDP(
      /** @type {Uint8Array} */ (offerResource.data),
    );
    if (!parsed || parsed.type !== SDP_TYPE_OFFER) {
      log("WebRTC", "Ignoring non-offer SDP resource on signaling link");
      return;
    }
    const pc = this._newPeerConnection();
    pc.addEventListener("datachannel", (/** @type {any} */ dcEvent) => {
      const channel = dcEvent?.channel;
      if (!channel) return;
      waitForChannelOpen(channel, this.channelOpenTimeoutMs)
        .then(() => {
          // The initiator's identity is learned via LINKIDENTIFY once the link
          // is ACTIVE; fall back to null if it wasn't sent.
          const peerHash =
            /** @type {{remoteIdentity?: Identity}} */ (link).remoteIdentity
              ?.identityHash ?? null;
          this._adoptChannel(channel, pc, peerHash, link).catch(
            (/** @type {Error} */ e) =>
              log(
                "WebRTC",
                `Responder channel adoption failed: ${e}`,
                LogLevel.ERROR,
              ),
          );
        })
        .catch((/** @type {Error} */ e) =>
          log(
            "WebRTC",
            `Responder data channel did not open: ${e}`,
            LogLevel.ERROR,
          ),
        );
    });

    await pc.setRemoteDescription({ type: "offer", sdp: parsed.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc, this.iceGatheringTimeoutMs);
    await this._sendSDP(link, SDP_TYPE_ANSWER, pc.localDescription.sdp);
  }

  // ---------------------------------------------------------------------
  // SDP Resource framing + transfer
  // ---------------------------------------------------------------------

  /**
   * Frames and sends an SDP as an uncompressed Resource over the link, awaiting
   * the receiver's completion proof so the caller knows it was delivered.
   * @param {import("../transport/link.js").Link} link
   * @param {number} type One of the {@link SDP_TYPE_OFFER}/{@link SDP_TYPE_ANSWER} constants.
   * @param {string} sdp
   * @returns {Promise<void>}
   * @private
   */
  async _sendSDP(link, type, sdp) {
    const sdpBytes = new TextEncoder().encode(sdp);
    const framed = new Uint8Array(1 + sdpBytes.length);
    framed[0] = type;
    framed.set(sdpBytes, 1);
    const resource = new Resource({
      data: framed,
      link,
      autoCompress: false, // SDP is small; keep it uncompressed + dependency-free.
    });
    await resource.advertise();
    await resource.whenComplete();
  }

  /**
   * Awaits a single SDP Resource of the expected type on the link. Registered
   * before the matching SDP is sent so a loopback/same-tick responder can't
   * drop its resource before the listener attaches.
   * @param {import("../transport/link.js").Link} link
   * @param {number} expectedType
   * @returns {Promise<string>} The SDP string.
   * @private
   */
  _receiveSDP(link, expectedType) {
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @param {any} resEvent */
      const onResource = (resEvent) => {
        const resource = resEvent.detail?.resource;
        if (!resource || settled) return;
        resource
          .whenComplete()
          .then((/** @type {import("../core/resource.js").Resource} */ res) => {
            if (settled) return;
            const parsed = this._parseSDP(/** @type {Uint8Array} */ (res.data));
            if (!parsed) {
              settled = true;
              cleanup();
              reject(new Error("Received malformed SDP resource"));
              return;
            }
            if (parsed.type !== expectedType) {
              settled = true;
              cleanup();
              reject(
                new Error(
                  `Expected SDP type ${expectedType}, got ${parsed.type}`,
                ),
              );
              return;
            }
            settled = true;
            cleanup();
            resolve(parsed.sdp);
          })
          .catch((/** @type {Error} */ e) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(e);
          });
      };
      const cleanup = () => {
        link.removeEventListener("resource", onResource);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Timed out waiting for SDP answer"));
      }, this.answerTimeoutMs);
      link.addEventListener("resource", onResource);
    });
  }

  /**
   * Parses a framed SDP Resource payload.
   * @param {Uint8Array} bytes
   * @returns {{type: number, sdp: string} | null} `null` for empty/invalid input.
   * @private
   */
  _parseSDP(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1) return null;
    return { type: bytes[0], sdp: new TextDecoder().decode(bytes.subarray(1)) };
  }

  // ---------------------------------------------------------------------
  // Announce handling (discovery)
  // ---------------------------------------------------------------------

  /**
   * Filters transport announce events to our destination name and dispatches a
   * `"peer"` event for each fresh WebRTC-capable peer. Does not auto-connect —
   * the application decides whether to call {@link connect} for a given peer.
   * @param {CustomEvent} event
   * @private
   */
  _onAnnounce(event) {
    const detail = event.detail ?? {};
    if (!detail.nameHash || !this.destination?.nameHash) return;
    // Aspect-filter: only announces for our destination family name.
    let same = true;
    const a = detail.nameHash;
    const b = this.destination.nameHash;
    if (a.length !== b.length) same = false;
    else for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
    if (!same) return;
    // Ignore our own announce (transport already drops self-echo, but a
    // loopback/mock transport may not).
    if (
      this.destination.destinationHash &&
      detail.destinationHash &&
      this._bytesEqual(detail.destinationHash, this.destination.destinationHash)
    ) {
      return;
    }
    // Capability check: app_data must start with our flag byte.
    const appData = /** @type {Uint8Array | null | undefined} */ (
      detail.appData
    );
    if (!(appData instanceof Uint8Array) || appData.length < 1) return;
    if ((appData[0] & CAPABILITY_FLAG) !== CAPABILITY_FLAG) return;

    this.dispatchEvent(
      new CustomEvent("peer", {
        detail: {
          destinationHash: detail.destinationHash,
          identity: detail.identity,
          hops: detail.packet?.hops ?? 0,
        },
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Channel adoption + helpers
  // ---------------------------------------------------------------------

  /**
   * Wraps an opened `RTCDataChannel` in a {@link WebRTCInterface}, registers it
   * with the transport, dispatches `"channel"`, and tears down the signaling
   * link (it existed only to carry the SDP).
   * @param {any} channel
   * @param {any} pc
   * @param {Uint8Array | null} peerDestinationHash
   * @param {import("../transport/link.js").Link} link
   * @returns {Promise<WebRTCInterface>}
   * @private
   */
  async _adoptChannel(channel, pc, peerDestinationHash, link) {
    const iface = new WebRTCInterface({
      channel,
      peerConnection: pc,
      name: `webrtc-${peerDestinationHash ? toHex(peerDestinationHash).slice(0, 8) : "peer"}`,
    });
    // The channel is already open; connect() resolves immediately and wires up
    // the streams/inbound loop the transport reads from.
    await iface.connect();
    this.rns.addInterface(iface);
    this.dispatchEvent(
      new CustomEvent("channel", {
        detail: { interface: iface, peerDestinationHash },
      }),
    );
    // The signaling link has done its job; the WebRTC channel is now the
    // transport. Swallow teardown errors — the peer may have torn it down too.
    link.teardown().catch(() => {});
    return iface;
  }

  /**
   * Builds the `app_data` payload for the capability announce.
   * @returns {Uint8Array}
   * @private
   */
  _buildAppData() {
    if (this.extraAppData && this.extraAppData.length > 0) {
      const out = new Uint8Array(1 + this.extraAppData.length);
      out[0] = CAPABILITY_FLAG;
      out.set(this.extraAppData, 1);
      return out;
    }
    return new Uint8Array([CAPABILITY_FLAG]);
  }

  /**
   * Returns a new peer connection from the injected (or browser-global) factory.
   * @returns {any}
   * @private
   */
  _newPeerConnection() {
    if (typeof this.createPeerConnection !== "function") {
      // Lazily fall back to the browser global if present.
      this._requirePeerConnectionFactory();
    }
    return /** @type {(config?: RTCConfiguration) => any} */ (
      this.createPeerConnection
    )(this.rtcConfig);
  }

  /**
   * @private
   */
  _requireStarted() {
    if (!this._started || !this.destination) {
      throw new Error(
        "WebRTCSignaling.start() must be called and awaited first",
      );
    }
  }

  /**
   * @private
   */
  _requirePeerConnectionFactory() {
    if (typeof this.createPeerConnection === "function") return;
    const g = /** @type {any} */ (globalThis);
    if (typeof g.RTCPeerConnection === "function") {
      this.createPeerConnection = (
        /** @type {RTCConfiguration | undefined} */ config,
      ) => new g.RTCPeerConnection(config);
      return;
    }
    throw new Error(
      "No RTCPeerConnection available: pass createPeerConnection (browser " +
        "uses the global automatically; Node.js needs the WebRTC companion " +
        "package — see work doc #19).",
    );
  }

  /**
   * Constant-time-ish byte compare. Small hashes only.
   * @param {Uint8Array} a
   * @param {Uint8Array} b
   * @returns {boolean}
   * @private
   */
  _bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
}

/**
 * Dispatched for each WebRTC-capable peer announce heard on the network
 * (filtered to {@link WebRTCSignalingOptions.destinationName}). The
 * application decides whether to call {@link WebRTCSignaling#connect} for the
 * peer — there is no auto-connect.
 *
 * @event WebRTCSignaling#peer
 * @type {CustomEvent}
 * @property {Object} detail
 * @property {Uint8Array} detail.destinationHash Peer's signaling destination hash.
 * @property {Identity} detail.identity Peer's reconstructed identity.
 * @property {number} detail.hops Hop distance to the peer.
 */

/**
 * Dispatched once a WebRTC data channel has opened and been registered with the
 * transport as a {@link WebRTCInterface}. From this point RNS traffic to/from
 * the peer flows over the WebRTC channel, not the signaling link.
 *
 * @event WebRTCSignaling#channel
 * @type {CustomEvent}
 * @property {Object} detail
 * @property {WebRTCInterface} detail.interface The newly registered interface.
 * @property {Uint8Array|null} detail.peerDestinationHash The peer's signaling
 *   destination hash, if known (null on the responder side when the initiator
 *   did not LINKIDENTIFY).
 */
