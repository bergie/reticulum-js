// src/transport/transport.js

import { Destination, Direction } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import {
  ContextType,
  DestType,
  getEnumName,
  HeaderType,
  Packet,
  PacketType,
  TransportType,
} from "../core/packet.js";
import { PacketReceipt, ReceiptStatus } from "../core/packet_receipt.js";
import { bytesEqual, toHex } from "../utils/encoding.js";
import { LogLevel, log } from "../utils/log.js";
import { RoutingTable } from "./router.js";

/**
 * The central network router for the Reticulum node.
 * Routes packets emitted by Interfaces.
 */
export class TransportCore extends EventTarget {
  /**
   * The well-known `path?` request destination app name (§7.1). Every node
   * resolves its dest_hash identically: `6b9f66014d9853faab220fba47d02761`.
   */
  static PATH_REQUEST_APP_NAME = "rnstransport.path.request";

  /**
   * Creates an empty transport core with no interfaces, links or routes.
   */
  constructor() {
    super();
    this.interfaces = new Set();
    this.localDestinations = new Map();
    this.activeLinks = new Map();
    this.routingTable = new RoutingTable();
    this.defaultInterface = null;

    /**
     * Selective persistence coordinator (#16). Set by `Reticulum` after it
     * constructs the adapter-backed Persistor; stays null when persistence is
     * disabled. `sendPacket` notifies it whenever we transmit to a real
     * (non-link) destination so the peer is remembered across restarts.
     * @type {import("../storage/persistor.js").Persistor|null}
     */
    this.persistor = null;

    // §7.2.2: path-request dedup tags (unique_tag = dest_hash || tag). A leaf
    // keeps a small bounded ring so a flood of retransmits for the same target
    // doesn't trigger redundant path-response announces.
    /** @type {string[]} */
    this.discoveryPrTags = [];
    /** @type {number} */
    this.maxPrTags = 256;

    // §Transport.packet_hashlist: inbound packet-hash dedup ring (two-set
    // double-buffered, culled at hashlistMaxsize/2, mirroring Python). A leaf
    // keeps a small ring; announces are exempt (their random_blob replay
    // protection lives in the RoutingTable). In-memory only for now (#16
    // stretch — persisting it has marginal value across a restart).
    /** @type {Set<string>} */
    this.packetHashlist = new Set();
    /** @type {Set<string>} */
    this.packetHashlistPrev = new Set();
    this.hashlistMaxsize = 50000;
  }

  /**
   * Attaches an interface that emits "packet" events.
   * @param {import("../interfaces/base.js").Interface} iface
   * @param {boolean} isDefault
   */
  addInterface(iface, isDefault = false) {
    this.interfaces.add(iface);
    if (isDefault) this.defaultInterface = iface;

    // 1. Hook into the Interface's existing outbound Framer
    // Since iface.writable is the input to the interface framer stream
    // (HDLC or KISS), we just get a writer for it.
    const writable = iface.writable;
    if (writable && !iface._packetWriter) {
      iface._packetWriter = writable.getWriter();
    }

    // 2. Listen to the Interface's inbound Packet loop
    iface.addEventListener("packet", (/** @type {any} */ event) => {
      return this._routeIncomingPacket(event.detail.packet, iface);
    });

    // 3. Handle graceful teardown
    iface.addEventListener("closed", () => this.removeInterface(iface));
    iface.addEventListener("error", (/** @type {any} */ e) =>
      log(
        "Transport",
        `[!] Interface ${iface.name} error: ${e.detail.message}`,
        LogLevel.ERROR,
      ),
    );

    // 4. Offer the transport to interfaces that spawn sub-interfaces (e.g.
    // AutoInterface) so they can auto-register them. No-op for interfaces that
    // don't override attachTransport.
    if (typeof iface.attachTransport === "function") {
      iface.attachTransport(this);
    }

    // Keep interfaces ordered by bitrate (Python `Transport.prioritize_interfaces`,
    // invoked on transport start + the per-interface jobs loop). JS has no jobs
    // loop, so we re-sort eagerly on every add/remove — same steady state.
    this.prioritizeInterfaces();

    log("Transport", `[+] Transport bound to interface: ${iface.name}`);
  }

