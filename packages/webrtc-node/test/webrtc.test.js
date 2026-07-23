import assert from "node:assert";
import { test } from "node:test";
import { createPeerConnection, RTCPeerConnection } from "../src/index.js";

/**
 * @file webrtc.test.js
 * @description Smoke tests for the werift-backed `createPeerConnection` factory.
 *   Node has no native WebRTC, so these exercise the real werift stack that this
 *   package exists to provide to @reticulum/core's `WebRTCSignaling`.
 */

test("createPeerConnection returns a werift RTCPeerConnection with the WebRTC API the core expects", () => {
  const pc = createPeerConnection();
  try {
    assert.ok(pc instanceof RTCPeerConnection, "returns a werift instance");
    for (const method of [
      "createDataChannel",
      "createOffer",
      "createAnswer",
      "setLocalDescription",
      "setRemoteDescription",
      "addIceCandidate",
      "close",
    ]) {
      assert.equal(
        typeof pc[method],
        "function",
        `pc.${method} must be a function`,
      );
    }
  } finally {
    pc.close();
  }
});

test("createPeerConnection forwards configuration (e.g. iceServers)", async () => {
  const pc = createPeerConnection({ iceServers: [] });
  try {
    // An empty ICE server list still yields a constructable peer connection;
    // creating an offer confirms the config was accepted without throwing.
    const offer = await pc.createOffer();
    assert.ok(offer, "createOffer returns a description");
    assert.ok(typeof offer.type === "string");
  } finally {
    pc.close();
  }
});

test("two werift peers exchange data over a data channel", async () => {
  const pc1 = createPeerConnection();
  const pc2 = createPeerConnection();
  try {
    // Trickle ICE: forward candidates each side gathers to the other.
    pc1.addEventListener("icecandidate", (e) => {
      if (e.candidate) pc2.addIceCandidate(e.candidate);
    });
    pc2.addEventListener("icecandidate", (e) => {
      if (e.candidate) pc1.addIceCandidate(e.candidate);
    });

    // Resolve once a byte arrives on pc2's inbound data channel.
    const received = new Promise((resolve) => {
      pc2.addEventListener("datachannel", ({ channel }) => {
        channel.addEventListener("message", (e) => resolve(e.data));
      });
    });

    const dc = pc1.createDataChannel("reticulum-js-smoke");
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    dc.send("hello over werift");
    const msg = await received;
    assert.equal(
      msg instanceof Uint8Array ? new TextDecoder().decode(msg) : String(msg),
      "hello over werift",
    );
  } finally {
    pc1.close();
    pc2.close();
  }
});
