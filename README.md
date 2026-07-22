# Reticulum Network System for JavaScript

![reticulum-js logo](./assets/reticulum-js.png)

**reticulum-js** is a dependency-free JavaScript implementation of the [Reticulum Network System](https://reticulum.network/). Reticulum is a mesh networking stack designed for both local and wide-area networking. Reticulum applications can talk with each other over multiple different interfaces, ranging from TCP connections to LoRa radio. This allows building offline-first collaborative software that can work even when Internet infrastructure is compromised.

This repository is an npm-workspaces monorepo: a browser-safe **core** package plus small **companion** packages that add Node-only or external-dependency interfaces.

## Packages

| Package | What it provides | Runtime deps |
| --- | --- | --- |
| [`reticulum-js`](packages/reticulum-js/README.md) | The core: Reticulum engine, Identity, LXMF, Links, Resources, Channels, and the browser-safe client interfaces (HTTP, WebSocket, WebRTC) | none (zero-dependency, browser-safe) |
| [`reticulum-js-node`](packages/reticulum-js-node/README.md) | Node.js interfaces (TCP, AutoInterface, LocalClient/shared-instance, HTTP POST server) and the interface registry | Node builtins only |
| [`reticulum-js-webrtc-node`](packages/reticulum-js-webrtc-node/README.md) | `createPeerConnection` factory backed by werift, for the core's WebRTC transport on Node | `werift` |
| [`reticulum-js-websocket-server-node`](packages/reticulum-js-websocket-server-node/README.md) | Inbound WebSocket **server** interface, backed by ws | `ws` |

Start with [`reticulum-js`](packages/reticulum-js/README.md) — the companions just add interfaces the browser-safe core can't ship.

## Design principles

- Runs on both modern web browsers and server-side JS engines like Node.js and Deno
- Zero or minimal runtime dependencies (right now the only thing is that you need to bring your own `bz2` implementation if you deal with compressed resources)
- Support for various [different interfaces](https://reticulum.network/manual/interfaces.html) depending what a platform can do (for example, a browser can't connect to TCP interfaces)
- Asynchronous JavaScript API style using Promises and Web Streams
- Type-safe using JsDoc TypeScript annotations

The web platform has a very strong commitment and tradition for backwards compatibility. The fact that this implementation relies only on features of the web platform means it will likely remain functional and maintainable for years or even decades to come.

## Status

Early stages, but we are able to send and receive LXMF messages, and make NomadNet page requests.

At this point the aim is for JavaScript applications to be able to be _leaf nodes_ in a Reticulum mesh, meaning that they will not route traffic for others. Full capability of acting as a _transport node_ would be great to have and is on the roadmap.

See the [core package README](packages/reticulum-js/README.md) for building blocks, installation, and a usage example.

## Documentation

- **API docs:** [reticulum.js.org](https://reticulum.js.org/)
- **Protocol specs:** [SPEC.md](SPEC.md) and [PROTOCOL-SPEC.md](PROTOCOL-SPEC.md)
- **Reticulum manual:** [reticulum.network/manual](https://reticulum.network/manual/)

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

- Ethereum: `0xFC872bA86812B2bbe90c38cfD2553F7865d04094`
- Liberapay: https://liberapay.com/bergie/
- ko-fi: https://ko-fi.com/bergius