  /**
   * Detaches an interface, releases its writer and purges its routes.
   * @param {import("../interfaces/base.js").Interface} iface
   */
  removeInterface(iface) {
    if (iface._packetWriter) {
      iface._packetWriter.releaseLock();
    }
    this.interfaces.delete(iface);
    this.routingTable.dropInterface(iface);
    if (this.defaultInterface === iface) this.defaultInterface = null;
    // Re-sort after removal so iteration order stays bitrate-prioritized.
    this.prioritizeInterfaces();
    log("Transport", `[-] Interface removed: ${iface.name}`, LogLevel.WARNING);
  }

  /**
   * Re-sorts the interface set by nominal bitrate, highest first, mirroring
   * the Python reference's `Transport.prioritize_interfaces()`
   * (`Transport.interfaces.sort(key=lambda i: i.bitrate, reverse=True)`,
   * wrapped in try/except).
   *
   * Because outbound routing is path-table driven (a packet goes out the
   * interface its path was learned through), this sort does **not** change
   * *which* interface carries a given routed packet — same as Python. It
   * governs **iteration order**: PLAIN/GROUP broadcasts and any "first
   * available" walk now visit higher-bitrate interfaces first. The genuine
   * per-bitrate behaviours (link timeouts, announce rate limiting) build on
   * this and are tracked as Phase 2 of work doc #20.
   *
   * Interfaces with a missing/non-numeric/zero bitrate sort last instead of
   * raising (Python's comparator would throw mid-sort and be swallowed by
   * its try/except, leaving the list unsorted; we degrade more gracefully).
   */
  prioritizeInterfaces() {
    try {
      const ranked = [...this.interfaces].sort((a, b) => {
        const ba =
          typeof a?.bitrate === "number" && a.bitrate > 0
            ? a.bitrate
            : -Infinity;
        const bb =
          typeof b?.bitrate === "number" && b.bitrate > 0
            ? b.bitrate
            : -Infinity;
        return bb - ba; // descending, matching `reverse=True`
      });
      this.interfaces = new Set(ranked);
    } catch (/** @type {any} */ e) {
      log(
        "Transport",
        `Could not prioritize interfaces according to bitrate. The contained exception was: ${e}`,
        LogLevel.ERROR,
      );
    }
  }

  /**
   * Registers an active link keyed by its destination hash.
   * @param {Uint8Array} destinationHash
   * @param {import("./link.js").Link} link
   */
  addLink(destinationHash, link) {
    const hex = toHex(destinationHash);
    log("Transport", `Registering link ${hex}`);
    this.activeLinks.set(hex, link);
  }

  /**
   * Removes a previously registered link.
   * @param {Uint8Array} destinationHash
   */
  removeLink(destinationHash) {
    const hex = toHex(destinationHash);
    this.activeLinks.delete(hex);
    log("Transport", `[-] Link closed for ${hex}`);
  }

  /**
   * Binds a local destination so inbound packets for it are delivered locally.
   * @param {import("../core/destination.js").Destination} destination
   */
  bindLocalDestination(destination) {
    const hash = destination.destinationHash;
    if (!hash) return;
    const destHex = toHex(hash);
    log("ROUTER", `Binding local destination: ${destHex}`);
    this.localDestinations.set(destHex, destination);
  }

  /**
   * Removes a previously bound local destination.
   * @param {import("../core/destination.js").Destination} destination
   */
  unbindLocalDestination(destination) {
    const hash = destination.destinationHash;
    if (!hash) return;
    const destHex = toHex(hash);
    this.localDestinations.delete(destHex);
    log("Transport", `[-] Unbinding local destination: ${destHex}`);
  }

