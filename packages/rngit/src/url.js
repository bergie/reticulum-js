/**
 * @module url
 * @description `rns://<destination-hash>/<group>/<repo>` remote URL handling,
 * mirroring the URL format accepted by the reference `git-remote-rns`
 * helper.
 */

/** Destination hash length in hex characters (`TRUNCATED_HASHLENGTH//8*2`). */
export const DESTINATION_HASH_HEX_LENGTH = 32;

/**
 * Thrown for malformed remote URLs.
 */
export class RemoteUrlError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "RemoteUrlError";
  }
}

/**
 * A parsed rngit remote URL.
 * @typedef {object} RemoteUrl
 * @property {string} hashHex - 16-byte destination hash in lowercase hex.
 * @property {string} group - Repository group (first path segment).
 * @property {string} repo - Repository name (second path segment).
 * @property {string} repoPath - `<group>/<repo>` as sent in requests.
 */

/**
 * Parses an `rns://<hash>/<group>/<repo>` remote URL (the scheme-less
 * `<hash>/<group>/<repo>` form used in some configs is also accepted).
 *
 * @param {string} input
 * @returns {RemoteUrl}
 */
export function parseRemoteUrl(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new RemoteUrlError("Empty remote URL");
  }
  let rest = input;
  if (input.startsWith("rns://")) rest = input.slice(6);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw new RemoteUrlError(`Unsupported remote URL scheme: ${input}`);
  }

  const parts = rest.split("/").filter((p) => p.length > 0);
  if (parts.length !== 3) {
    throw new RemoteUrlError(
      "Invalid rngit remote URL. Use rns://<hash>/<group>/<repo>",
    );
  }

  const [hashHex, group, repo] = parts;
  if (hashHex.length !== DESTINATION_HASH_HEX_LENGTH) {
    throw new RemoteUrlError(
      `Destination hash must be ${DESTINATION_HASH_HEX_LENGTH} hex characters`,
    );
  }
  if (!/^[0-9a-f]+$/i.test(hashHex)) {
    throw new RemoteUrlError("Destination hash must be hexadecimal");
  }

  return {
    hashHex: hashHex.toLowerCase(),
    group,
    repo,
    repoPath: `${group}/${repo}`,
  };
}

/**
 * Renders a remote URL back into canonical `rns://` form.
 *
 * @param {RemoteUrl} url
 * @returns {string}
 */
export function stringifyRemoteUrl(url) {
  return `rns://${url.hashHex}/${url.group}/${url.repo}`;
}

/**
 * Maps an `rns://` URL onto the placeholder `http://` URL that stock
 * isomorphic-git accepts (`GitRemoteManager` rejects unknown schemes). The
 * transport parses the path segments back out; the original URL stays
 * recorded verbatim in `.git/config`.
 *
 * @param {string} url
 * @returns {string}
 */
export function toPlaceholderHttpUrl(url) {
  const parsed = parseRemoteUrl(url);
  return `http://rngit/${parsed.hashHex}/${parsed.group}/${parsed.repo}`;
}

/**
 * Inverse of {@link toPlaceholderHttpUrl}: extracts the rngit remote parts
 * from a placeholder URL seen by the transport. Request URLs carry an
 * appended endpoint (`/info/refs`, `/git-upload-pack`, …) after the remote
 * segments; anything before it is the remote. Returns `null` for URLs the
 * transport did not generate.
 *
 * @param {string} url
 * @returns {RemoteUrl|null}
 */
export function fromPlaceholderHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host !== "rngit") return null;
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  try {
    return parseRemoteUrl(parts.slice(0, 3).join("/"));
  } catch {
    return null;
  }
}
