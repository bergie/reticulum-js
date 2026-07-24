/**
 * @file index.js
 * @description @reticulum/node — Node.js-only Reticulum interfaces and the
 *   interface registry, as a companion to the zero-dependency, browser-safe
 *   `@reticulum/core` core.
 *
 * These interfaces use Node.js built-in modules (`node:net`, `node:dgram`,
 * `node:http`, `node:crypto`, …) and so live outside the browser-safe core.
 * Import the interface you need directly, e.g.:
 *
 *   import { TCPClientInterface, getInterface } from "@reticulum/node";
 *
 * The registry aggregates every built-in interface (including the
 * browser-safe ones from `@reticulum/core`) so a Node process can discover
 * interface configuration schemas by id.
 */

/* @ts-self-types="../types/src/index.d.ts" */

export { AutoInterface } from "./interfaces/auto.js";
export { HttpPostServerInterface } from "./interfaces/http_server.js";
export { LocalClientInterface } from "./interfaces/local_client.js";
export {
  getInterface,
  getSchema,
  listInterfaces,
  registerInterface,
} from "./interfaces/registry.js";
export { TCPClientInterface, TCPServerInterface } from "./interfaces/tcp.js";
export { FileStorageAdapter } from "./storage/file.js";
