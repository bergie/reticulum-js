/**
 * @module transport
 * @description The isomorphic-git `http` plugin that bridges the git
 * smart-HTTP protocol onto rngit requests.
 *
 * isomorphic-git drives every remote operation through a single extension
 * point — the `http` plugin — speaking the git smart protocol (v1) over it.
 * This module implements that interface by translating the two smart-HTTP
 * endpoints onto rngit requests:
 *
 * | smart-HTTP request                    | rngit request                  |
 * |---------------------------------------|--------------------------------|
 * | `GET  /info/refs?service=git-upload-pack`   | `/git/list`             |
 * | `POST /git-upload-pack`               | `/git/fetch` (bundle → pack)   |
 * | `GET  /info/refs?service=git-receive-pack`  | `/git/list` (for push)  |
 * | `POST /git-receive-pack`              | `/git/push` (phase 2 — not yet)|
 *
 * Because isomorphic-git negotiates capabilities from the *advertised* set,
 * the synthesized ref advertisement stays deliberately minimal: `side-band-64k`
 * (pack data is muxed in band 1), `ofs-delta`, `symref=HEAD:…` and an agent
 * string. No `multi_ack` variants — the fetch is a single `want`/`have` round
 * terminated by `done`, answered with `NAK` plus the bundle's packfile, with
 * `have` lines forwarded to the node so bundles stay thin.
 */

import { emptyPack, parseBundle } from "./bundle.js";
import {
  asyncIteratorFromBytes,
  chunkBytes,
  concat,
  encodePktLine,
  FLUSH,
} from "./pktline.js";
import { fromPlaceholderHttpUrl, RemoteUrlError } from "./url.js";

/** Max side-band-64k payload per pkt-line (65519 data bytes + 1 band byte). */
const SIDEBAND_MAX = 65519;

const AGENT = "rngit-js/0.1.0";

/**
 * Thrown when isomorphic-git requests a feature the rngit bridge does not
 * (yet) support, such as shallow/depth fetches.
 */
export class UnsupportedFeatureError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "UnsupportedFeatureError";
  }
}

/**
 * Collects an async-iterable request body into a single byte array.
 *
 * @param {AsyncIterable<Uint8Array>|undefined} body
 * @returns {Promise<Uint8Array>}
 */
async function collectBody(body) {
  if (!body) return new Uint8Array(0);
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  return concat(...chunks);
}

/**
 * Extracts the rngit remote from a placeholder URL and classifies the
 * request's target endpoint by pathname suffix.
 *
 * @param {string} url
 * @returns {{ remote: { hashHex: string, group: string, repo: string, repoPath: string }, endpoint: "info/refs"|"upload-pack"|"receive-pack", service: string|null }}
 */
