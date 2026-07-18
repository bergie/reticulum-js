# Reticulum connectivity in browser

The aim of this project is to make JavaScript applications able to fully participate in Reticulum networks in both Node.js and browser. The browser sandbox obviously brings some limitations to this, primarily in that you cannot make direct TCP socket connections.

Because of this, reticulum-js applications running in browser environment need to operate using some non-standard (as in, not supported by the Reticulum Python reference implementation out of the box) interface.

Currently supported are:

* **WebSockets**: JavaScript client can connect to a Reticulum daemon supporting the WebSocket interface. Drop-in implementations exist, including https://github.com/nilu96/rnsWebsocketInterface

If you are planning to release a browser application using reticulum-js, at this stage it is probably a good idea to host at least one `rnsd` instance supporting the WebSocketServerInterface so your clients have a default place to connect to. However, as networking situations differ, it is _very important_ to allow your users to configure their own Reticulum interfaces.

reticulum-js interfaces supply JSON Schemas for their configuration parameters. This can be used to construct a dynamic user interface for setting up interfaces.