  /**
   * Dispatches an inbound packet to the matching local destination or link,
   * or drops it if no route exists.
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface} receivingInterface
   * @private
   */
  async _routeIncomingPacket(packet, receivingInterface) {
    // §2.4 / Transport.py inbound (~l.1462): every transit hop — including the
    // hop to us — increments the hop counter. Announces read this as the
    // distance-to-us when populating the path table.
    packet.hops = (packet.hops ?? 0) + 1;

    // 1. Log arrival
    log(
      "ROUTER",
      `Processing packet type ${getEnumName(PacketType, packet.packetType)} (ctx ${getEnumName(ContextType, packet.contextByte)}) for ${toHex(packet.destinationHash)}`,
    );

    // Force a dump if it's a LINKREQUEST so we can see why it's not triggering
    if (packet.packetType === PacketType.LINKREQUEST) {
      log(
        "Transport",
        `[!] CRITICAL: Received Type 2 request for ${toHex(packet.destinationHash)}`,
      );
    }

    // Destination hash hex, reused by several branches below.
    const destHex = toHex(packet.destinationHash);

    // If it's an ANNOUNCE, the router handles it, but don't re-broadcast it!
    if (packet.packetType === PacketType.ANNOUNCE) {
      await this._handleAnnounce(packet, receivingInterface);
      return; // STOP! Do not pass to any other logic.
    }

    // §Transport.packet_filter: drop a non-announce packet whose hash we've
    // already seen (announces are exempt — replay protection is the
    // RoutingTable random_blob check). Bypass contexts that legitimately recur
    // or carry their own sequencing (resource/channel/keepalive flows).
    if (await this._isDuplicate(packet)) {
      log(
        "Transport",
        `Dropped duplicate packet for ${destHex}`,
        LogLevel.DEBUG,
      );
      return;
    }

    // §6.5: a regular PROOF (packet_type=PROOF, context=NONE) is addressed to
    // the 16-byte truncation of the proved packet's hash — a synthetic
    // ProofDestination, not a registered local dest. Intercept it here and
    // resolve the matching outbound PacketReceipt. Link proofs (dest = link_id)
    // and LRPROOFs (context=0xFF) are routed by their respective handlers.
    if (
      packet.packetType === PacketType.PROOF &&
      packet.contextByte === ContextType.NONE &&
      !this.activeLinks.has(destHex)
    ) {
      await this._handleProof(packet);
      return;
    }

    // §7.1: a `path?` request is a DATA packet addressed to the well-known
    // `rnstransport.path.request` PLAIN destination. Every node intercepts it
    // (it's not a registered local dest) and answers if it owns the target.
    if (
      packet.packetType === PacketType.DATA &&
      bytesEqual(packet.destinationHash, await this._pathRequestDestHash())
    ) {
      await this._handlePathRequest(packet, receivingInterface);
      return;
    }

    // 2. CHECK IF THIS PACKET IS FOR US

    // 3. If it's for a known local destination, route it there
    if (this.localDestinations.has(destHex)) {
      log("Transport", `Packet to local destination ${destHex}`);
      const destination = this.localDestinations.get(destHex);
      await destination.receive(packet, receivingInterface);
      return; // STOP! Success.
    }

    // 4. If it's for an active link, route it there
    if (this.activeLinks.has(destHex)) {
      log("Transport", `Packet to LINK ${destHex}`);
      const link = this.activeLinks.get(destHex);
      await link.receive(packet);
      return; // STOP! Success.
    }

    // 5. IF WE REACH HERE: It's not for us.
    // If you are acting as a router/node, you'd forward it.
    // But since you are a bot, JUST DROP IT.
    log("ROUTER", `Packet for ${destHex} is not for us. Dropping.`);
    log(
      "ROUTER",
      `Registered local destinations: ${Array.from(this.localDestinations.keys()).join(", ")}`,
    );
  }

