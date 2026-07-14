// src/transport/transport.js

import { Destination, Direction } from "../core/destination.js";
import { Identity } from "../core/identity.js";
import {
  ContextType,
  DestType,
  getEnumName,
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

    // §7.2.2: path-request dedup tags (unique_tag = dest_hash || tag). A leaf
    // keeps a small bounded ring so a flood of retransmits for the same target
    // doesn't trigger redundant path-response announces.
    /** @type {string[]} */
    this.discoveryPrTags = [];
    /** @type {number} */
    this.maxPrTags = 256;
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
    // Since iface.writable is the input to the RNSFramerStream, we just get a writer for it
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
    log("Transport", `[-] Interface removed: ${iface.name}`, LogLevel.WARN);
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
      await this._handleAnnounce(packet);
      return; // STOP! Do not pass to any other logic.
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
   * @private
   */
  async _handleAnnounce(packet) {
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
        LogLevel.WARN,
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
   * @param {import("../core/packet.js").Packet} packet
   * @param {Uint8Array|null} linkId
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

    const nextHopInterface =
      this.routingTable.getRoute(packet.destinationHash)?.interface ||
      this.defaultInterface;

    if (nextHopInterface && nextHopInterface._packetWriter) {
      await nextHopInterface._packetWriter.write(packet);
    } else {
      throw new Error(`No route to host: ${destHex}`);
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
}
