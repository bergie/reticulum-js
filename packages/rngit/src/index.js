/**
 * @module index
 * @description @reticulum/rngit — Git repositories over Reticulum.
 *
 * An rngit-compatible client and transport for
 * [isomorphic-git](https://isomorphic-git.org): clone and fetch from
 * `rns://<hash>/<group>/<repo>` remotes served by an rngit node (the
 * reference Python node today, a JS one eventually).
 *
 * ```js
 * import { clone, fetch } from "@reticulum/rngit";
 *
 * await clone({ fs, dir: "./repo", url: "rns://<hash>/<group>/<repo>" });
 * // Later:
 * await fetch({ fs, dir: "./repo" });
 * ```
 *
 * The package is transport-agnostic: `clone`/`fetch` accept a
 * {@link RngitClient} built on any Reticulum instance (shared rnsd
 * connection, AutoInterface, TCP, WebSocket…) matching the caller's
 * platform.
 */

/* @ts-self-types="../types/src/index.d.ts" */

export { buildBundle, emptyPack, parseBundle } from "./bundle.js";
export { createBz2, RngitClient } from "./client.js";
export { clone, fetch, push } from "./commands.js";
export {
  applyDelta,
  buildPack,
  fattenPack,
  inflateWithBounds,
  PackObjectType,
  parsePack,
  resolvePack,
} from "./pack.js";
export {
  asyncIteratorFromBytes,
  chunkBytes,
  concat,
  decodePktLines,
  encodePktLine,
  FLUSH,
} from "./pktline.js";
export {
  ASPECT,
  buildRequest,
  IDX_REPOSITORY,
  IDX_RESULT_CODE,
  PATH_DELETE,
  PATH_FETCH,
  PATH_LIST,
  PATH_PUSH,
  parseListResponse,
  parseStatusResponse,
  RES_DISALLOWED,
  RES_INVALID_REQ,
  RES_NOT_FOUND,
  RES_OK,
  RES_REMOTE_FAIL,
  RngitStatusError,
  resultCodeFromMetadata,
} from "./protocol.js";
export {
  buildInfoRefsResponse,
  buildReportStatusResponse,
  buildUploadPackResponse,
  createRngitTransport,
  parseReceivePackRequest,
  parseUploadPackRequest,
  UnsupportedFeatureError,
} from "./transport.js";
export {
  DESTINATION_HASH_HEX_LENGTH,
  fromPlaceholderHttpUrl,
  parseRemoteUrl,
  RemoteUrlError,
  stringifyRemoteUrl,
  toPlaceholderHttpUrl,
} from "./url.js";
