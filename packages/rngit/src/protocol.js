/**
 * @module protocol
 * @description rngit wire protocol constants and framing, mirroring the
 * reference rngit client and node implementations.
 *
 * Requests and responses are msgpack values sent over an identified Reticulum
 * Link. Map keys shared by every operation are small integers; rngit nodes
 * require this exact shape (`{IDX_REPOSITORY: "group/repo", …}`).
 */

/**
 * rngit destination aspect: `APP_NAME = "git"`, aspect `"repositories"`.
 */
export const ASPECT = "git.repositories";

/** Git transfer request paths. */
export const PATH_LIST = "/git/list";
export const PATH_FETCH = "/git/fetch";
export const PATH_PUSH = "/git/push";
export const PATH_DELETE = "/git/delete";

/** Integer map keys used in request/response msgpack maps. */
export const IDX_REPOSITORY = 0x00;
export const IDX_RESULT_CODE = 0x01;

/** Result codes carried either in a status byte or response metadata. */
export const RES_OK = 0x00;
export const RES_DISALLOWED = 0x01;
export const RES_INVALID_REQ = 0x02;
export const RES_NOT_FOUND = 0x03;
export const RES_REMOTE_FAIL = 0xff;

/**
 * Error thrown when the rngit node returns a non-zero status.
 * Carries the status code and the server's message.
 */
export class RngitStatusError extends Error {
  /**
   * @param {number} status - Result code (`RES_*`).
   * @param {string} message - Decoded server message, if any.
   */
  constructor(status, message) {
    super(message || `rngit node returned status 0x${status.toString(16)}`);
    this.name = "RngitStatusError";
    this.status = status;
  }
}

/**
 * Builds a msgpack request map for an rngit operation, keeping the integer
 * `IDX_REPOSITORY` key integral (plain JS objects stringify numeric keys).
 *
 * @param {string} repoPath - `<group>/<repo>`.
 * @param {Record<string, any>} [fields] - Additional string-keyed fields.
 * @returns {Map<number|string, any>}
 */
export function buildRequest(repoPath, fields = {}) {
  const map = new Map();
  map.set(IDX_REPOSITORY, repoPath);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

/**
 * Parses a status-byte response (`status ‖ message`), as returned by
 * `/git/list`, `/git/push`, error replies and the "empty bundle" fetch
 * reply.
 *
 * @param {Uint8Array} response
 * @returns {{ status: number, message: string }}
 */
export function parseStatusResponse(response) {
  if (!(response instanceof Uint8Array) || response.length < 1) {
    throw new Error("Invalid response from rngit node");
  }
  const status = response[0];
  const message = new TextDecoder().decode(response.subarray(1));
  return { status, message };
}

/**
 * Parses a `/git/list` payload into refs plus the advertised HEAD target.
 *
 * The server answers `b"\x00" + lines` where each line is `<sha> <refname>`
 * and the trailing line is `@<head_ref> HEAD` (head_ref such as
 * `refs/heads/main`). The `HEAD` marker line is dropped, matching the
 * reference client.
 *
 * @param {Uint8Array} response
 * @returns {{ head: string|null, refs: Map<string, string> }}
 *   `refs` maps full ref names (e.g. `refs/heads/main`) to SHAs.
 */
export function parseListResponse(response) {
  const { status, message } = parseStatusResponse(response);
  if (status !== RES_OK) throw new RngitStatusError(status, message);

  /** @type {Map<string, string>} */
  const refs = new Map();
  let head = null;
  const text = new TextDecoder().decode(response.subarray(1));
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("@") && trimmed.endsWith(" HEAD")) {
      head = trimmed.slice(1, -5);
      continue;
    }
    const sep = trimmed.indexOf(" ");
    if (sep < 0) continue;
    const sha = trimmed.slice(0, sep);
    const refName = trimmed.slice(sep + 1);
    if (refName === "HEAD") continue;
    refs.set(refName, sha);
  }
  return { head, refs };
}

/**
 * Reads `IDX_RESULT_CODE` from a fetch Resource's response metadata.
 * rngit nodes send `{IDX_RESULT_CODE: RES_OK}` alongside bundle bytes.
 *
 * @param {any} metadata - Decoded metadata (object with stringified keys or a Map).
 * @returns {number|undefined}
 */
export function resultCodeFromMetadata(metadata) {
  if (metadata == null) return undefined;
  if (metadata instanceof Map) {
    const value = metadata.get(IDX_RESULT_CODE);
    return typeof value === "number" ? value : undefined;
  }
  const value = metadata[IDX_RESULT_CODE];
  return typeof value === "number" ? value : undefined;
}
