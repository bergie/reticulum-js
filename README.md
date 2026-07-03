# Reticulum.js - Reticulum Network System for JavaScript

This repository aims to produce a dependency-free JavaScript implementation of the [Reticulum Network System](https://reticulum.network/).

Some principles:
* Runs on both modern web browsers and server-side JS engines like Node.js and Deno
* Zero or minimal runtime dependencies
* Support for various [different interfaces](https://reticulum.network/manual/interfaces.html) depending what a platform can do (for example, browser can't connect to TCP interfaces)
* Asynchronous JavaScript API style using Promises and Web Streams
* Type-safe using JsDoc TypeScript annotations

## Status

Currently just a sketch.

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12).

## Development

This project is developed following [Reticulim Distributed Development](https://reticulum.network/manual/distributed.html) guidelines. The canonical source lives in `rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js`.

We also provide a sporadically updated GitHub mirror at `https://github.com/bergie/reticulum-js`.

## Acknowledgements

Prior art includes [Liam Cottle's rns.js](https://github.com/liamcottle/rns.js).
