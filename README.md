# Reticulum.js - Reticulum Network System for JavaScript

This repository aims to produce a dependency-free JavaScript implementation of the [Reticulum Network System](https://reticulum.network/).

Some principles:
* Runs on both modern web browsers and server-side JS engines like Node.js and Deno
* Zero or minimal runtime dependencies
* Support for various [different interfaces](https://reticulum.network/manual/interfaces.html) depending what a platform can do (for example, browser can't connect to TCP interfaces)
* Asynchronous JavaScript API style using Promises and Web Streams
* Type-safe using JsDoc TypeScript annotations

## Status

Early stages, but we are able to send and receive LXMF messages.

## Installation

The canonical source of `reticulum-js` is the rngit repository. To fetch the latest release, run:

```sh
rngit release rns://3ea5aad068a337670f5bb8073226adb4/public/reticulum-js fetch latest:all
npm install reticulum-js-*.tgz
```

You can also get `reticulum-js` [from NPM](https://www.npmjs.com/package/reticulum-js):

```sh
npm install reticulum-js
```

## Usage

The quickest way to use Reticulum.js is to connect to a Reticulum transport
node (for example, the local `rnsd` daemon over TCP), set up an identity, and
exchange [LXMF](https://reticulum.network/manual/lxmf.html) messages:

```js
import {
  fromHex,
  Identity,
  LXMessage,
  LXMRouter,
  Reticulum,
  TCPClientInterface,
  toHex,
} from "reticulum-js";

// 1. Start the engine and connect to a transport node over TCP
const rns = new Reticulum();

const tcp = new TCPClientInterface({ host: "127.0.0.1", port: 42424 });
await tcp.connect();
rns.addInterface(tcp, true);

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

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12).

## Development

This project is developed following [Reticulum Distributed Development](https://reticulum.network/manual/distributed.html) guidelines. The canonical source lives in `rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js`.

We also provide a sporadically updated GitHub mirror at `https://github.com/bergie/reticulum-js`.

## Acknowledgements

Prior art includes [Liam Cottle's rns.js](https://github.com/liamcottle/rns.js).

## Support Reticulum-js

[Supporting the Reticulum Project](https://reticulum.network/donate.html) is the best way to support. If you want to support this JavaScript library directly, here are some ways:

* Ethereum: `0xFC872bA86812B2bbe90c38cfD2553F7865d04094`
* Liberapay: https://liberapay.com/bergie/
* ko-fi: https://ko-fi.com/bergius
