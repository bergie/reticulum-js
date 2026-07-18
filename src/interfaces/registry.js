/**
 * @file registry.js
 * @description A registry of available interface classes keyed by a stable
 *   string identifier, enabling discovery of interface configuration schemas
 *   (e.g. for dynamically-generated setup UIs).
 */

import { Interface } from "./base.js";
import { TCPClientInterface, TCPServerInterface } from "./tcp.js";
import {
  WebSocketClientInterface,
  WebSocketServerInterface,
} from "./websocket.js";

/**
 * A RNS interface class: constructable into an {@link Interface} and exposing a
 * static configuration schema accessor.
 *
 * @typedef {(new (...args: any[]) => Interface) & {
 *   getConfigurationSchema: () => Record<string, any>;
 * }} InterfaceConstructor
 */

/**
 * @typedef {Object} InterfaceRegistryEntry
 * @property {string} id - Stable identifier, e.g. "tcp-client".
 * @property {string} name - Human-readable interface name (from the schema title).
 * @property {Record<string, any>} schema - JSON Schema describing the constructor options.
 * @property {InterfaceConstructor} interfaceClass - The interface class.
 */

/** @type {Map<string, InterfaceConstructor>} */
const registry = new Map();
registry.set("tcp-client", TCPClientInterface);
registry.set("tcp-server", TCPServerInterface);
registry.set("ws-client", WebSocketClientInterface);
registry.set("ws-server", WebSocketServerInterface);

/**
 * Lists all registered interfaces with their configuration schemas.
 * @returns {InterfaceRegistryEntry[]}
 */
export function listInterfaces() {
  return Array.from(registry.entries()).map(([id, interfaceClass]) => {
    const schema = interfaceClass.getConfigurationSchema();
    const className = /** @type {any} */ (interfaceClass).name;
    return {
      id,
      name: schema.title ? String(schema.title) : className,
      schema,
      interfaceClass,
    };
  });
}

/**
 * Returns the interface class registered under the given id.
 * @param {string} id
 * @returns {InterfaceConstructor | undefined}
 */
export function getInterface(id) {
  return registry.get(id);
}

/**
 * Returns the configuration schema for the interface registered under the
 * given id.
 * @param {string} id
 * @returns {Record<string, any> | undefined}
 */
export function getSchema(id) {
  const interfaceClass = registry.get(id);
  return interfaceClass ? interfaceClass.getConfigurationSchema() : undefined;
}

/**
 * Registers an interface class under a stable id. Existing registrations with
 * the same id are overwritten. Lets custom interfaces participate in schema
 * discovery alongside the built-ins.
 * @param {string} id
 * @param {InterfaceConstructor} interfaceClass
 */
export function registerInterface(id, interfaceClass) {
  registry.set(id, interfaceClass);
}
