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

import { buildBundle, emptyPack, parseBundle } from "./bundle.js";
import { fattenPack } from "./pack.js";
import {
  asyncIteratorFromBytes,
  chunkBytes,
  concat,
  encodePktLine,
  FLUSH,
} from "./pktline.js";
import { MAX_EFFICIENT_SIZE } from "./segment.js";
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
 * Builds a progress forwarder from the Link's Resource transfer info into
 * isomorphic-git's `onProgress` events (`{ phase, loaded, total }`).
 *
 * Only the `direction` given (the one that actually moves bulk bytes in the
 * operation — downloads for fetch, uploads for push) is reported; the
 * opposite direction (e.g. a have-list request upload during fetch) is
 * dropped so user-facing progress stays monotonic.
 *
 * Split resources report per-segment positions; since segments transfer
 * strictly one at a time, the forwarder accumulates completed segments and
 * estimates the remaining ones as full MAX_EFFICIENT_SIZE segments. The
 * estimate converges to the exact size while the last segment transfers.
 *
 * Events are throttled to whole-percent steps (plus completion) so a
 * multi-thousand-part transfer does not spam the callback.
 *
 * @param {((event: any) => void) | undefined} userOnProgress - The
 *   isomorphic-git onProgress callback from the http plugin request.
 * @param {string} phase - Progress phase label (e.g. "Receiving objects").
 * @param {"request"|"response"} direction - Which transfer direction to
 *   report.
 * @returns {((info: any) => void) | undefined}
 */
