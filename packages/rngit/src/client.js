/**
 * @module client
 * @description rngit repository-node client.
 *
 * Speaks the git-transfer subset of the rngit protocol (the same requests
 * the reference `git-remote-rns` helper makes) over an identified Reticulum
 * Link:
 *
 * - `/git/list` — enumerate remote refs and the advertised HEAD.
 * - `/git/fetch` — request a `git bundle` of missing objects, honouring the
 *   client's `have` list for incremental (thin) transfers. Bundle replies
 *   arrive as Resources with response metadata (`IDX_RESULT_CODE`).
 *
 * The client is transport-agnostic: pass a configured {@link RngitClient}
 * options `reticulum` instance with whatever interfaces your platform
 * provides, or a pre-established `link` (used by tests and by callers that
 * manage links themselves).
 */

import {
  Destination,
  DestType,
  fromHex,
  Identity,
  Reticulum,
} from "@reticulum/core";
import {
  ASPECT,
  buildRequest,
  PATH_DELETE,
  PATH_FETCH,
  PATH_LIST,
  PATH_PUSH,
  parseListResponse,
  parseStatusResponse,
  RES_OK,
  RngitStatusError,
  resultCodeFromMetadata,
} from "./protocol.js";
import { parseRemoteUrl, RemoteUrlError } from "./url.js";

/**
 * Loads (or lazily creates) the `@digitaldefiance/bzip2-wasm` adapter for
 * `@reticulum/core`'s `Bzip2` interface. rngit nodes auto-compress Resource
 * responses, so a bz2 module is required on the client.
 *
 * Kept as a separate exported function so callers can substitute their own
 * compression provider.
 *
 * @returns {Promise<import("@reticulum/core/src/core/resource.js").Bzip2>}
 */
export async function createBz2() {
  const { default: BZip2 } = await import("@digitaldefiance/bzip2-wasm");
  const bz = new BZip2();
  await bz.init();
  return {
    /**
     * The wasm module sizes its destination buffer from the input length
     * and fails with BZ_OUTBUFF_FULL whenever compression would expand
     * the data (small incompressible payloads — git bundles among them).
     * That is not an error for the Resource protocol: an expansion simply
     * means "send uncompressed", which is exactly what the caller falls
     * back to when `compress` output is not smaller than the input.
     */
    compress: (data) => {
      try {
        return bz.compress(data);
      } catch (err) {
        if (
          /OUTBUFF_FULL|buffer is full/i.test(
            String(/** @type {Error} */ (err).message ?? err),
          )
        ) {
          return data;
        }
        throw err;
      }
    },
    decompress: (data, outputLen) => bz.decompress(data, outputLen),
  };
}

/**
 * @typedef {object} RngitClientOptions
 * @property {string} [url] - `rns://<hash>/<group>/<repo>` remote URL.
 * @property {import("@reticulum/core").Reticulum} [reticulum] - An
 *   already-configured Reticulum instance (with interfaces attached). When
 *   omitted, a minimal instance backed by `storageAdapter` is created.
 * @property {import("@reticulum/core/src/storage/storage.js").StorageAdapter} [storageAdapter]
 *   - Identity storage for the auto-created instance.
 * @property {import("@reticulum/core").Identity} [identity] - Client identity
 *   used for link identification (required for the node to authorize
 *   requests). Defaults to `Identity.loadOrGenerate` on the instance storage.
 * @property {import("@reticulum/core/src/core/resource.js").Bzip2} [bz2]
 *   - Compression provider; defaults to the bundled wasm bzip2 adapter.
 * @property {import("@reticulum/core").Link} [link] - Pre-established,
 *   identified link to the rngit node. Skips mesh connect entirely.
 * @property {number} [pathTimeoutMs=30000] - Max time to learn the node's
 *   identity (announce recall).
 * @property {number} [requestTimeoutMs=300000] - Per-request timeout.
 * @property {number} [fetchTimeoutMs=7200000] - Timeout for `/git/fetch`
 *   requests; bundle transfers of large repositories over slow links can
 *   legitimately take hours, so fetch defaults to a much longer ceiling
 *   than ordinary requests.
 * @property {number} [identifyDelayMs=150] - Pause after `identify()` so the
 *   responder records the identity before the first request.
 */

/**
 * rngit repository-node client.
 */