  /**
   * Validates and ingests an ANNOUNCE packet (SPEC.md §4.5).
   *
   * Delegates the body parse, Ed25519 signature verification and destination
   * hash recomputation to {@link Identity.validateAnnounce} (steps 1-3), then
   * performs the public-key collision rejection (step 4) and caches the
   * identity / app_data / ratchet (step 6). Forged or malformed announces are
   * dropped silently; a validated announce is also dispatched as an `announce`
   * event for application-layer handlers (§4.4 name_hash filtering, contact
   * list population, etc.).
   *
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface|null} receivingInterface
   *   Interface the announce arrived on; recorded as the outbound interface
   *   for the learned path.
   * @private
   */
  async _handleAnnounce(packet, receivingInterface) {
    const destHex = toHex(packet.destinationHash);

    // Self-announce filter (SPEC.md §9.5 / §4.5 step 8): never ingest our own
    // destinations — otherwise we'd populate our contact list with ourselves.
    if (this.localDestinations.has(destHex)) {
      log(
        "Transport",
        `Ignoring ANNOUNCE for local destination ${destHex}`,
        LogLevel.DEBUG,
      );
      return;
    }

    const result = await Identity.validateAnnounce(
      packet.destinationHash,
      packet.contextFlag,
      packet.payload,
    );
    if (!result) return; // validateAnnounce already logged the rejection reason

    const { identity, nameHash, randomHash, ratchet, appData } = result;

    // §4.5 step 4 — public-key collision rejection. First-announcer-wins: a
    // different public_key for an already-known destination_hash is treated as
    // a hash-collision / spoofing attempt and rejected even though the
    // signature is otherwise valid. (In practice this requires a 2^128 hash
    // collision, so it should never fire — but the defense is non-optional.)
    const existing = Destination.knownDestinations.get(destHex);
    if (
      existing &&
      existing[2] &&
      !bytesEqual(existing[2], identity.publicKey)
    ) {
      log(
        "Transport",
        `CRITICAL: public-key collision for ${destHex} — rejecting announce`,
        LogLevel.ERROR,
      );
      return;
    }

    // §4.5 step 6 — cache the announce contents.
    const packetHash = await packet.getHash();
    await Destination.remember(
      packetHash,
      packet.destinationHash,
      identity.publicKey,
      appData,
    );
    if (ratchet) {
      Destination.rememberRatchet(packet.destinationHash, ratchet);
    }

    // §7 path-table population: remember how to reach this destination. The
    // next hop is the transport node that rebroadcast the announce (its id
    // sits in the HEADER_2 transportId slot), or the destination itself when
    // the announce reached us directly (HEADER_1, 1 hop). Transport.py inbound
    // (~l.1716/1741) derives `received_from` the same way and stores it as the
    // path entry's next_hop.
    const nextHop = packet.transportId ?? packet.destinationHash;
    const added = this.routingTable.addOrUpdateRoute(packet.destinationHash, {
      nextHop,
      hops: packet.hops,
      viaInterface: receivingInterface,
      randomBlob: randomHash,
    });
    if (added) {
      log(
        "Transport",
        `Path to ${destHex} is now ${packet.hops} hop(s) away via ${toHex(nextHop)}`,
        LogLevel.DEBUG,
      );
    }

    log(
      "Transport",
      `Validated announce from ${destHex} (name_hash=${toHex(nameHash)}, ratchet=${ratchet ? "yes" : "no"})`,
      LogLevel.DEBUG,
    );
    this.dispatchEvent(
      new CustomEvent("announce", {
        detail: {
          destinationHash: packet.destinationHash,
          identity,
          nameHash,
          randomHash,
          ratchet,
          appData,
          packet,
        },
      }),
    );
  }

