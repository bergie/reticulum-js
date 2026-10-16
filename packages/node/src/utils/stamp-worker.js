/**
 * @file stamp-worker.js
 * @description Worker-thread entry point for `@reticulum/node`'s stamp
 *   engine (work doc #45). Runs the synchronous `node:crypto` stamp
 *   primitives off the host's main thread, matching the Python reference's
 *   worker-process design (`LXStamper.job_linux`), so workblock builds and
 *   stamp searches never block the host application's event loop.
 *
 *   Protocol: each request is `{ id, op, args }` where `op` is `"workblock"`
 *   or `"generate"`; the response is `{ id, result }` or `{ id, error }`.
 */

/* @ts-self-types="../../types/src/utils/stamp-worker.d.ts" */

import { parentPort } from "node:worker_threads";
import { generateStampSync, stampWorkblockSync } from "./stamp-crypto.js";

if (!parentPort) {
  throw new Error("stamp-worker.js must be started as a worker thread");
}

parentPort.on("message", (/** @type {any} */ message) => {
  const { id, op, args } = message;
  try {
    /** @type {any} */
    let result;
    if (op === "workblock") {
      result = stampWorkblockSync(args[0], args[1]);
    } else if (op === "generate") {
      result = generateStampSync(args[0], args[1], args[2]);
    } else {
      throw new Error(`Unknown stamp worker op: ${op}`);
    }
    parentPort?.postMessage({ id, result });
  } catch (err) {
    parentPort?.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