function progressForwarder(userOnProgress, phase, direction) {
  if (!userOnProgress) return undefined;
  let completedBytes = 0;
  let lastSegment = 0;
  let lastSegmentTotal = 0;
  let lastPercent = -1;
  return (info) => {
    if (info.direction !== direction) return;
    if (info.segmentIndex > lastSegment) {
      completedBytes += lastSegmentTotal;
      lastSegment = info.segmentIndex;
    }
    lastSegmentTotal = info.total;
    const loaded = completedBytes + info.loaded;
    const remaining = info.segmentTotal - info.segmentIndex;
    const total = completedBytes + info.total + remaining * MAX_EFFICIENT_SIZE;
    const percent = total > 0 ? Math.floor((loaded / total) * 100) : 100;
    if (percent !== lastPercent || loaded >= total) {
      lastPercent = percent;
      userOnProgress({ phase, loaded, total });
    }
  };
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
 * Parses a `git-receive-pack` request body into its update commands and
 * trailing packfile.
 *
 * Layout: pkt-line commands `<old> <new> <ref>[\\0 caps]` then a flush,
 * followed by raw packfile bytes (absent for deletions). A new oid of
 * all zeros means deletion.
 *
 * @param {Uint8Array} body
 * @returns {{ commands: { old: string, new: string, ref: string }[], capabilities: string[], pack: Uint8Array|null }}
 */
export function parseReceivePackRequest(body) {
  /** @type {{ old: string, new: string, ref: string }[]} */
  const commands = [];
  /** @type {string[]} */
  const capabilities = [];
  let offset = 0;
  let sawFlush = false;
  const decoder = new TextDecoder();
  while (offset + 4 <= body.length) {
    const header = decoder.decode(body.subarray(offset, offset + 4));
    const length = Number.parseInt(header, 16);
    if (Number.isNaN(length)) {
      throw new Error(`Invalid pkt-line header: ${header}`);
    }
    if (length === 0) {
      sawFlush = true;
      offset += 4;
      break;
    }
    const raw = decoder.decode(body.subarray(offset + 4, offset + length));
    const nul = raw.indexOf("\0");
    const line = (nul === -1 ? raw : raw.slice(0, nul)).trim();
    if (nul !== -1) {
      capabilities.push(
        ...raw
          .slice(nul + 1)
          .trim()
          .split(/\s+/)
          .filter(Boolean),
      );
    }
    const parts = line.split(" ");
    if (parts.length !== 3) {
      throw new Error(`Malformed receive-pack command: ${line}`);
    }
    commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
    offset += length;
  }
  if (!sawFlush) {
    throw new Error("receive-pack request missing flush after commands");
  }
  const pack = body.subarray(offset);
  return {
    commands,
    capabilities,
    pack: pack.length > 0 ? pack : null,
  };
}

/**
 * Synthesizes a `report-status` response for a receive-pack request.
 *
 * When the client negotiated `side-band-64k`, the status lines ride
 * band 1 — clients demux the report from the packfile channel.
 *
 * @param {{ ref: string, ok: boolean, error?: string }[]} reports
 * @param {object} [options]
 * @param {boolean} [options.sideband=false]
 * @returns {Uint8Array}
 */
export function buildReportStatusResponse(reports, options = {}) {
  /**
   * Frames one report line. Without side-band the report is a plain
   * pkt-line stream; with side-band, band 1 carries that same pkt-line
   * stream as chunks — the client demuxes band 1 and re-parses the
   * pkt-lines from it.
   * @param {string} line
   */
  const frame = (line) => {
    const inner = encodePktLine(line);
    if (!options.sideband) return inner;
    const payload = new Uint8Array(1 + inner.length);
    payload[0] = 0x01; // side-band 1
    payload.set(inner, 1);
    return encodePktLine(payload);
  };
  const parts = [frame("unpack ok\n")];
  for (const report of reports) {
    parts.push(
      report.ok
        ? frame(`ok ${report.ref}\n`)
        : frame(`ng ${report.ref} ${report.error ?? "rejected"}\n`),
    );
  }
  parts.push(FLUSH);
  return concat(...parts);
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
 * @param {object} [options]
 * @param {any} [options.fs] - isomorphic-git filesystem client for the local
 *   repository; needed to resolve thin-bundle delta bases from the local
 *   object store before the packfile is handed to isomorphic-git.
 * @param {string} [options.gitdir] - Local git directory.
 * @param {boolean} [options.force=false] - Allow non-fast-forward ref
 *   updates on pushes that take the direct `update_ref` path.
 * @returns {{ request: (req: any) => Promise<any> }} An object implementing
 *   isomorphic-git's `HttpClient` interface.
 */
export function createRngitTransport(client, options = {}) {
  const { fs, gitdir, force } = options;
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
        const bundle = await client.fetch({
          refs,
          have: haves,
          onProgress: progressForwarder(
            req.onProgress,
            "Receiving objects",
            "response",
          ),
        });
        // Thin bundles (the node excluded the client's have-objects) must be
        // fattened against the local store before being stored.
        const pack = bundle
          ? await fattenPack({ pack: parseBundle(bundle).pack, fs, gitdir })
          : await emptyPack();
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
      if (method !== "POST") {
        return badRequest(url, method, `${method} not allowed`);
      }
      const { commands, pack, capabilities } = parseReceivePackRequest(
        await collectBody(body),
      );
      const sideband = capabilities.some(
        (/** @type {string} */ cap) => cap.split("=", 1)[0] === "side-band-64k",
      );
      if (commands.length !== 1) {
        return badRequest(
          url,
          method,
          `expected exactly one ref update per push, got ${commands.length}`,
        );
      }
      const command = commands[0];
      /** @type {{ ref: string, ok: boolean, error?: string }} */
      let report;
      try {
        if (command.new === "0".repeat(40)) {
          // Deletion.
          if (pack) throw new Error("unexpected pack bytes for a deletion");
          await client.deleteRef(command.ref);
        } else if (pack && packObjectCount(pack) > 0) {
          // New objects: wrap the pushed pack in a bundle for the node.
          const bundle = buildBundle(
            [{ sha: command.new, ref: command.ref }],
            pack,
          );
          await client.push({
            ref: command.ref,
            bundle,
            force,
            onProgress: progressForwarder(
              req.onProgress,
              "Writing objects",
              "request",
            ),
          });
        } else {
          // Everything reachable already exists on the node — a direct
          // ref update needs no bundle transfer.
          await client.push({
            ref: command.ref,
            sha: command.new,
            force,
          });
        }
        report = { ref: command.ref, ok: true };
      } catch (err) {
        report = {
          ref: command.ref,
          ok: false,
          error: String(/** @type {Error} */ (err).message ?? err).replace(
            /\s+/g,
            " ",
          ),
        };
      }
      return {
        url,
        method,
        statusCode: 200,
        statusMessage: "OK",
        headers: {
          "content-type": "application/x-git-receive-pack-result",
        },
        body: asyncIteratorFromBytes(
          buildReportStatusResponse([report], { sideband }),
        ),
      };
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

/**
 * Reads the object count from a packfile header (bytes 8-11).
 *
 * @param {Uint8Array} pack
 * @returns {number}
 */
function packObjectCount(pack) {
  if (pack.length < 12) return 0;
  return (pack[8] << 24) | (pack[9] << 16) | (pack[10] << 8) | pack[11];
}