  /**
   * Resolves an inbound regular PROOF packet (§6.5) against the outstanding
   * {@link PacketReceipt} tracked for the proved outbound DATA packet.
   *
   * The PROOF's `dest_hash` is the 16-byte truncation of the proved packet's
   * hash; the receipt is looked up by that key, then the proof body is
   * length-dispatched (96 B explicit / 64 B implicit) and the Ed25519
   * signature verified. On success the receipt is marked delivered and its
   * callback fired; otherwise the proof is dropped silently (no NACK, §6.5.5).
   *
   * @param {import("../core/packet.js").Packet} packet
   * @private
   */
  async _handleProof(packet) {
    const receipt = PacketReceipt.find(packet.destinationHash);
    if (!receipt || receipt.status !== ReceiptStatus.SENDING) {
      log(
        "Transport",
        `No outstanding receipt for PROOF ${toHex(packet.destinationHash)}`,
        LogLevel.DEBUG,
      );
      return;
    }
    if (await receipt.validateProof(packet.payload)) {
      receipt.setDelivered();
      log(
        "Transport",
        `PROOF validated for ${toHex(packet.destinationHash)} — receipt delivered`,
      );
    } else {
      log(
        "Transport",
        `PROOF validation failed for ${toHex(packet.destinationHash)}`,
        LogLevel.WARNING,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Path requests (SPEC.md §7.1 / §7.2 — leaf minimum)
  // -----------------------------------------------------------------------

  /**
   * Lazily computes and caches the well-known `rnstransport.path.request`
   * destination hash. Every node resolves this identically via the PLAIN
   * recipe (§1.4.3, identity == None) — verified constant
   * `6b9f66014d9853faab220fba47d02761`.
   *
   * @returns {Promise<Uint8Array>}
   * @private
   */
  static _pathRequestDestHashCached = /** @type {Uint8Array|null} */ (null);
  async _pathRequestDestHash() {
    let hash = TransportCore._pathRequestDestHashCached;
    if (!hash) {
      const dest = await Destination.PLAIN(
        TransportCore.PATH_REQUEST_APP_NAME,
        Direction.IN,
      );
      hash = /** @type {Uint8Array} */ (dest.destinationHash);
      TransportCore._pathRequestDestHashCached = hash;
    }
    return hash;
  }

  /**
   * Sends a `path?` request for a destination we have no route to (§7.1).
   *
   * Leaf form: `target_dest_hash(16) || random_tag(16)` (32 bytes). The tag
   * makes the request unique enough for relay dedup (§7.2.2); a fresh random
   * tag is drawn per request so re-requests for the same destination aren't
   * suppressed as duplicates.
   *
   * @param {Uint8Array} destinationHash - 16-byte destination to discover.
   */
  async requestPath(destinationHash) {
    if (!destinationHash || destinationHash.length !== 16) {
      throw new Error("requestPath requires a 16-byte destination hash");
    }
    const tag = Identity.getRandomHash().slice(0, 16);
    const payload = new Uint8Array(32);
    payload.set(destinationHash, 0);
    payload.set(tag, 16);

    const packet = new Packet({
      packetType: PacketType.DATA,
      destinationType: DestType.PLAIN,
      destinationHash: await this._pathRequestDestHash(),
      transportType: TransportType.BROADCAST,
      contextByte: ContextType.NONE,
      payload,
    });
    log(
      "Transport",
      `Requesting path to ${toHex(destinationHash)}`,
      LogLevel.DEBUG,
    );
    this.broadcast(packet);
  }

  /**
   * Handles an inbound `path?` request (§7.2) for the leaf minimum (branch 1):
   *
   *   - parse `target_dest_hash` and `tag_bytes` (length-detected per §7.2.1);
   *   - drop tagless requests;
   *   - dedup on `(target, tag)` so retransmits don't storm (§7.2.2);
   *   - if the target is one of our own local destinations, answer with a
   *     path-response announce (§7.2.4).
   *
   * Transport-mode branches (answer on behalf of a remote destination via the
   * path table, recursive discovery) are out of scope for a leaf.
   *
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface|null} receivingInterface
   * @private
   */
  async _handlePathRequest(packet, receivingInterface) {
    const data = packet.payload;
    if (data.length < 16) return; // malformed

    const targetHash = data.slice(0, 16);

    // §7.2.1: transport_id occupies [16:32] only when len > 32; otherwise the
    // second slot is the tag. The tag is whatever trails the fixed prefix,
    // capped at 16 bytes.
    /** @type {Uint8Array|null} */
    let tagBytes = null;
    if (data.length > 32) {
      // requesting_transport_instance = data[16:32]  (ignored on a leaf)
      tagBytes = data.slice(32, 48);
    } else if (data.length > 16) {
      tagBytes = data.slice(16, 32);
    }

    if (!tagBytes || tagBytes.length === 0) {
      // §7.2.1 note 1: tagless requests are dropped.
      log("Transport", "Dropping tagless path request", LogLevel.DEBUG);
      return;
    }

    // §7.2.2 dedup on unique_tag = target || tag.
    const uniqueTag = toHex(targetHash) + toHex(tagBytes);
    if (this.discoveryPrTags.includes(uniqueTag)) {
      log("Transport", "Ignoring duplicate path request", LogLevel.DEBUG);
      return;
    }
    this.discoveryPrTags.push(uniqueTag);
    while (this.discoveryPrTags.length > this.maxPrTags) {
      this.discoveryPrTags.shift();
    }

    const targetHex = toHex(targetHash);
    log("Transport", `Path request for ${targetHex}`, LogLevel.DEBUG);

    // §7.2.3 branch 1: if we own the target, answer with a path-response announce.
    if (this.localDestinations.has(targetHex)) {
      const dest = this.localDestinations.get(targetHex);
      if (dest.identity) {
        await dest.announcePathResponse();
        log("Transport", `Answered path request for ${targetHex}`);
      }
    }
    // Branch 5 (leaf, no path known for a dest we don't own): drop silently.
  }

  /**
   * @param {import("../core/packet.js").Packet} packet
   * @param {import("../interfaces/base.js").Interface|null} sourceInterface
   */
  broadcast(packet, sourceInterface = null) {
    for (const iface of this.interfaces) {
      if (iface === sourceInterface || !iface._packetWriter) continue;

      // Write the Packet object directly. The interface's Framer turns it into bytes.
      iface._packetWriter.write(packet).catch((/** @type {Error} */ err) => {
        log(
          "Transport",
          `[!] Broadcast failed on ${iface.name}: ${err}`,
          LogLevel.ERROR,
        );
      });
    }
  }

  /**
   * Sends a packet toward its destination (Transport.py outbound, ~l.1092).
   *
   * For routable destination types (SINGLE / LINK) with a known path, the
   * packet is sent on the interface the path was learned through. When the
   * destination is more than one hop away it is inserted into transport:
   * rewritten to HEADER_2 with `transport_type = TRANSPORT` and the next hop's
   * address as the transportId, so transit nodes can carry it hop-by-hop. A
   * one-hop destination is transmitted as-is. PLAIN/GROUP destinations and
   * anything with no known path fall back to the default interface (the leaf
   * broadcast fallback).
   *
   * The packet hash / receipt are computed from the logical (HEADER_1) packet
   * before any transport rewriting, so the PROOF returning over the reverse
   * path resolves against the right hash.
   *
   * @param {import("../core/packet.js").Packet} packet
   * @param {Uint8Array|null} [linkId] When set, hand the packet to the named
   *   active link instead of routing by destination.
   */
  async sendPacket(packet, linkId = null) {
    const destHex = toHex(packet.destinationHash);
    const packetHash = await packet.getHash();
    log("Transport", `Send ${toHex(packetHash)} to ${destHex}`);

    if (linkId) {
      const linkHex = toHex(linkId);
      const link = this.activeLinks.get(linkHex);
      if (!link) {
        throw new Error(`Link ${linkHex} is not available`);
      }
      await link.send(packet);
      return;
    }

    // PLAIN/GROUP destinations are always broadcast; announces never reach
    // here. Everything else is routable via the path table.
    const routable =
      packet.packetType !== PacketType.ANNOUNCE &&
      packet.destinationType !== DestType.PLAIN &&
      packet.destinationType !== DestType.GROUP;
    const route = routable
      ? this.routingTable.getRoute(packet.destinationHash)
      : undefined;

    if (route) {
      // §Transport.outbound (~l.1126): send on the interface the path was
      // learned through, injecting transport headers when >1 hop away. A
      // hydrated (#16) path entry carries no live interface reference, so fall
      // back to the default interface until a fresh announce re-associates it.
      const iface = route.interface ?? this.defaultInterface;
      if (route.hops > 1 && packet.headerType === HeaderType.HEADER_1) {
        const injected = new Packet({
          headerType: HeaderType.HEADER_2,
          hops: packet.hops,
          transportType: TransportType.TRANSPORT,
          destinationType: packet.destinationType,
          packetType: packet.packetType,
          contextFlag: packet.contextFlag,
          destinationHash: packet.destinationHash,
          contextByte: packet.contextByte,
          payload: packet.payload,
          transportId: route.nextHop,
        });
        await this._transmit(iface, injected);
      } else {
        // Direct (1 hop) or already in transport: transmit unchanged.
        await this._transmit(iface, packet);
      }
      route.timestamp = Date.now();
    } else if (this.defaultInterface && this.defaultInterface._packetWriter) {
      // No known path: broadcast on the default interface (leaf fallback).
      await this.defaultInterface._packetWriter.write(packet);
    } else {
      throw new Error(`No route to host: ${destHex}`);
    }

    // §16 persistence: a routable send to a real (non-link) destination means
    // we're communicating with it — remember its identity/ratchet/path across
    // restarts. Link DATA is addressed to link_id (held in activeLinks), so its
    // peer is already covered by the originating LINKREQUEST send.
    if (routable && !this.activeLinks.has(destHex)) {
      this.persistor?.markContacted(packet.destinationHash);
    }

    // §6.5: track a PacketReceipt for opportunistic CTX_NONE DATA so the
    // receiver's PROOF can resolve it. Link DATA proofs are always explicit
    // and resolved on the link itself, so they are excluded here.
    if (
      packet.packetType === PacketType.DATA &&
      packet.contextByte === ContextType.NONE
    ) {
      PacketReceipt.track(
        new PacketReceipt(packetHash, packet.destinationHash),
      );
    }
  }

  /**
   * Writes a packet to an interface's outbound framer.
   * @param {import("../interfaces/base.js").Interface|null} iface
   * @param {import("../core/packet.js").Packet} packet
   * @private
   */
  async _transmit(iface, packet) {
    if (!iface || !iface._packetWriter) {
      throw new Error(
        `Interface ${iface?.name ?? "unknown"} has no packet writer`,
      );
    }
    await iface._packetWriter.write(packet);
  }

  /**
   * Whether a path is currently known for the destination (Transport.has_path).
   * @param {Uint8Array} destinationHash
   * @returns {boolean}
   */
  hasPath(destinationHash) {
    return this.routingTable.hasRoute(destinationHash);
  }

  /**
   * The hop count to the destination, or `null` if no path is known
   * (Transport.hops_to).
   * @param {Uint8Array} destinationHash
   * @returns {number|null}
   */
  hopsTo(destinationHash) {
    return this.routingTable.getRoute(destinationHash)?.hops ?? null;
  }

  /**
   * The 16-byte address of the next transport hop toward the destination, or
   * `null` if no path is known (Transport.next_hop). This is the value placed
   * into HEADER_2 when sending.
   * @param {Uint8Array} destinationHash
   * @returns {Uint8Array|null}
   */
  nextHop(destinationHash) {
    return this.routingTable.getRoute(destinationHash)?.nextHop ?? null;
  }

  /**
   * Returns true when an inbound non-announce packet is a duplicate we've
   * already seen (Transport.packet_filter / packet_hashlist, two-set dedup
   * ring). Bypasses contexts that legitimately recur or are dedup'd elsewhere
   * (KEEPALIVE, the RESOURCE / RESOURCE_REQ / RESOURCE_PRF / CACHE_REQUEST /
   * CHANNEL flows). A fresh hash is remembered, and the ring rotates (prev ←
   * current) once {@link packetHashlist} exceeds {@link hashlistMaxsize}/2.
   * @param {Packet} packet
   * @returns {Promise<boolean>} `true` = drop as duplicate.
   * @private
   */
  async _isDuplicate(packet) {
    switch (packet.contextByte) {
      case ContextType.KEEPALIVE:
      case ContextType.RESOURCE:
      case ContextType.RESOURCE_REQ:
      case ContextType.RESOURCE_PRF:
      case ContextType.CACHE_REQUEST:
      case ContextType.CHANNEL:
        return false;
    }
    const hashHex = toHex(await packet.getHash());
    if (
      this.packetHashlist.has(hashHex) ||
      this.packetHashlistPrev.has(hashHex)
    ) {
      return true;
    }
    this.packetHashlist.add(hashHex);
    if (this.packetHashlist.size > this.hashlistMaxsize / 2) {
      this.packetHashlistPrev = this.packetHashlist;
      this.packetHashlist = new Set();
    }
    return false;
  }
}
