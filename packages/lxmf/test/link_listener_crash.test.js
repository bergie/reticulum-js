/**
 * Regression: the link backchannel `data` listener attached by
 * `LXMRouter._attachLinkMessageListeners` must not leak a rejection when
 * `_processIncomingMessage` throws. `dispatchEvent` discards listener
 * promises, so an uncaught async listener rejection surfaces as an unhandled
 * rejection and crashes the process under Node's default
 * `--unhandled-rejections=throw`. The delivery-destination listener (the
 * non-link path) already wraps in try/catch; this pins the same behaviour on
 * the link backchannel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LXMRouter } from "../src/router.js";

test("link backchannel data listener survives a throwing _processIncomingMessage", async () => {
  /** @type {Map<string, (e: any) => void>} */
  const listeners = new Map();
  const fakeLink = /** @type {any} */ ({
    linkId: new Uint8Array(16),
    addEventListener: (/** @type {string} */ type, cb) =>
      listeners.set(type, cb),
  });
  const fakeSelf = /** @type {any} */ ({
    deliveryDest: { destinationHash: new Uint8Array(16) },
    _processIncomingMessage: async () => {
      throw new Error("message store exploded");
    },
  });
  LXMRouter.prototype._attachLinkMessageListeners.call(fakeSelf, fakeLink);

  const onData = listeners.get("data");
  assert.ok(onData, "data listener must be attached");
  // Dispatch like the Link would. With the bug present the listener promise
  // rejects unhandled and the test run dies; with the fix it is caught and
  // logged.
  onData({
    detail: { packet: { payload: new Uint8Array(0) }, link: fakeLink },
  });
  // Give any rejection a chance to surface as unhandled before the test ends.
  await new Promise((r) => setTimeout(r, 100));
});