function classifyRequest(url) {
  const remote = fromPlaceholderHttpUrl(url);
  if (!remote) {
    throw new RemoteUrlError(
      `rngit transport received a non-rngit URL: ${url}`,
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteUrlError(`Unparseable URL: ${url}`);
  }
  // Drop the remote segments; the remainder is the endpoint path.
  const remotePrefix = `/${remote.hashHex}/${remote.group}/${remote.repo}`;
  const path = parsed.pathname.slice(remotePrefix.length);
  const service = parsed.searchParams.get("service");

  if (path === "/info/refs") {
    return { remote, endpoint: "info/refs", service };
  }
  if (path === "/git-upload-pack") {
    return { remote, endpoint: "upload-pack", service: null };
  }
  if (path === "/git-receive-pack") {
    return { remote, endpoint: "receive-pack", service: null };
  }
  throw new RemoteUrlError(`Unsupported rngit transport URL: ${url}`);
}

/**
 * Parses a `git-upload-pack` request body (pkt-lines) into wants and haves.
 *
 * Layout: `want <sha>[ caps]…` then a flush, then `have <sha>…` and `done`.
 * `shallow`/`deepen*` lines indicate a shallow request the bridge cannot
 * satisfy (rngit bundles are complete histories).
 *
 * @param {Uint8Array} body
 * @returns {{ wants: string[], haves: string[] }}
 */
export function parseUploadPackRequest(body) {
  const text = new TextDecoder();
  const lines = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = text.decode(body.subarray(offset, offset + 4));
    const length = Number.parseInt(header, 16);
    if (Number.isNaN(length)) {
      throw new Error(`Invalid pkt-line header: ${header}`);
    }
    if (length === 0) {
      lines.push(null);
      offset += 4;
      continue;
    }
    lines.push(text.decode(body.subarray(offset + 4, offset + length)));
    offset += length;
  }

  /** @type {string[]} */
  const wants = [];
  /** @type {string[]} */
  const haves = [];
  for (const line of lines) {
    if (line === null || line === undefined) continue;
    if (line.startsWith("want ")) {
      const sha = line.slice(5, 5 + 40).trim();
      if (sha.length !== 40) throw new Error(`Malformed want line: ${line}`);
      wants.push(sha);
    } else if (line.startsWith("have ")) {
      const sha = line.slice(5, 5 + 40).trim();
      if (sha.length !== 40) throw new Error(`Malformed have line: ${line}`);
      haves.push(sha);
    } else if (
      line.startsWith("shallow") ||
      line.startsWith("deepen") ||
      line.startsWith("filter")
    ) {
      throw new UnsupportedFeatureError(
        `rngit transport does not support '${line.trim()}' requests`,
      );
    }
    // `done` and anything else needs no handling.
  }
  return { wants, haves };
}

/**
 * Synthesizes a smart-HTTP `info/refs` advertisement from an rngit list
 * result.
 *
 * @param {{ head: string|null, refs: Map<string, string> }} listing
 * @param {string} service - `git-upload-pack` or `git-receive-pack`.
 * @returns {Uint8Array}
 */
export function buildInfoRefsResponse(listing, service) {
  const parts = [encodePktLine(`# service=${service}\n`), FLUSH];

  const caps = [
    "side-band-64k",
    "ofs-delta",
    `agent=${AGENT}`,
    ...(listing.head ? [`symref=HEAD:${listing.head}`] : []),
  ];
  const capsSuffix = `\0${caps.join(" ")}\n`;

  const headSha =
    listing.head != null ? listing.refs.get(listing.head) : undefined;

  if (listing.refs.size === 0) {
    // Zero refs (brand-new repository): the capabilities pseudo-ref.
    parts.push(
      encodePktLine(
        `0000000000000000000000000000000000000000 capabilities^{}${capsSuffix}`,
      ),
    );
  } else {
    if (headSha !== undefined) {
      parts.push(encodePktLine(`${headSha} HEAD${capsSuffix}`));
    }
    let first = headSha === undefined;
    for (const [ref, sha] of listing.refs) {
      parts.push(
        encodePktLine(first ? `${sha} ${ref}${capsSuffix}` : `${sha} ${ref}\n`),
      );
      first = false;
    }
  }
  parts.push(FLUSH);
  return concat(...parts);
}

/**
 * Wraps packfile bytes as an upload-pack response: a `NAK` pkt-line followed
 * by the pack multiplexed on side-band 1.
 *
 * @param {Uint8Array} pack
 * @returns {Uint8Array}
 */
export function buildUploadPackResponse(pack) {
  const parts = [encodePktLine("NAK\n")];
  for (const chunk of chunkBytes(pack, SIDEBAND_MAX)) {
    const band = new Uint8Array(chunk.length + 1);
    band[0] = 0x01; // side-band 1: packfile data
    band.set(chunk, 1);
    parts.push(encodePktLine(band));
  }
  return concat(...parts);
}

