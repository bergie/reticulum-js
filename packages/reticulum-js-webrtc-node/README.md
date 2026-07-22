# reticulum-js-webrtc-node

Node.js WebRTC support for [`reticulum-js`](../reticulum-js/README.md), backed by [werift](https://github.com/shinyoshiaki/werift).

## Why this package exists

Node.js has no native `RTCPeerConnection`. The `reticulum-js` core's WebRTC transport signaling ([`WebRTCSignaling`](../reticulum-js/src/webrtc/signaling.js)) is dependency-injection-first: it accepts a `createPeerConnection` factory and only falls back to the browser global when one is omitted. In a browser that just works; in Node you need to supply a factory. This package supplies one, backed by werift — a pure-JavaScript WebRTC implementation with no native/C++ build (important for Termux/Android dev).

## Installation

```sh
npm install reticulum-js-webrtc-node
```

This depends on [`reticulum-js`](https://www.npmjs.com/package/reticulum-js) and `werift` automatically.

## Usage

Pass `createPeerConnection` to `WebRTCSignaling` (or anywhere the core expects the factory):

```js
import { Reticulum, WebRTCSignaling } from "reticulum-js";
import { createPeerConnection } from "reticulum-js-webrtc-node";

const rns = new Reticulum();
// ...add at least one transport interface so signaling can reach peers...

const signaling = new WebRTCSignaling({
  rns,
  createPeerConnection,
  // rtcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
});
await signaling.start();
```

Once signaling opens a data channel with a peer, it wraps it in a `WebRTCInterface` and registers it with the transport as a high-bandwidth direct link. See the [WebRTC Transport document](../../documents/WebRTC%20Transport.md) for the cross-language wire format.

## What's included

| Export | Description |
| --- | --- |
| `createPeerConnection(config)` | Factory returning a werift `RTCPeerConnection`, duck-compatible with the shape the core expects |
| `RTCPeerConnection` | Re-exported werift class |

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12). See the [monorepo README](../reticulum-js/README.md) for project-wide information.
