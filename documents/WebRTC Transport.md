# WebRTC Transport

**Status:** Implemented (JS), cross-language specification.
**Canonical JS implementation:** [`src/webrtc/signaling.js`](../src/webrtc/signaling.js),
[`src/interfaces/webrtc.js`](../src/interfaces/webrtc.js).
**Work document:** [#19 — WebRTC interface](https://github.com/bergie/reticulum-js)
(tracking).

This document specifies the **WebRTC transport upgrade** for Reticulum: a
mechanism that bridges Reticulum's low-bandwidth, MTU-constrained discovery
protocol with a high-bandwidth, NAT-traversing WebRTC data channel between two
peers. It exists so that implementations in JavaScript, Python, Node.js and
other languages can interoperate.

This transport is **not** part of the Python Reticulum reference
implementation. The JavaScript implementation (`reticulum-js`) is the first and
defines the wire format recorded here; other implementations MUST match it.

## Why

Reticulum's base MTU is 500 bytes and discovery is built for low-bandwidth,
high-latency links (LoRa, packet radio). Real-time, high-throughput
applications — e.g. Yjs CRDT synchronisation between collaborative editors —
need far more than that. WebRTC gives two peers a direct, DTLS-encrypted
`RTCDataChannel` with ~16 KiB message sizes and sub-second latency, while
Reticulum still handles discovery, routing, and the encrypted signaling of the
WebRTC session itself.

The result is a **two-stage connection lifecycle**:

1. **Signaling & SDP exchange** over ordinary Reticulum packets (announce +
   Link + Resource), which tolerates the 500-byte MTU and multi-hop mesh.
2. **Transport upgrade** to a direct WebRTC data channel, registered as an
   ordinary Reticulum interface once it is open.

## Roles and names

Both peers own a **SINGLE** Reticulum destination sharing the same application
name:

| Constant | Value | Notes |
|---|---|---|
| Destination name | `rns.webrtc` | Configurable; both peers MUST agree. |
| Destination type | `SINGLE` | Has an identity; announces are signed. |
| `app_data` (capability flag) | `0x01` | One byte. Identifies a WebRTC peer. |

The destination name is a normal Reticulum dotted aspect string. The
application may override it (e.g. `"noflo_editor.webrtc_peer"`) to run multiple
isolated WebRTC peer meshes on one node; peers using different names never see
each other.

The `app_data` byte is a **bitmask**. `0x01` currently means "WebRTC peer,
non-trickle ICE". Higher bits are reserved for future capability signalling
(e.g. trickle ICE). A receiver tests `(app_data[0] & 0x01) == 0x01`. Unknown
bits MUST be ignored, and an `app_data` that does not start with byte `0x01`
(set) MUST NOT be treated as a WebRTC peer.

> Implementation detail: peers filter announces by matching the destination
> name's 10-byte `name_hash` (`SHA-256(name)[:10]`), then by the capability
> flag in `app_data`. This avoids a separate announce-handler registry.

## The SDP transfer envelope

WebRTC session descriptions (SDP) are too large for a single Reticulum packet
(typically 1–4 KiB). They are transferred as **Reticulum Resources** over an
encrypted **Link**, which transparently fragment, sequence, checksum, and
re-assemble the payload across the 500-byte MTU.

Each Resource carries a tiny framed envelope so the receiver can distinguish
message types unambiguously (the signaling Link is dedicated, but self-
describing bytes survive future additions like trickle ICE without protocol
changes):

```
 byte 0    : message type
 bytes 1.. : UTF-8 SDP text (for OFFER / ANSWER)
```

| Message type | Byte value | Contents after the type byte | Direction |
|---|---|---|---|
| `OFFER` | `0x01` | Full SDP offer (with ICE candidates) | initiator → responder |
| `ANSWER` | `0x02` | Full SDP answer (with ICE candidates) | responder → initiator |
| `CANDIDATE` | `0x03` | _Reserved_ — a trickle-ICE candidate | future |

**First cut is non-trickle.** Each side waits for ICE gathering to reach
`complete` and ships its full local description (SDP including all gathered
candidates) in a single Resource. Trickle ICE (incremental `0x03` candidate
messages) is a future optimisation; reserving the type byte now keeps that
addition wire-compatible.

Resources carrying SDP SHOULD be sent **uncompressed** (no bz2): SDP is small
and this keeps the signaling path free of any compression dependency. A
receiver SHOULD cap the accepted Resource size at 64 KiB (`MAX_SDP_SIZE`) as a
§10.4 bomb defense — WebRTC SDP is never that large.

## Connection lifecycle

```
  Initiator (A)                                 Responder (B)
  ─────────────                                  ────────────
  Destination "rns.webrtc", SINGLE               Destination "rns.webrtc", SINGLE
  app_data = 0x01                                app_data = 0x01
  announce()  ──────────── announce ────────►    (hears A; path table updated)
                 ◄────────── announce ─────────  announce()

  (application decides to connect)

  Destination.OUT(B)  ──── LINKREQUEST ───────► acceptLink()
  createLink()                 ◄──── LRPROOF ───  (responder signs with identity)
      ◄──── LRRTT ──────────                    (link ACTIVE on both sides)

  RTCPeerConnection.createDataChannel("reticulum")
  createOffer() → setLocalDescription(offer)
  (wait for ICE gathering == complete)
  Resource(OFFER)      ──── RESOURCE_ADV/parts ─►  resource.whenComplete()
                                                       setRemoteDescription(offer)
                                                       → fires "datachannel"
                                                       createAnswer()
                                                       → setLocalDescription(answer)
                                                       (wait for ICE gathering == complete)
                       ◄──── RESOURCE_ADV/parts ───  Resource(ANSWER)
  resource.whenComplete()
  setRemoteDescription(answer)

  ... RTCDataChannel reaches "open" on both sides ...

  wrap channel → WebRTCInterface                   wrap channel → WebRTCInterface
  rns.addInterface(iface)                          rns.addInterface(iface)
  link.teardown()                                  link.teardown()
```

### Initiator sequence

1. Recall the responder's identity from its announce (`Destination.recall`).
2. Build an OUT destination with the shared name and that identity.
3. Open an encrypted Link to it (`Link.initiate` / `createLink`) and wait for
   it to become `ACTIVE`.
4. Create an `RTCPeerConnection` and a data channel (label `"reticulum"`).
5. `createOffer()` → `setLocalDescription(offer)` → wait for ICE gathering to
   complete (non-trickle).
6. Send the offer as a Resource with framing byte `0x01` + the offer SDP.
7. Await the answer Resource (framing byte `0x02`).
8. `setRemoteDescription({ type: "answer", sdp })`.
9. When the data channel opens, wrap it in a WebRTC interface and register it
   with the transport. Tear down the signaling link.

### Responder sequence

1. On an incoming `LINKREQUEST` on the signaling destination, accept the link.
2. On the link's first Resource, await completion and parse the framing byte.
   It MUST be `0x01` (OFFER).
3. Create an `RTCPeerConnection` and register a handler for its `datachannel`
   event (the negotiated channel arrives there once the offer is applied).
4. `setRemoteDescription({ type: "offer", sdp })`.
5. `createAnswer()` → `setLocalDescription(answer)` → wait for ICE gathering.
6. Send the answer as a Resource with framing byte `0x02` + the answer SDP.
7. When the data channel (from step 3) opens, wrap and register it
   symmetrically. Tear down the signaling link.

## Transport upgrade — the WebRTC interface

Once a data channel is `open`, it is wrapped as an ordinary Reticulum interface
and registered with the node's transport/routing layer (`rns.addInterface`).
From that point, RNS traffic between the two peers flows over the WebRTC
channel; the signaling Link has done its job and is torn down.

The interface is **message-oriented** with **raw framing**: one RNS packet (in
its raw wire form, no HDLC `0x7E` byte-stuffing) per binary message, because an
`RTCDataChannel` is already a reliable, ordered, message-bounded transport.

Each inbound binary message is parsed into a `Packet` and dispatched; each
outbound `Packet` is serialized and sent as one binary message. Messages that
are not binary, or no larger than the RNS header minimum (19 bytes), are
silently dropped (defensive floor, matching every reference interface).

The interface advertises a nominal **bitrate of 50 000 000** (~50 Mbit/s):
the channel is a direct peer link, far above any RF transport. (Note: at
present the JS transport selects outbound interfaces by hop count, not by
bitrate — a direct 1-hop WebRTC path wins over N mesh hops that way. Full
bitrate-based prioritisation is a separate, deferred task; see work doc #19.)

The interface is **not a reconnecting dialer**. Re-establishing a WebRTC
session requires re-running signaling, so a closed channel is terminal: the
application builds a fresh interface by initiating a new connection.

## Implementation constants

These are the canonical values from the JS implementation; other languages
MUST use the same values.

| Constant | Value |
|---|---|
| Default destination name | `"rns.webrtc"` |
| Capability flag (app_data byte) | `0x01` |
| SDP type — OFFER | `0x01` |
| SDP type — ANSWER | `0x02` |
| SDP type — CANDIDATE (reserved) | `0x03` |
| Max accepted SDP Resource size | `65536` bytes (`64 * 1024`) |
| Data channel label | `"reticulum"` |
| WebRTC interface nominal bitrate | `50000000` bits/s |
| ICE mode (first cut) | non-trickle (full local description per Resource) |

## Dependencies

An implementation needs:

- A Reticulum stack providing: SINGLE destinations with `app_data`, signed
  announces, the transport `"announce"` event (or equivalent announce-handler
  registry), encrypted Links, and the Resource transfer protocol
  (advertisement + windowed parts + proof).
- A WebRTC runtime providing the standard `RTCPeerConnection` /
  `RTCDataChannel` API (`createOffer`, `createAnswer`, `setLocalDescription`,
  `setRemoteDescription`, `createDataChannel`, the `datachannel` event, and
  ICE gathering state).

The JS core is **dependency-injection-first**: it never imports a WebRTC
runtime. Browsers use the global `RTCPeerConnection` automatically; Node.js
has no native WebRTC and obtains one from a companion package; tests inject a
mock. Implementations in other languages should follow the same seam so the
signaling state machine is testable without a live network.

Suggested runtimes:

- **Browser:** native `RTCPeerConnection` / `RTCDataChannel`.
- **Python:** [`aiortc`](https://github.com/aiortc/aiortc) (BSD-3-Clause —
  compatible with this project's EUPL-1.2).
- **Node.js:** [`node-datachannel`](https://github.com/murat-dogan/node-datachannel)
  or `wrtc` (MIT), via a companion package.

For NAT traversal, pass STUN/TURN servers through the WebRTC configuration
(`iceServers`) when constructing the peer connection; this is the application's
responsibility, not the protocol's.

## Sketch: Python (reference-flavoured pseudocode)

Illustrative only — names follow the Python Reticulum reference (`RNS.*`):

```python
# --- Both peers: announce capability ---
identity = RNS.Identity()
dest = RNS.Destination(identity, RNS.Destination.IN, RNS.Destination.SINGLE, "rns.webrtc")
dest.set_default_app_data(bytes([0x01]))   # capability flag
dest.announce()

# Filter announces for the "rns.webrtc" name_hash + the 0x01 app_data flag.
class WebRTCAnnounceHandler(RNS.Transport.AnnounceHandler):
    received_aspect = "rns.webrtc"
    def received_announce(self, destination_hash, announced_identity, app_data):
        if not (app_data and len(app_data) >= 1 and (app_data[0] & 0x01)):
            return
        # surface peer (destination_hash, announced_identity) to the app

# --- Initiator ---
out = RNS.Destination(announced_identity, RNS.Destination.OUT,
                      RNS.Destination.SINGLE, "rns.webrtc")
link = RNS.Link(out); link.activate()              # LINKREQUEST / LRPROOF / LRRTT

pc = RTCPeerConnection(configuration=rtc_config)    # aiortc
dc = pc.createDataChannel("reticulum")
offer = await pc.createOffer(); await pc.setLocalDescription(offer)
await wait_for_ice_complete(pc)                      # non-trickle
await send_resource(link, 0x01, pc.localDescription.sdp.encode())   # OFFER
answer_sdp = await receive_resource(link, expect=0x02)             # ANSWER
await pc.setRemoteDescription(SessionDescription(sdp=answer_sdp, type="answer"))
await dc_open(dc)
transport.add_interface(WebRTCInterface(dc, pc))     # raw framing, bitrate 50_000_000
await link.teardown()

# --- Responder: on link + first Resource ---
def on_incoming_link_request(...): link = dest.accept_request(...)
def on_resource(resource):
    data = resource.data                            # assembled bytes
    assert data[0] == 0x01                          # OFFER
    pc = RTCPeerConnection(configuration=rtc_config)
    @pc.on("datachannel")
    def _(channel): adopt_when_open(channel, pc)
    await pc.setRemoteDescription(SessionDescription(sdp=data[1:].decode(), type="offer"))
    answer = await pc.createAnswer(); await pc.setLocalDescription(answer)
    await wait_for_ice_complete(pc)
    await send_resource(link, 0x02, pc.localDescription.sdp.encode())  # ANSWER
```

`send_resource` frames and ships a Resource:

```python
def send_resource(link, type_byte, sdp_bytes):
    framed = bytes([type_byte]) + sdp_bytes
    RNS.Resource(framed, link, auto_compress=False).advertise()

def receive_resource(link, expect):
    # await the link's first Resource; return its SDP bytes (after type check)
    ...
```

## Security and trust considerations

- The signaling Link is an ordinary Reticulum Link — end-to-end encrypted,
  mutually authenticated via the peers' identities (the responder signs the
  LRPROOF with its long-term identity key). An attacker cannot MITM the SDP
  exchange without breaking Reticulum link security.
- The WebRTC channel itself is DTLS-encrypted end-to-end (SDP fingerprints are
  carried inside the Link-encrypted Resources), so a tampered SDP would fail
  DTLS fingerprint verification even if the signaling were compromised.
- Accepting an inbound SDP Resource is bounded by `MAX_SDP_SIZE` (64 KiB) as a
  denial-of-service guard.
- Peer discovery does not imply trust: hearing an announce only means "this
  destination claims WebRTC capability". Whether to connect is an application
  policy decision (the JS orchestrator surfaces peers via events and never
  auto-connects).

## Open / deferred

- **Trickle ICE** (`0x03` candidate messages) — type reserved, not yet used.
- **Bitrate-based interface prioritisation** — the `bitrate` property exists
  on every interface; selection by bitrate is a separate task.
- **Node.js runtime** — needs a native WebRTC dependency; ships as a separate
  companion package, not in the browser-safe core.
