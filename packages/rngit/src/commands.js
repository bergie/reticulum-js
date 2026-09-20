/**
 * @module commands
 * @description isomorphic-git command wrappers for `rns://` remotes.
 *
 * Stock isomorphic-git rejects remote URLs with unknown schemes
 * (`GitRemoteManager` allows only http/https), so these wrappers translate
 * `rns://<hash>/<group>/<repo>` URLs onto the placeholder form the bundled
 * transport understands, while keeping the original URL verbatim in
 * `.git/config` (interoperable with the reference `git-remote-rns` helper).
 */

import git from "isomorphic-git";
import { RngitClient } from "./client.js";
import { createRngitTransport } from "./transport.js";
import { RemoteUrlError, toPlaceholderHttpUrl } from "./url.js";

/**
 * Resolves the effective remote URL for a wrapper invocation: an explicit
 * `url` option wins; otherwise the named remote's configured URL is read
 * (and must be an `rns://` URL).
 *
 * @param {{ fs: any, gitdir: string, url?: string, remote?: string }} options
 * @returns {Promise<string>}
 */
async function resolveRemoteUrl(options) {
  if (options.url) return options.url;
  const remote = options.remote ?? "origin";
  const remotes = await git.listRemotes({
    fs: options.fs,
    gitdir: options.gitdir,
  });
  const entry = remotes.find((r) => r.remote === remote);
  if (!entry) {
    throw new RemoteUrlError(`No such remote: ${remote}`);
  }
  return entry.url;
}

/**
 * @typedef {object} RngitFetchOptions
 * @property {any} fs - An isomorphic-git filesystem client.
 * @property {string} [dir] - Working tree directory.
 * @property {string} [gitdir] - Git directory (defaults to `dir/.git`).
 * @property {string} [remote="origin"] - Remote name to fetch from.
 * @property {string} [url] - Explicit `rns://…` URL (overrides the remote's
 *   configured URL without rewriting it).
 * @property {import("./client.js").RngitClient} [client] - Pre-configured
 *   client. When omitted, one is created for this fetch and closed after.
 * @property {(event: any) => void} [onProgress]
 * @property {(message: string) => void} [onMessage]
 * @property {string} [ref] - Branch or tag to fetch.
 * @property {boolean} [singleBranch]
 * @property {boolean} [noTags]
 * @property {boolean} [prune]
 * @property {boolean} [pruneTags]
 * @property {object} [cache]
 */

/**
 * Fetches from an rngit remote, updating remote-tracking refs.
 *
 * Mirrors `git.fetch(options)` from isomorphic-git (same result object),
 * except the remote may be (and usually is) an `rns://` URL.
 *
 * @param {RngitFetchOptions} options
 * @returns {Promise<any>}
 */
export async function fetch(options) {
  const { fs, dir, gitdir = dir ? `${dir}/.git` : undefined } = options;
  if (!gitdir) throw new Error("fetch requires dir or gitdir");
  const url = await resolveRemoteUrl({
    fs,
    gitdir,
    url: options.url,
    remote: options.remote,
  });
  const ownsClient = !options.client;
  const client =
    options.client ?? new RngitClient({ url, ...transportDefaults(options) });
  try {
    const http = createRngitTransport(client, { fs, gitdir });
    return await git.fetch({
      fs,
      gitdir,
      http,
      remote: options.remote,
      url: toPlaceholderHttpUrl(url),
      onProgress: options.onProgress,
      onMessage: options.onMessage,
      ref: options.ref,
      singleBranch: options.singleBranch,
      tags: !options.noTags,
      prune: options.prune,
      pruneTags: options.pruneTags,
      cache: options.cache,
    });
  } finally {
    if (ownsClient) await client.close();
  }
}

/**
 * @typedef {object} RngitCloneOptions
 * @property {any} fs - An isomorphic-git filesystem client.
 * @property {string} dir - Directory to clone into.
 * @property {string} [gitdir] - Git directory (defaults to `dir/.git`).
 * @property {string} url - `rns://<hash>/<group>/<repo>` remote URL.
 * @property {string} [remote="origin"] - Name for the created remote.
 * @property {string} [ref] - Branch to check out (default: remote HEAD).
 * @property {boolean} [singleBranch=false]
 * @property {boolean} [noCheckout=false]
 * @property {boolean} [noTags=false]
 * @property {import("./client.js").RngitClient} [client] - Pre-configured
 *   client. When omitted, one is created for this clone and closed after.
 * @property {(event: any) => void} [onProgress]
 * @property {(message: string) => void} [onMessage]
 * @property {any} [onPostCheckout]
 * @property {object} [cache]
 */

/**
 * Clones an rngit repository into `dir`.
 *
 * Replicates isomorphic-git's clone pipeline (`init` → `addRemote` →
 * `fetch` → `checkout`) using the public commands so that the recorded
 * remote URL stays the original `rns://…` form rather than the placeholder
 * the transport speaks.
 *
 * @param {RngitCloneOptions} options
 * @returns {Promise<{ defaultBranch: string|null, fetchHead: string|null }>}
 */
export async function clone(options) {
  const { fs, dir, url, remote = "origin" } = options;
  if (!dir) throw new Error("clone requires dir");
  if (!url) throw new Error("clone requires url");
  const gitdir = options.gitdir ?? `${dir}/.git`;

  const ownsClient = !options.client;
  const client =
    options.client ?? new RngitClient({ url, ...transportDefaults(options) });
  try {
    await git.init({ fs, dir, gitdir });
    await git.addRemote({ fs, gitdir, remote, url });
    const http = createRngitTransport(client, { fs, gitdir });
    const { defaultBranch, fetchHead } = await git.fetch({
      fs,
      gitdir,
      http,
      remote,
      url: toPlaceholderHttpUrl(url),
      ref: options.ref,
      singleBranch: options.singleBranch,
      tags: !options.noTags,
      onProgress: options.onProgress,
      onMessage: options.onMessage,
      cache: options.cache,
    });
    if (fetchHead === null) {
      return { defaultBranch, fetchHead: null };
    }
    const ref = (options.ref || defaultBranch || "master").replace(
      "refs/heads/",
      "",
    );
    await git.checkout({
      fs,
      dir,
      gitdir,
      ref,
      remote,
      track: true,
      noCheckout: options.noCheckout,
      onProgress: options.onProgress,
      onPostCheckout: options.onPostCheckout,
      cache: options.cache,
    });
    return { defaultBranch, fetchHead };
  } catch (err) {
    // Remove the partial local repository, mirroring isomorphic-git's
    // own clone failure handling. Works with both promise-style and
    // callback-style fs clients (best-effort in both cases).
    try {
      const rm = fs.promises?.rm ?? fs.rm?.bind(fs);
      if (rm) await rm(gitdir, { recursive: true, force: true });
    } catch {
      /* best effort — the original error matters more */
    }
    throw err;
  } finally {
    if (ownsClient) await client.close();
  }
}

/**
 * Extracts the client-relevant transport options from a command options bag.
 *
 * @param {any} options
 * @returns {{ bz2?: any, reticulum?: any, identity?: any, storageAdapter?: any, pathTimeoutMs?: number, requestTimeoutMs?: number }}
 */
function transportDefaults(options) {
  return {
    bz2: options.bz2,
    reticulum: options.reticulum,
    identity: options.identity,
    storageAdapter: options.storageAdapter,
    pathTimeoutMs: options.pathTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  };
}
