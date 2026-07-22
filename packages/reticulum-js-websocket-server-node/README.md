# reticulum-js-websocket-server-node

Node.js WebSocket **server** interface for [`reticulum-js`](../reticulum-js/README.md), backed by [ws](https://github.com/websockets/ws).

## Why this package exists

The `reticulum-js` core ships the `WebSocketClientInterface` (a WebSocket *client*, browser-safe via Web APIs). A WebSocket *server*, however, cannot run in a browser and Node does not ship one natively. This companion listens for inbound WebSocket connections and spawns a `WebSocketClientInterface` per accepted connection, mirroring `TCPServerInterface`.

## Installation

```sh
npm install reticulum-js-websocket-server-node
```

This depends on [`reticulum-js`](https://www.npmjs.com/package/reticulum-js) and `ws` automatically.

## Usage

```js
import { Reticulum } from "reticulum-js";
import { WebSocketServerInterface } from "reticulum-js-websocket-server-node";

const rns = new Reticulum();

const server = new WebSocketServerInterface({ listenPort: 4242 });
server.addEventListener("connection", (event) => {
  // Each accepted connection is a spawned WebSocketClientInterface; attach it
  // to the transport. The server copies its bitrate onto each spawned client.
  rns.addInterface(event.detail, false);
});
await server.connect();
```

Set `framing: "kiss"` for RNode-style KISS-over-WebSocket peers (defaults to `raw`).

## What's included

| Export | Interface id | Runtime deps | Notes |
| --- | --- | --- | --- |
| `WebSocketServerInterface` | `ws-server` | `ws` | Spawns a `WebSocketClientInterface` per accepted connection; server itself never carries packets |

> Note: the interface registry in [`reticulum-js-node`](../reticulum-js-node/README.md) does **not** register `ws-server` (that would force it to depend on `ws`). Register it yourself with `registerInterface` if you want it in a schema enumeration.

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12). See the [monorepo README](../reticulum-js/README.md) for project-wide information.
