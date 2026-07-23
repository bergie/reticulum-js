# @reticulum/core

The zero-dependency, browser-safe core of the [Reticulum Network System](https://reticulum.network/) for JavaScript.

Reticulum is a mesh networking stack designed for both local and wide-area networking. Reticulum applications can talk with each other over multiple different interfaces, ranging from TCP connections to LoRa radio. This allows building offline-first collaborative software that can work even when Internet infrastructure is compromised.

`@reticulum/core` is the main package of the [reticulum-js monorepo](../../README.md). It is **browser-safe** (no `node:` specifiers, no external runtime dependencies) and runs in modern browsers as well as server-side engines like Node.js and Deno. Node-only interfaces and interfaces that need external runtime dependencies live in [companion packages](../../README.md#packages).

## Building blocks

Reticulum gives several building blocks for enabling applications and users to communicate with each other:

- **Packets**: raw data packets, either as-is or over an established Link
- **LXMF Messages**: one-to-one structured payloads with store-and-forward capability. Think instant messaging, email, telemetry transfer
- **Request/Response**: calls to services, with optional request payloads and identification. Think `fetch`
- **Resources**: large chunkable file transport
- **Channels**: bidirectional data channels with a peer

On top of these, Reticulum handles peer discovery (via the Announce mechanism) and encryption and content signing (via Identities).

Read the [Zen of Reticulum](https://reticulum.network/manual/zen.html) for more information.

## Status

Early stages, but we are able to send and receive LXMF messages, and make NomadNet page requests.

At this point the aim is for JavaScript applications to be able to be _leaf nodes_ in a Reticulum mesh, meaning that they will not route traffic for others. Full capability of acting as a _transport node_ would be great to have and is on the roadmap.

## Installation

The canonical source of `@reticulum/core` is the rngit repository. To fetch the latest release, run:

```sh
rngit release rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js fetch latest:all
npm install reticulum-core-*.tgz
```

You can also get `@reticulum/core` [from NPM](https://www.npmjs.com/package/@reticulum/core):

```sh
npm install @reticulum/core
```

## Usage

The quickest way to use Reticulum.js is to attach to a local shared Reticulum
instance (for example, the `rnsd` daemon already running on your machine),
set up an identity, and exchange [LXMF](https://reticulum.network/manual/lxmf.html)
messages:

```js
import {
  fromHex,
  Identity,
  LXMessage,
  LXMRouter,
  Reticulum,
  toHex,
} from "@reticulum/core";
// TCP and shared-instance interfaces are Node-only — install `@reticulum/node`.
import {
  LocalClientInterface,
  TCPClientInterface,
} from "@reticulum/node";

// 1. Start the engine and configure interfaces
const rns = new Reticulum();

const shared = await LocalClientInterface.connectToSharedInstance();
if (shared) {
  // Shared `rnsd` daemon is auto-discovered from ~/.reticulum/config, so no
  // interface setup is needed when one is running.
  rns.addInterface(shared, true);
} else {
  // Fall back to a direct TCP interface when no shared instance is available.
  const tcp = new TCPClientInterface({ host: "127.0.0.1", port: 42424 });
  await tcp.connect();
  rns.addInterface(tcp, true);
}

// 2. Create an identity for this peer (persist it between runs in real apps)
const identity = await Identity.generate();
identity.setAppData("reticulum-js example");

// 3. Register the standard LXMF delivery destination and announce our presence
const lxmf = new LXMRouter(identity, rns);
await lxmf.init();
await lxmf.deliveryDest.announce();

console.log("My LXMF address:", toHex(lxmf.deliveryDest.destinationHash));

// 4. Receive incoming messages
lxmf.addEventListener("message", (event) => {
  const { message } = event.detail;
  console.log(`From ${toHex(message.sourceHash)}: ${message.content}`);
});

// 5. Send a message to a known peer LXMF address (16 bytes)
const outgoing = new LXMessage({
  sourceHash: lxmf.deliveryDest.destinationHash,
  destinationHash: fromHex("00112233445566778899aabbccddeeff"),
  content: "Hello over Reticulum!",
});
await lxmf.send(outgoing, identity, null);
```

> The destination address is the peer's `lxmf.delivery` destination hash. You
> typically learn it from an announce or out-of-band; substitute a real
> 16-byte hex address before sending.

A complete runnable version (with identity persistence and echo replies) lives
in [`examples/lxmf_echobot.js`](../../examples/lxmf_echobot.js).

## Interfaces

Network interfaces are **not** re-exported from the package main entry —
import the one you need directly by subpath. The browser-safe client
interfaces live in this package; Node-only interfaces live in the
[`@reticulum/node`](../node/README.md) companion.

**Browser-safe (this package):**

```js
import { HttpPostClientInterface } from "@reticulum/core/src/interfaces/http.js";
import { WebSocketClientInterface } from "@reticulum/core/src/interfaces/websocket.js";
import { WebRTCInterface } from "@reticulum/core/src/interfaces/webrtc.js";
```

| Interface subpath (`src/interfaces/...`) | Browser-safe | Runtime deps |
| --- | --- | --- |
| `base.js` (`Interface`) | ✅ | none |
| `http.js` (`HttpPostClientInterface`) | ✅ | none (uses `fetch`) |
| `websocket.js` (`WebSocketClientInterface`) | ✅ | none (Web APIs) |
| `webrtc.js` (`WebRTCInterface`) | ✅ | inject a `createPeerConnection` factory (see [`@reticulum/webrtc-node`](../webrtc-node/README.md) for Node) |

**Node-only (in [`@reticulum/node`](../node/README.md)):**

```js
import {
  AutoInterface,
  LocalClientInterface,
  TCPClientInterface,
  TCPServerInterface,
  HttpPostServerInterface,
} from "@reticulum/node";
```

`LocalClientInterface` also hosts the shared-instance endpoint discovery
(`getSharedInstanceEndpoint` / `loadConfig` / `parseConfigFile` /
`resolveConfigDir`, ported from the Python `~/.reticulum/config`) and a static
factory that discovers + connects in one call, returning a connected interface
(or `null` if `share_instance = No` / unreachable) for the caller to attach:

```js
import { LocalClientInterface } from "@reticulum/node";

const shared = await LocalClientInterface.connectToSharedInstance();
if (shared) rns.addInterface(shared, true);
```

### Paper messaging

LXMF messages can also be delivered completely out-of-band — printed on
paper, photographed as a QR code, or shared as a string — using the *paper*
delivery method. A paper message is encrypted to the recipient exactly like a
propagated one, but instead of travelling over the network it is encoded as an
`lxm://` URI that the recipient ingests later:

```js
import { LXMFConstants, LXMessage, toHex } from "@reticulum/core";

// Build the recipient's outbound lxmf.delivery destination from a recalled
// identity (typically learned from an announce).
const recipientOut = await Destination.OUT(
  "lxmf.delivery",
  DestType.SINGLE,
  recipientIdentity,
  rns,
);

const outgoing = new LXMessage({
  sourceHash: lxmf.deliveryDest.destinationHash,
  destinationHash: recipientOut.destinationHash,
  content: "Scanned from a QR code!",
});

// Produce the lxm:// URI (e.g. render it into a QR code). The encrypted
// payload must fit within LXMFConstants.PAPER_MDU bytes (QR-code capacity).
const uri = await outgoing.toPaperUri(identity, recipientOut);
console.log(uri); // lxm://...
```

On the receiving side, feed the URI straight into the router:

```js
lxmf.addEventListener("message", (event) => {
  const { message } = event.detail;
  console.log(`Paper message from ${toHex(message.sourceHash)}: ${message.content}`);
});

// `uri` was captured out-of-band (typed in, scanned, pasted).
const message = await lxmf.ingestUri(uri);
```

`ingestUri` decrypts with the local `lxmf.delivery` destination, dispatches the
usual `message` event, and de-duplicates by `transient_id` so scanning the same
QR code twice is harmless. You can also work at the `LXMessage` level directly
with `toPaperData` / `fromPaperData` / `fromPaperUri`.

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12).