export class RngitClient {
  /** @param {RngitClientOptions} options */
  constructor(options = {}) {
    if (!options.link && !options.url) {
      throw new RemoteUrlError(
        "RngitClient needs either a remote url or a pre-established link",
      );
    }
    /** @type {{ hashHex: string, group: string, repo: string, repoPath: string }|null} */
    this.remote = options.url ? parseRemoteUrl(options.url) : null;
    this.pathTimeoutMs = options.pathTimeoutMs ?? 30000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 7200000;
    this.identifyDelayMs = options.identifyDelayMs ?? 150;

    /** @type {import("@reticulum/core").Reticulum|null} */
    this.rns = options.reticulum ?? null;
    this.ownsReticulum = !options.reticulum && !options.link;
    /** @type {import("@reticulum/core/src/storage/storage.js").StorageAdapter|undefined} */
    this.storageAdapter = options.storageAdapter;
    /** @type {import("@reticulum/core").Identity|null} */
    this.identity = options.identity ?? null;
    /** @type {import("@reticulum/core/src/core/resource.js").Bzip2|null} */
    this.bz2 = options.bz2 ?? null;
    /** @type {import("@reticulum/core").Link|null} */
    this.link = options.link ?? null;
    if (this.link && this.remote === null) {
      // Derive repoPath later via list()? Nothing needed at construction.
    }
  }

