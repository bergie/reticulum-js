/**
 * Receiver request-window adaptation (Python `Resource` window parity).
 *
 * The receiver's stop-and-wait window previously sat frozen at 4 parts per
 * round-trip: a 1 MB response took ~550 window round-trips, a 10 MB peer-sync
 * container ~5500 — transfers crawled, concurrency piled up, and the heap
 * filled with in-flight transfer buffers (the propagation/RFed OOM class).
 * The window now grows while the transfer drains healthily (toward 10 on
 * slow links, 75 on fast ones) and shrinks on watchdog stalls.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Resource, ResourceStatus } from "../../src/core/resource.js";
import { Link } from "../../src/transport/link.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * Builds a receiver-side resource the way `Resource.accept` would (skipping
 * the wire): a real Link for `sdu`/rtt, a hashmap of real part map-hashes,
 * and the matching part chunks.
 */
async function makeIncoming() {
  const link = Object.assign(
    new Link({
      destination: /** @type {any} */ ({}),
      linkId: rnd(16),
      transport: /** @type {any} */ ({ sendPacket: async () => true }),
      initiator: false,
    }),
    {
      rtt: 0,
      /** Plaintext passthrough stub — REQ bodies are never inspected here. */
      token: /** @type {any} */ ({ encrypt: async (data) => data }),
    },
  );

  const totalParts = 40;
  const resource = new Resource({ link });
  resource.status = ResourceStatus.TRANSFERRING;
  resource.hash = rnd(32); // registration key (accepted resources always have one)
  resource.totalParts = totalParts;
  resource.parts = new Array(totalParts).fill(null);
  resource.hashmap = [];
  resource.receivedCount = 0;
  resource.outstanding = 0;
  // The link watchdog drives registered transfers only.
  link._registerIncomingResource(resource);

  const chunks = [];
  for (let i = 0; i < totalParts; i++) {
    const chunk = rnd(100);
    chunks.push(chunk);
    // The map hash is whatever `_mapHash` computes over the chunk — derive
    // the hashmap from the chunks so every request round-trips.
    resource.hashmap.push(await resource._mapHash(chunk));
  }
  return { link, resource, chunks };
}

test("the window grows while the transfer drains healthily", async () => {
  const { resource, chunks } = await makeIncoming();

  // Drive windows manually: request → deliver the requested parts → drain.
  let maxWindowSeen = resource.window;
  let delivered = 0;
  while (resource.receivedCount < resource.totalParts) {
    await resource.requestNext();
    assert.ok(resource.outstanding > 0, "a window must be requested");
    maxWindowSeen = Math.max(maxWindowSeen, resource.window);

    // Deliver the outstanding parts: the first placement decrements
    // outstanding per part; the last placement triggers the next window.
    const outstandingIds = [];
    for (let i = 0; i < resource.hashmap.length; i++) {
      if (resource.parts[i] === null) outstandingIds.push(i);
    }
    for (const idx of outstandingIds) {
      if (resource.parts[idx] !== null) continue;
      // Deliver only the first `window` still-missing parts per round.
      if (resource.outstanding <= 0) break;
      await resource.receivePart(chunks[idx]);
      delivered++;
    }
  }

  assert.equal(delivered, resource.totalParts);
  assert.ok(
    resource.window > Resource.WINDOW,
    `window must grow past its initial value (saw max ${maxWindowSeen})`,
  );
  // With everything draining instantly (rate → ∞), the fast ceiling wins.
  assert.equal(
    resource.windowMax,
    Resource.WINDOW_MAX_FAST,
    "an infinitely fast link must earn the fast window ceiling",
  );
});

test("a watchdog stall shrinks the window", async () => {
  const { link, resource } = await makeIncoming();

  // Grow a little headroom first (healthy drains).
  resource.window = 6;
  resource.windowMin = 2;
  resource.windowMax = 10;

  // Stall: backdate activity, tick the watchdog — it consumes a retry and
  // shrinks the window.
  resource.lastActivity = Date.now() - 120_000;
  link._watchdogJob();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(resource.retriesLeft, Resource.MAX_RETRIES - 1);
  assert.ok(resource.window < 6, "the stall must shrink the window");
});
