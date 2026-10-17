/**
 * Ingress robustness: the transport's interface "packet" listener drives the
 * entire ingress pipeline (announce ingest, dedup, proofs, path requests,
 * destination/link receive — and app handlers reached through them), but the
 * interface pumps dispatch it via `dispatchEvent`, which discards listener
 * promises. Any rejection in the pipeline must therefore be caught and logged
 * at the listener, or it surfaces as an unhandled rejection and crashes the
 * process under Node's default `--unhandled-rejections=throw`.
 *
 * Same invariant for the transport's maintenance sweep: `_sweepTick` is async
 * and invoked from `setInterval`, whose callback discards the returned promise.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { TransportCore } from "../../src/transport/transport.js";

test("ingress pipeline rejections are logged, not unhandled", async () => {
  const transport = new TransportCore();
  const iface = new EventTarget();
  iface.name = "mock";
  transport.addInterface(iface);

  // Break the ingress pipeline itself.
  transport._routeIncomingPacket = async () => {
    throw new Error("ingress exploded");
  };
  // The interface pump dispatches packets like this; with the bug present the
  // listener's rejected promise is discarded and the test run dies of an
  // unhandled rejection.
  iface.dispatchEvent(
    new CustomEvent("packet", { detail: { packet: { hops: 0 } } }),
  );
  await new Promise((r) => setTimeout(r, 50));
});

test("maintenance sweep failures are logged, not unhandled", async () => {
  const transport = new TransportCore();
  const iface = new EventTarget();
  iface.name = "sweep";
  iface.processHeldAnnounces = () => {
    throw new Error("held-announce processing exploded");
  };
  transport.addInterface(iface);
  // _sweepTick must not reject even when an interface's held-announce
  // processing throws.
  await transport._sweepTick();
  assert.ok(true);
});