/**
 * Creates an isomorphic-git `http` transport for an rngit remote.
 *
 * @param {import("./client.js").RngitClient} client - Connected (or
 *   lazily-connecting) rngit client. One client can serve several
 *   transports; the transport performs `/git/list` on the first `info/refs`
 *   discovery and caches the result per operation.
 * @returns {{ request: (req: any) => Promise<any> }} An object implementing
 *   isomorphic-git's `HttpClient` interface.
 */
export function createRngitTransport(client) {
  /** @type {{ head: string|null, refs: Map<string, string> }|null} */
  let listCache = null;

  /**
   * @param {boolean} forPush
   * @returns {Promise<{ head: string|null, refs: Map<string, string> }>}
   */
  const list = async (forPush) => {
    if (!listCache) listCache = await client.list(forPush);
    return listCache;
  };

  /**
   * Maps wanted SHAs back to ref names using the cached listing. A SHA may
   * be advertised by several refs; refs/heads/* are preferred so bundle
   * headers match the shape the reference client sends.
   *
   * @param {string[]} wants
   * @returns {{ sha: string, ref: string }[]}
   */
  const wantsToRefs = (wants) => {
    const listing =
      /** @type {{ head: string|null, refs: Map<string, string> }} */ (
        listCache
      );
    /** @type {Map<string, string>} */
    const bySha = new Map();
    for (const [ref, sha] of listing.refs) {
      const existing = bySha.get(sha);
      if (
        existing === undefined ||
        (ref.startsWith("refs/heads/") && !existing.startsWith("refs/heads/"))
      ) {
        bySha.set(sha, ref);
      }
    }
    return wants.map((sha) => {
      const ref = bySha.get(sha);
      if (ref === undefined) {
        throw new Error(
          `Requested object ${sha} is not advertised by the rngit node`,
        );
      }
      return { sha, ref };
    });
  };

  return {
    /**
     * isomorphic-git `HttpClient.request` implementation.
     *
     * @param {any} req
     * @returns {Promise<any>}
     */
    async request(req) {
      const { method = "GET", url, body } = req;
      const { endpoint, service } = classifyRequest(url);

      if (endpoint === "info/refs") {
        if (method !== "GET") {
          return badRequest(url, method, `${method} not allowed for info/refs`);
        }
        if (service !== "git-upload-pack" && service !== "git-receive-pack") {
          return badRequest(
            url,
            method,
            `Unsupported service: ${service ?? "(none)"}`,
          );
        }
        const listing = await list(service === "git-receive-pack");
        return {
          url,
          method,
          statusCode: 200,
          statusMessage: "OK",
          headers: {
            "content-type": `application/x-${service}-advertisement`,
          },
          body: asyncIteratorFromBytes(buildInfoRefsResponse(listing, service)),
        };
      }

      if (endpoint === "upload-pack") {
        if (method !== "POST") {
          return badRequest(url, method, `${method} not allowed`);
        }
        const { wants, haves } = parseUploadPackRequest(
          await collectBody(body),
        );
        if (wants.length === 0) {
          return badRequest(url, method, "Empty upload-pack request");
        }
        const refs = wantsToRefs(wants);
        const bundle = await client.fetch({ refs, have: haves });
        const pack = bundle ? parseBundle(bundle).pack : await emptyPack();
        return {
          url,
          method,
          statusCode: 200,
          statusMessage: "OK",
          headers: {
            "content-type": "application/x-git-upload-pack-result",
          },
          body: asyncIteratorFromBytes(buildUploadPackResponse(pack)),
        };
      }

      // endpoint === "receive-pack"
      return badRequest(
        url,
        method,
        "Pushing to rngit remotes is not implemented yet (phase 2)",
      );
    },
  };
}

/**
 * Builds a plain HTTP error response.
 *
 * @param {string} url
 * @param {string} method
 * @param {string} message
 */
function badRequest(url, method, message) {
  return {
    url,
    method,
    statusCode: 500,
    statusMessage: message.slice(0, 60),
    headers: { "content-type": "text/plain" },
    body: asyncIteratorFromBytes(new TextEncoder().encode(message)),
  };
}
