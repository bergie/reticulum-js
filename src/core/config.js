/**
 * @file config.js
 * @description Discovery and parsing of the Python Reticulum configuration
 *   file (`~/.reticulum/config`), for shared-instance port/transport discovery
 *   and (later) interface synthesis.
 *
 * The Python reference uses vendored `configobj` (an INI superset with nested
 * `[[section]]` headers). This module implements just enough of that format to
 * extract the fields we need today, with value coercion matching configobj's
 * `as_bool` / `as_int` / `as_float` semantics. See `RNS/vendor/configobj.py`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves the Reticulum configuration directory, mirroring
 * `RNS.Reticulum.__init__` configdir resolution: explicit argument, then
 * `/etc/reticulum` (if present), then `~/.config/reticulum` (if present), then
 * `~/.reticulum` as the final fallback.
 *
 * Unlike the Python reference we do not create the directory if it is missing;
 * discovery callers treat a missing config file as "no shared instance
 * configured".
 * @param {string} [explicit] Optional explicit config directory path.
 * @returns {string}
 */
export function resolveConfigDir(explicit) {
  if (explicit) return explicit;
  const home = homedir();
  if (existsSync("/etc/reticulum") && existsSync("/etc/reticulum/config")) {
    return "/etc/reticulum";
  }
  const xdg = join(home, ".config", "reticulum");
  if (existsSync(xdg) && existsSync(join(xdg, "config"))) {
    return xdg;
  }
  return join(home, ".reticulum");
}

/**
 * Coerces a configobj string value to a boolean, matching
 * `configobj.Section.as_bool`: `True/On/Yes/1` (case-insensitive) → `true`,
 * `False/Off/No/0` → `false`. Anything else throws (configobj raises
 * `ValueError`); we throw to surface malformed configs loudly.
 * @param {string} value
 * @returns {boolean}
 */
function asBool(value) {
  const v = String(value).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(v)) return true;
  if (["false", "off", "no", "0"].includes(v)) return false;
  throw new Error(`Value "${value}" is neither True nor False`);
}

/**
 * Coerces a configobj string value to an integer, matching
 * `configobj.Section.as_int` (Python `int(value, 10)`).
 * @param {string} value
 * @returns {number}
 */
function asInt(value) {
  return Number.parseInt(String(value).trim(), 10);
}

/**
 * Parses a Reticulum config file (configobj/INI format) into a nested object.
 *
 * Section headers set the nesting depth by bracket count (`[a]` depth 1,
 * `[[b]]` depth 2 nested under the current depth-1 section). `key = value`
 * pairs populate the current section. Values are kept as strings; use the
 * `as*` coercion helpers when consuming. Lines whose first non-whitespace
 * character is `#` or `;` are comments.
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseConfigFile(text) {
  /** @type {Record<string, any>} */
  const root = {};
  /** @type {{ obj: Record<string, any> }[]} */
  const stack = [];
  let current = root;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^(\[+)(.*?)\]+$/);
    if (sectionMatch) {
      const depth = sectionMatch[1].length;
      const name = sectionMatch[2].trim();
      // Pop back to the parent of this depth (depth N nests under depth N-1).
      while (stack.length >= depth) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].obj : root;
      if (typeof parent[name] !== "object" || parent[name] === null) {
        parent[name] = {};
      }
      stack.push({ obj: parent[name] });
      current = parent[name];
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    current[key] = value;
  }

  return root;
}

/**
 * Reads and parses the Reticulum config from the given (or resolved) directory.
 * Returns `null` if no config file is present.
 * @param {{ configDir?: string }} [options]
 * @returns {{ configDir: string, config: Record<string, any> } | null}
 */
export function loadConfig(options = {}) {
  const configDir = resolveConfigDir(options.configDir);
  const configPath = join(configDir, "config");
  if (!existsSync(configPath)) return null;
  const config = parseConfigFile(readFileSync(configPath, "utf8"));
  return { configDir, config };
}

/**
 * The default shared-instance TCP port, matching the Python reference
 * `RNS.Reticulum.local_interface_port` default of `37428`.
 */
export const DEFAULT_SHARED_INSTANCE_PORT = 37428;

/**
 * The default AF_UNIX abstract-socket prefix used by the Python reference
 * (`\0rns/<instance_name>`). Linux-only; the leading NUL selects the abstract
 * namespace.
 */
export const AF_UNIX_PREFIX = "\0rns/";

/**
 * @typedef {Object} SharedInstanceEndpoint
 * @property {string} configDir - The config directory this was resolved from.
 * @property {boolean} shareInstance - Whether `share_instance` is enabled.
 * @property {"tcp"|"unix"} transport - Resolved loopback transport.
 * @property {string} [host] - TCP bind host (`"127.0.0.1"`) when `tcp`.
 * @property {number} [port] - TCP port when `tcp`.
 * @property {string} [socketPath] - AF_UNIX path when `unix`.
 * @property {string} instanceName - Configured instance name (`"default"`).
 */

/**
 * Whether this platform supports the abstract AF_UNIX namespace Python uses for
 * shared-instance sockets. Abstract namespace is a Linux kernel feature.
 * @returns {boolean}
 */
export function supportsAbstractAfUnix() {
  return process.platform === "linux" || process.platform === "android";
}

/**
 * Resolves how to reach the local shared instance, mirroring the Python
 * reference `__start_local_interface` / `__apply_config` transport resolution.
 *
 * Defaults (`share_instance = Yes`, port `37428`) match the Python reference
 * constructor defaults; config values override them. On platforms without the
 * abstract AF_UNIX namespace (macOS, Windows) the transport is always `tcp`
 * regardless of `shared_instance_type`, exactly as Python forces it.
 * @param {{ configDir?: string }} [options]
 * @returns {SharedInstanceEndpoint}
 */
export function getSharedInstanceEndpoint(options = {}) {
  const loaded = loadConfig(options);
  const configDir = loaded
    ? loaded.configDir
    : resolveConfigDir(options.configDir);
  const r = loaded?.config?.reticulum || {};

  const shareInstance =
    r.share_instance !== undefined ? asBool(r.share_instance) : true;
  const port =
    r.shared_instance_port !== undefined
      ? asInt(r.shared_instance_port)
      : DEFAULT_SHARED_INSTANCE_PORT;
  const instanceName =
    r.instance_name !== undefined ? String(r.instance_name).trim() : "default";
  const configuredType =
    r.shared_instance_type !== undefined
      ? String(r.shared_instance_type).trim().toLowerCase()
      : undefined;

  // Transport resolution mirrors Python: abstract AF_UNIX is only available on
  // Linux/Android; an explicit `shared_instance_type = tcp` forces TCP even
  // there; everywhere else (incl. macOS/Windows) it's TCP.
  /** @type {("tcp" | "unix")} */
  let transport = "tcp";
  if (supportsAbstractAfUnix() && configuredType !== "tcp") {
    transport = "unix";
  }

  /** @type {SharedInstanceEndpoint} */
  const endpoint = {
    configDir,
    shareInstance,
    transport,
    instanceName,
  };
  if (transport === "tcp") {
    endpoint.host = "127.0.0.1";
    endpoint.port = port;
  } else {
    endpoint.socketPath = `${AF_UNIX_PREFIX}${instanceName}`;
  }
  return endpoint;
}

export { asBool, asInt };
