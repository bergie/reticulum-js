/**
 * Log levels
 * @enum {number}
 */
export const LogLevel = {
  NONE: 0,
  ERROR: 1,
  WARN: 2,
  LOG: 3,
  DEBUG: 4,
  EXTREME: 5,
};

// TODO: Read from env
const LOG_LEVEL = LogLevel.DEBUG;

/**
 * @param {string} module
 * @param {string} message
 * @param {LogLevel} [logLevel]
 */
export function log(module, message, logLevel = LogLevel.DEBUG) {
  if (logLevel > LOG_LEVEL) {
    return;
  }
  console.log(
    new Date().toISOString(),
    `[${module}]`,
    message,
  );
}
