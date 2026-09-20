/**
 * @module bundle
 * @description Git bundle (v2/v3) parsing.
 *
 * rngit transfers repository objects as `git bundle` files: rngit nodes
 * answer `/git/fetch` with a bundle Resource, and the bundle's
 * embedded packfile is what a git client (here: isomorphic-git) consumes.
 *
 * Layout (`git bundle create` output):
 *
 * ```
 * # v2 git bundle\n            (or "# v3 git bundle\n")
 * @object-format=sha256\n      (v3 capabilities, optional)
 * <sha> <refname>\n            (refs carried by the bundle)
 * -<sha> <message>\n           (prerequisites, optional — thin bundles)
 * \n                           (header terminator)
 * <packfile bytes>             ("PACK…" through the SHA-1 trailer)
 * ```
 */

/** Prerequisite / pack markers. */
const BUNDLE_V2_SIGNATURE = "# v2 git bundle";
const BUNDLE_V3_SIGNATURE = "# v3 git bundle";
const PACK_MAGIC = [0x50, 0x41, 0x43, 0x4b]; // "PACK"

/**
 * A parsed git bundle header.
 * @typedef {object} ParsedBundle
 * @property {Map<string, string>} refs - Included refs (`refname → sha`).
 * @property {string[]} prerequisites - Prerequisite object ids (thin bundles).
 * @property {Uint8Array} pack - The embedded packfile bytes.
 */

/**
 * Parses a git bundle into refs, prerequisites and the embedded packfile.
 * Throws on invalid signature or a missing pack.
 *
 * @param {Uint8Array} data - Full bundle bytes.
 * @returns {ParsedBundle}
 */
export function parseBundle(data) {
  const decoder = new TextDecoder();
  let offset = 0;

  /**
   * Reads one `\n`-terminated header line.
   * @returns {string|null} `null` at end of input.
   */
  const readLine = () => {
    const nl = data.indexOf(0x0a, offset);
    if (nl < 0) return null;
    const line = decoder.decode(data.subarray(offset, nl));
    offset = nl + 1;
    return line;
  };

  const signature = readLine();
  if (signature !== BUNDLE_V2_SIGNATURE && signature !== BUNDLE_V3_SIGNATURE) {
    throw new Error("Not a git bundle (missing v2/v3 signature)");
  }

  /** @type {Map<string, string>} */
  const refs = new Map();
  /** @type {string[]} */
  const prerequisites = [];
  while (offset < data.length) {
    const line = readLine();
    if (line === null) throw new Error("Truncated git bundle header");
    if (line === "") break; // header terminator; packfile follows
    if (line.startsWith("@")) continue; // v3 capability line
    if (line.startsWith("-")) {
      const sep = line.indexOf(" ");
      if (sep < 0) throw new Error(`Malformed prerequisite: ${line}`);
      prerequisites.push(line.slice(1, sep));
      continue;
    }
    const sep = line.indexOf(" ");
    if (sep <= 0) throw new Error(`Malformed bundle ref: ${line}`);
    const sha = line.slice(0, sep);
    const ref = line.slice(sep + 1);
    refs.set(ref, sha);
  }

  const pack = data.subarray(offset);
  if (
    pack.length < 32 ||
    pack[0] !== PACK_MAGIC[0] ||
    pack[1] !== PACK_MAGIC[1] ||
    pack[2] !== PACK_MAGIC[2] ||
    pack[3] !== PACK_MAGIC[3]
  ) {
    throw new Error("Git bundle has no embedded packfile");
  }

  return { refs, prerequisites, pack };
}

/**
 * Builds a valid packfile containing zero objects — the answer to an
 * upload-pack request when every wanted object is already available to the
 * client (rngit's "empty bundle" reply).
 *
 * @returns {Promise<Uint8Array>}
 */
export async function emptyPack() {
  const header = new Uint8Array(12);
  header.set(PACK_MAGIC, 0);
  header.set([0, 0, 0, 2], 4); // version 2
  header.set([0, 0, 0, 0], 8); // zero objects
  const digest = await crypto.subtle.digest("SHA-1", header);
  const out = new Uint8Array(32);
  out.set(header, 0);
  out.set(new Uint8Array(digest), 12);
  return out;
}

/**
 * Builds a git bundle v2 from full refs and a packfile. Used for pushing:
 * the pushed pack (self-contained) is wrapped with a header naming the
 * pushed ref, and the node fetches `local_ref:remote_ref` from it.
 *
 * @param {{ sha: string, ref: string }[]} refs - Refs carried by the bundle.
 * @param {Uint8Array} pack - Complete packfile bytes (header, objects,
 *   SHA-1 trailer).
 * @returns {Uint8Array}
 */
export function buildBundle(refs, pack) {
  const encoder = new TextEncoder();
  /** @type {Uint8Array[]} */
  const parts = [encoder.encode(`${BUNDLE_V2_SIGNATURE}\n`)];
  for (const { sha, ref } of refs) {
    parts.push(encoder.encode(`${sha} ${ref}\n`));
  }
  parts.push(encoder.encode("\n"));
  parts.push(pack);
  return concatBytes(...parts);
}

/** @param {...Uint8Array} chunks */
function concatBytes(...chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
