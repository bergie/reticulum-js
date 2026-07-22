# reticulum-js-node

Node.js-only Reticulum interfaces and the interface registry, as a companion to the zero-dependency, browser-safe [`reticulum-js`](../reticulum-js/README.md) core.

## Why this package exists

The `reticulum-js` core must stay browser-safe (no `node:` specifiers, no external runtime dependencies). Several interfaces — TCP, the zero-config IPv6-multicast `AutoInterface`, the local shared-instance client, and the HTTP POST exchange server — are built on Node.js built-in modules (`node:net`, `node:dgram`, `node:http`, `node:crypto`, `node:fs`, `node:os`, `node:path`). They live here, in this companion, so importing `reticulum-js` in a browser never pulls in Node builtins.

## Installation

```sh
npm install reticulum-js-node
```

This depends on [`reticulum-js`](https://www.npmjs.com/package/reticulum-js) automatically.

## Usage

Import the interface you need from the package entry:

```js
import { Reticulum } from "reticulum-js";
import {
  AutoInterface,
  LocalClientInterface,
  TCPClientInterface,
} from "reticulum-js-node";

const rns = new Reticulum();

// Attach to a running shared `rnsd` if one is available, else dial TCP directly.
const shared = await LocalClientInterface.connectToSharedInstance();
if (shared) {
  rns.addInterface(shared, true);
} else {
  const tcp = new TCPClientInterface({ host: "127.0.0.1", port: 42424 });
  await tcp.connect();
  rns.addInterface(tcp, true);
}
```

## What's included

| Export | Interface id | Node builtins | Notes |
| --- | --- | --- | --- |
| `TCPClientInterface` / `TCPServerInterface` | `tcp-client` / `tcp-server` | `node:net`, `node:stream` | Optional HDLC or KISS framing |
| `AutoInterface` | `auto` | `node:dgram` | Zero-config IPv6-multicast LAN/Wi-Fi peering |
| `LocalClientInterface` | `local-client` | `node:net`, `node:fs`, `node:os`, `node:path` | Shared-instance client + `~/.reticulum/config` discovery |
| `HttpPostServerInterface` | `http-server` | `node:crypto`, `node:http` | In-memory Reticulum-post exchange server |

### Interface registry

The registry aggregates every built-in interface — including the browser-safe
ones from `reticulum-js` — so a Node process can enumerate interfaces and look
up their configuration schemas by id:

```js
import {
  getInterface,
  getSchema,
  listInterfaces,
  registerInterface,
} from "reticulum-js-node";

for (const meta of listInterfaces()) {
  console.log(meta.id, meta.title);
}
```

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12). See the [monorepo README](../reticulum-js/README.md) for project-wide information.
