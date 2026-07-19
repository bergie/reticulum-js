# Reticulum Network System for JavaScript

![reticulum-js logo](./assets/reticulum-js.png)

**reticulum-js** aims to produce a dependency-free JavaScript implementation of the [Reticulum Network System](https://reticulum.network/). Reticulum is a mesh networking stack designed for both local and wide-area networking. Reticulum applications can talk with each other over multiple different interfaces, ranging from TCP connections to Lora radio. This allows building offline-first collaborative software that can work even when Internet infrastructure is compromised.

## Building blocks

Reticulum gives several building blocks for enabling applications and users to communicate with each other:
* **Packets**: raw data packets, either as-is or over an established Link
* **LXMF Messages:**: one-to-one structured payloads with store-and-forward capability. Think instant messaging, email, telemetry transfer
* **Request/Response**: calls to services, with optional request payloads and identification. Think `fetch`
* **Resources**: large chunkable file transport
* **Channels**: bidirectional data channels with a peer

On top of these, Reticulum handles peer discovery (via the Announce mechanism) and encryption and content signing (via Identities).

Read the [Zen of Reticulum](https://reticulum.network/manual/zen.html) for more information.

## reticulum-js design principles

* Runs on both modern web browsers and server-side JS engines like Node.js and Deno
* Zero or minimal runtime dependencies (right now the only thing is that you need to bring your own `bz2` implementation if you deal with compressed resources)
* Support for various [different interfaces](https://reticulum.network/manual/interfaces.html) depending what a platform can do (for example, a browser can't connect to TCP interfaces)
* Asynchronous JavaScript API style using Promises and Web Streams
* Type-safe using JsDoc TypeScript annotations

The web platform has a very strong commitment and tradition for backwards compatibility. The fact that this Reticulum implementation relies only on features of the web platform means it will likely remain functional and maintainable for years or even decades to come.

## Status

Early stages, but we are able to send and receive LXMF messages, and make NomadNet page requests.

At this point the aim is for JavaScript applications to be able to be _leaf nodes_ in a Reticulum mesh, meaning that they will not route traffic for others. Full capability of acting as a _transport node_ would be great to have and is on the roadmap.

## Installation

The canonical source of `reticulum-js` is the rngit repository. To fetch the latest release, run:

```sh
rngit release rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js fetch latest:all
npm install reticulum-js-*.tgz
```

You can also get `reticulum-js` [from NPM](https://www.npmjs.com/package/reticulum-js):

```sh
npm install reticulum-js
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
} from "reticulum-js";
import { TCPClientInterface } from "reticulum-js/src/interfaces/tcp.js";
import { LocalClientInterface } from "reticulum-js/src/interfaces/local_client.js";

// 1. Start the engine and configure interfaces
const rns = new Reticulum();

const shared = await LocalClientInterface.connectToSharedInstance();
if (shared) {
  // Shared `rnsd` daemon is auto-discovered from ~/.reticulum/config, so no
  // interface setup is needed when one is running).
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
in [`examples/lxmf_echobot.js`](examples/lxmf_echobot.js).

## Interfaces

Network interfaces are **not** re-exported from the package main entry —
import the one you need directly by subpath:

```js
import { TCPClientInterface } from "reticulum-js/src/interfaces/tcp.js";
import { WebSocketClientInterface } from "reticulum-js/src/interfaces/websocket.js";
```

| Interface subpath (`src/interfaces/...`) | Browser-safe | Node.js runtime deps |
| --- | --- | --- |
| `base.js` | ✅ | none |
| `http.js` (`HttpPostClientInterface`) | ✅ | none (uses `fetch`) |
| `websocket.js` (`WebSocketClientInterface`) | ✅ | none (Web APIs) |
| `auto.js` (`AutoInterface`) | ❌ | `node:dgram` |
| `tcp.js` (`TCPClientInterface` / `TCPServerInterface`) | ❌ | `node:net`, `node:stream` |
| `local_client.js` (`LocalClientInterface`) | ❌ | `node:net`, `node:stream`, `node:fs`, `node:os`, `node:path` |
| `http_server.js` (`HttpPostServerInterface`) | ❌ | `node:crypto`, `node:http` |

`LocalClientInterface` also hosts the shared-instance endpoint discovery
(`getSharedInstanceEndpoint` / `loadConfig` / `parseConfigFile` /
`resolveConfigDir`, ported from the Python `~/.reticulum/config`) and a static
factory that discovers + connects in one call, returning a connected interface
(or `null` if `share_instance = No` / unreachable) for the caller to attach:

```js
import { LocalClientInterface } from "reticulum-js/src/interfaces/local_client.js";

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
import { LXMFConstants, LXMessage, toHex } from "reticulum-js";

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

## Development

This project is developed following [Reticulum Distributed Development](https://reticulum.network/manual/distributed.html) guidelines. The canonical source lives in `rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js`.

We also provide a sporadically updated GitHub mirror at `https://github.com/bergie/reticulum-js`.

## Discussion

See [this rns.recipes thread](https://rns.recipes/forum/showcase/reticulum-in-javascript) (also available on NomadNet `9ce92808be498e9e05590ff27cbfdfe4`).

## Acknowledgements

Prior art includes [Liam Cottle's rns.js](https://github.com/liamcottle/rns.js) and of course the [Python Reticulum Reference Implementation](https://github.com/markqvist/reticulum) itself. We have also benefited greatly from Salem Data's [Reticulum Wire Specifications](https://salemdata.net/public/reticulum/SPEC.html) work.

This project has been built with the assistance of various LLMs, both for conceptual planning and implementation. I acknowledge that AI code is not necessarily ideal, but at the same time, I'm [busy sailing](https://lille-oe.de).

## Support Reticulum-js

[Supporting the Reticulum Project](https://reticulum.network/donate.html) is the best way to support. If you want to support this JavaScript library directly, here are some ways:

* Ethereum: `0xFC872bA86812B2bbe90c38cfD2553F7865d04094`
* Liberapay: https://liberapay.com/bergie/
* ko-fi: https://ko-fi.com/bergius
