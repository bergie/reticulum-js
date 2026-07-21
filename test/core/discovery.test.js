/**
 * Reticulum-level wiring of interface discovery (work doc #17): the
 * `enableDiscovery` config flag constructs and starts an `InterfaceDiscovery`
 * bound to the instance's transport, and surfaces it as `rns.discovery`.
 */
import assert from "node:assert";
import test from "node:test";
import { Reticulum } from "../../src/core/reticulum.js";
import { InterfaceDiscovery } from "../../src/transport/discovery.js";

test("Reticulum({ enableDiscovery: true }) constructs and starts InterfaceDiscovery", async () => {
  const rns = new Reticulum({ enableDiscovery: true });
  assert.ok(rns.discovery instanceof InterfaceDiscovery);
  assert.ok(rns.discovery.startPromise instanceof Promise);
  await rns.discovery.startPromise;
  rns.discovery.stop();
});

test("Reticulum without enableDiscovery leaves rns.discovery null", () => {
  const rns = new Reticulum({});
  assert.strictEqual(rns.discovery, null);
});
