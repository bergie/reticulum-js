# Reticulum connectivity in browser

The aim of this project is to make JavaScript applications able to fully participate in Reticulum networks in both Node.js and browser. The browser sandbox obviously brings some limitations to this, primarily in that you cannot make direct TCP socket connections.

Because of this, reticulum-js applications running in browser environment need to operate using some non-standard (as in, not supported by the Reticulum Python reference implementation out of the box) interface.

Currently supported are:

* **WebSockets**: JavaScript client can connect to a Reticulum daemon supporting the WebSocket interface. Drop-in implementations exist, including https://github.com/nilu96/rnsWebsocketInterface
* **HTTP POST exchange**: the client polls an HTTP exchange server (a Reticulum "backbone") using plain `POST` requests — no WebSockets, no open ports, no persistent connection. The most firewall- and shared-hosting-friendly option. See [HTTP POST exchange](#http-post-exchange) below.

## HTTP POST exchange

As an alternative to WebSockets, reticulum-js ships an **HTTP POST exchange** transport (`HttpPostClientInterface`, registered as `http-client`). The client never holds an open connection: it periodically POSTs its queued outbound packets to an exchange server and receives any queued inbound packets in the HTTP response. The poll interval is adaptive — roughly 1 second while traffic is flowing, backing off to a few seconds when idle.

This is the most permissive browser connectivity option. Because it is just plain HTTP, it works in situations where WebSockets do not:

* shared hosting that does not allow long-lived connections or the WebSocket upgrade handshake
* strict corporate proxies and firewalls that block or break WebSockets
* delivery through CDNs and reverse proxies

The trade-off is latency: delivery is bounded by the poll interval rather than being near-instant as with a persistent WebSocket, so it is best suited to messaging-style traffic (e.g. LXMF, chat) rather than high-throughput links.

The exchange server is a Reticulum backbone that browser clients (and other nodes) attach to as interfaces. Two server implementations are compatible with the client:

* **`HttpPostServerInterface`** — a Node.js server shipped in this project, and a drop-in replacement for the PHP router. It spawns one interface per registered client and keeps per-client queues in memory. See `src/interfaces/http_server.js`.
* The standalone [Reticulum Post](https://github.com/jrl290/Reticulum-post) PHP router, for environments where PHP is easier to deploy than Node.js.

## Hosting a default server

If you are planning to release a browser application using reticulum-js, at this stage it is probably a good idea to host at least one server your clients can use as a default connection point — either an `rnsd` instance with the `WebSocketServerInterface`, or an HTTP exchange backbone (`HttpPostServerInterface` in Node.js, or the Reticulum Post PHP router). However, as networking situations differ, it is _very important_ to allow your users to configure their own Reticulum interfaces.

reticulum-js interfaces supply JSON Schemas for their configuration parameters. This can be used to construct a dynamic user interface for setting up interfaces.
