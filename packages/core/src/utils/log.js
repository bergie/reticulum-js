/**
 * Log levels, aligned with the Python RNS reference
 * (`RNS.LOG_*` in `RNS/__init__.py`).
 *
 * Names, ordering and numeric values match Python so that
 * `RETICULUM_LOG_LEVEL` / `setLogLevel` accept familiar names
 * (`ERROR`, `NOTICE`, `DEBUG`, …) and behave as Reticulum users expect.
 *
 * @enum {number}
 */

/* @ts-self-types="../../types/src/utils/log.d.ts" */

export const LogLevel = {
  NONE: -1,
  CRITICAL: 0,
  ERROR: 1,
  WARNING: 2,
  NOTICE: 3,
  INFO: 4,
  VERBOSE: 5,
  DEBUG: 6,
  PATHING: 7,
  EXTREME: 8,
};

/** Environment variable consulted at module load for the initial threshold. */
export const LOG_LEVEL_ENV = "RETICULUM_LOG_LEVEL";

/** Default threshold when nothing else is configured (Python: `LOG_NOTICE`). */
const DEFAULT_LOG_LEVEL = LogLevel.NOTICE;

const LEVEL_BY_NAME = new Map(
  Object.entries(LogLevel).map(([name, value]) => [name.toLowerCase(), value]),
);

/**
 * Reads an environment variable in a platform-neutral, dependency-free way.
 *
 * Works on Node (`process.env`) and Deno (`Deno.env`); returns `undefined`
 * in browsers and other runtimes without an environment. Access is wrapped
 * so runtimes that throw on env access are treated as "unset".
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnv(name) {
  try {
    // Node / WinterTC expose `process.env`; Deno exposes `Deno.env`. Browsers
    // and other runtimes have neither, so we read defensively and stay
    // dependency-free. `globalThis` is cast because its lib type has no
    // index signature for these (optional) host globals.
    /** @type {any} */
    const g = globalThis;
    const fromProcess = g?.process?.env?.[name];
    if (fromProcess !== undefined) return fromProcess;
    const fromDeno = g?.Deno?.env?.get?.(name);
    if (fromDeno !== undefined) return fromDeno;
  } catch {
    // Some runtimes throw on env access; treat as unset.
  }
  return undefined;
}

/**
 * Parses a log level from a name (case-insensitive, e.g. `"DEBUG"`) or a
 * number (Python's numeric scheme). Out-of-range numbers are clamped to
 * `[CRITICAL, EXTREME]`, matching Python's constructor behaviour. Unknown
 * names fall back to `fallback`.
 * @param {string | number | undefined} value - name, number, or empty.
 * @param {number} [fallback] - {@link LogLevel} used when `value` is
 *   missing or unrecognised. Defaults to {@link LogLevel.NOTICE}.
 * @returns {number} a {@link LogLevel} value.
 */
export function parseLogLevel(value, fallback = DEFAULT_LOG_LEVEL) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "number") {
    return clamp(Number.isFinite(value) ? Math.trunc(value) : fallback);
  }
  const trimmed = String(value).trim();
  if (/^-?\d+$/.test(trimmed)) {
    return clamp(Number.parseInt(trimmed, 10));
  }
  const byName = LEVEL_BY_NAME.get(trimmed.toLowerCase());
  return byName ?? fallback;
}

/** @param {number} n */
const clamp = (n) => Math.min(LogLevel.EXTREME, Math.max(LogLevel.CRITICAL, n));

// Module-level threshold. Initialised from the env var at load time, then
// overridable at runtime via `setLogLevel()` / `Reticulum({ logLevel })`.
let logLevel = parseLogLevel(readEnv(LOG_LEVEL_ENV), DEFAULT_LOG_LEVEL);

/**
 * Sets the active log level (the threshold above which messages are dropped).
 *
 * Accepts a {@link LogLevel} value, a level name, or a numeric level; see
 * {@link parseLogLevel}. Takes precedence over the `RETICULUM_LOG_LEVEL`
 * environment variable.
 * @param {number | string} level
 * @returns {void}
 */
export function setLogLevel(level) {
  logLevel = parseLogLevel(level, logLevel);
}

/**
 * @returns {number} the currently active {@link LogLevel} threshold.
 */
export function getLogLevel() {
  return logLevel;
}

/**
 * Emits a log message if `level` is at or below the active threshold.
 *
 * The default message level is {@link LogLevel.DEBUG}, so bare
 * `log("Mod", msg)` calls stay quiet unless the operator raises the
 * threshold to `DEBUG` (or higher). Call sites that should appear at the
 * default `NOTICE` verbosity pass an explicit level.
 *
 * @param {string} module - short tag identifying the emitting subsystem.
 * @param {string} message - the message body.
 * @param {number} [level=LogLevel.DEBUG] - {@link LogLevel} of this message.
 * @returns {void}
 */
export function log(module, message, level = LogLevel.DEBUG) {
  if (level > logLevel) {
    return;
  }
  console.log(new Date().toISOString(), `[${module}]`, message);
}
