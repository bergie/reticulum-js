# @reticulum/websocket-server-node

Node.js WebSocket **server** interface for [`@reticulum/core`](../core/README.md), backed by [ws](https://github.com/websockets/ws).

## Why this package exists

The `@reticulum/core` core ships the `WebSocketClientInterface` (a WebSocket *client*, browser-safe via Web APIs). A WebSocket *server*, however, cannot run in a browser and Node does not ship one natively. This companion listens for inbound WebSocket connections and spawns a `WebSocketClientInterface` per accepted connection, mirroring `TCPServerInterface`.

## Installation

```sh
npm install @reticulum/websocket-server-node
```

This depends on [`@reticulum/core`](https://www.npmjs.com/package/@reticulum/core) and `ws` automatically.

## Usage

```js
import { Reticulum } from "@reticulum/core";
import { WebSocketServerInterface } from "@reticulum/websocket-server-node";

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

## TLS / `wss://`

Browsers running in a secure context (an HTTPS page) cannot open `ws://`
connections (mixed-content blocking), so a browser-facing server must terminate
TLS and listen for `wss://`. Enable it with `ssl: true` plus the PEM certificate
chain and private key paths (mirrors the Python reference `ssl`/`certfile`/
`keyfile` config keys):

```js
import fs from "node:fs";

const server = new WebSocketServerInterface({
  listenPort: 443,
  ssl: true,
  certFile: "/etc/letsencrypt/live/ws.example.com/fullchain.pem",
  keyFile: "/etc/letsencrypt/live/ws.example.com/privkey.pem",
});
await server.connect();
```

A `WebSocketClientInterface` then connects with the `ssl` option (or a `wss://`
`url`) — the standard `WebSocket` API negotiates TLS from the scheme:

```js
const client = new WebSocketClientInterface({
  host: "ws.example.com",
  port: 443,
  ssl: true, // builds wss://ws.example.com:443
});
await client.connect();
```

The constructor validates the options the same way the Python reference does:
enabling `ssl` requires **both** `certFile` and `keyFile`, and providing either
without `ssl` is rejected (it would silently do nothing).

> When a reverse proxy such as Caddy or nginx terminates TLS in front of the
> server, leave `ssl` off here and bind to a private or loopback address; the
> proxy offers `wss://` to remote clients.

## What's included

| Export | Interface id | Runtime deps | Notes |
| --- | --- | --- | --- |
| `WebSocketServerInterface` | `ws-server` | `ws` | Spawns a `WebSocketClientInterface` per accepted connection; server itself never carries packets |

> Note: the interface registry in [`@reticulum/node`](../node/README.md) does **not** register `ws-server` (that would force it to depend on `ws`). Register it yourself with `registerInterface` if you want it in a schema enumeration.

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12). See the [monorepo README](../core/README.md) for project-wide information.