  /**
   * Connects to the node: waits for its identity (announce recall),
   * establishes a Link on the `git.repositories` destination and identifies.
   * A no-op when constructed with a `link`.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.link) return;

    if (!this.bz2) this.bz2 = await createBz2();
    if (!this.rns) {
      this.rns = new Reticulum({
        storageAdapter: this.storageAdapter ?? undefined,
        compressionProvider: this.bz2,
      });
    }
    const rns = this.rns;
    if (!this.identity) {
      this.identity = await Identity.loadOrGenerate(rns.storage);
    }
    if (!this.remote) throw new RemoteUrlError("No remote url configured");
    const targetHash = fromHex(this.remote.hashHex);

    const remoteIdentity = await waitForIdentity(
      rns,
      targetHash,
      this.pathTimeoutMs,
    );
    if (!remoteIdentity) {
      throw new Error(
        `Could not learn an identity for ${this.remote.hashHex}. ` +
          "Is the node reachable and has it announced?",
      );
    }

    const destination = await Destination.OUT(
      ASPECT,
      DestType.SINGLE,
      remoteIdentity,
      rns,
    );
    this.link = await destination.createLink();
    this.link.bz2 = this.bz2;
    await this.link.identify(/** @type {any} */ (this.identity));
    // Give the responder a tick to process LINKIDENTIFY before requests.
    await sleep(this.identifyDelayMs);
  }

  /**
   * Ensures a connected link.
   *
   * @returns {Promise<import("@reticulum/core").Link>}
   * @private
   */
  async _link() {
    await this.connect();
    return /** @type {import("@reticulum/core").Link} */ (this.link);
  }

  /**
   * Lists the remote repository's refs and advertised HEAD.
   *
   * @param {boolean} [forPush=false] - Request write-access listing.
   * @returns {Promise<{ head: string|null, refs: Map<string, string> }>}
   */
  async list(forPush = false) {
    if (!this.remote) throw new RemoteUrlError("No remote url configured");
    const link = await this._link();
    const response = await link.request(
      PATH_LIST,
      buildRequest(this.remote.repoPath, { for_push: forPush }),
      { timeout: this.requestTimeoutMs },
    );
    return parseListResponse(response);
  }

  /**
   * Fetches a bundle of the given refs, excluding objects reachable from
   * `have` SHAs (and per-ref `have` ancestors).
   *
   * @param {{ refs: { sha: string, ref: string, have?: string }[], have?: string[], onProgress?: (info: any) => void }} request
   *   `onProgress` receives the Link's transfer progress info (download
   *   direction) while the bundle Resource transfers.
   * @returns {Promise<Uint8Array|null>} Bundle bytes, or `null` when the
   *   server reports every object already available locally.
   * @throws {RngitStatusError} on a non-zero status reply.
   */
  async fetch({ refs, have, onProgress }) {
    if (!this.remote) throw new RemoteUrlError("No remote url configured");
    const link = await this._link();
    const request = buildRequest(this.remote.repoPath, {
      refs: refs.map((r) =>
        r.have
          ? { sha: r.sha, ref: r.ref, have: r.have }
          : { sha: r.sha, ref: r.ref },
      ),
      have: have && have.length > 0 ? have : undefined,
    });

    /** @type {any} */
    let metadata;
    const response = await link.request(PATH_FETCH, request, {
      timeout: this.fetchTimeoutMs,
      onProgress,
      onMetadata: (md) => {
        metadata = md;
      },
    });

    if (!(response instanceof Uint8Array)) {
      throw new Error("Invalid fetch response from rngit node");
    }

    if (metadata !== undefined) {
      // File-with-metadata reply: the response body is the bundle itself.
      const code = resultCodeFromMetadata(metadata);
      if (code !== RES_OK) {
        throw new RngitStatusError(
          code ?? 0xff,
          "rngit node rejected the fetch",
        );
      }
      return response;
    }

    // Plain status-byte reply: `b"\x00"` = empty bundle, else an error.
    const { status, message } = parseStatusResponse(response);
    if (status === RES_OK) return null;
    throw new RngitStatusError(status, message);
  }

  /**
   * Pushes a bundle of `ref` to the node, mirroring the bundle form of the
   * `/git/push` request: `{local_ref, remote_ref, force, bundle}`. When
   * every reachable object already exists on the node, pass `sha` instead
   * of `bundle` and the node updates the ref directly.
   *
   * @param {object} request
   * @param {string} request.ref - Full remote ref name (e.g.
   *   `refs/heads/main`); the bundle records the same name.
   * @param {Uint8Array} [request.bundle] - Bundle v2 bytes built by the
   *   caller.
   * @param {string} [request.sha] - Target object id for the direct
   *   `update_ref` operation when no bundle is needed.
   * @param {boolean} [request.force=false] - Allow non-fast-forward updates.
   * @param {(info: any) => void} [request.onProgress] - Receives the Link's
   *   transfer progress info (upload direction) while the bundle Resource
   *   transfers.
   * @returns {Promise<void>}
   * @throws {RngitStatusError} on a non-zero status reply.
   */
  async push({ ref, bundle, sha, force = false, onProgress }) {
    if (!this.remote) throw new RemoteUrlError("No remote url configured");
    const link = await this._link();
    const request = bundle
      ? buildRequest(this.remote.repoPath, {
          local_ref: ref,
          remote_ref: ref,
          force,
          bundle,
        })
      : buildRequest(this.remote.repoPath, {
          operations: [{ action: "update_ref", ref, sha, force }],
        });
    const response = await link.request(PATH_PUSH, request, {
      timeout: this.fetchTimeoutMs,
      onProgress,
    });
    if (!(response instanceof Uint8Array)) {
      throw new Error("Invalid push response from rngit node");
    }
    const { status, message } = parseStatusResponse(response);
    if (status !== RES_OK) throw new RngitStatusError(status, message);
  }

  /**
   * Deletes a remote ref via `/git/delete`.
   *
   * @param {string} ref - Full ref name (e.g. `refs/heads/feature`).
   * @returns {Promise<void>}
   * @throws {RngitStatusError} on a non-zero status reply.
   */
  async deleteRef(ref) {
    if (!this.remote) throw new RemoteUrlError("No remote url configured");
    const link = await this._link();
    const response = await link.request(
      PATH_DELETE,
      buildRequest(this.remote.repoPath, { ref }),
      { timeout: this.requestTimeoutMs },
    );
    if (!(response instanceof Uint8Array)) {
      throw new Error("Invalid delete response from rngit node");
    }
    const { status, message } = parseStatusResponse(response);
    if (status !== RES_OK) throw new RngitStatusError(status, message);
  }

  /**
   * Tears down the link and, when the client owns it, the Reticulum
   * instance.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.link) {
      try {
        await this.link.teardown();
      } catch {
        /* already closed */
      }
      this.link = null;
    }
    if (this.ownsReticulum && this.rns) {
      await this.rns.stop();
      this.rns = null;
    }
  }
}

/**
 * Polls announce recall for a destination hash until an identity is known.
 *
 * @param {import("@reticulum/core").Reticulum} rns
 * @param {Uint8Array} destinationHash
 * @param {number} timeoutMs
 * @returns {Promise<import("@reticulum/core").Identity|null>}
 */
async function waitForIdentity(rns, destinationHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  try {
    await rns.transport.requestPath(destinationHash);
  } catch {
    /* best-effort; poll retries below */
  }
  while (Date.now() < deadline) {
    const identity = await Destination.recall(destinationHash);
    if (identity) return identity;
    await sleep(1000);
  }
  return null;
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
