# Changelog

## [Unreleased]

## [0.9.0] - 2026-09-21
### Changed
- Identity recalls during `connect()` go through `rns.transport` instead of
  the deprecated `Destination` class statics, and `connect()` warns
  (`warnIfFragmented`) when the client was bundled against a different
  physical copy of `@reticulum/core` than the provided `Reticulum` instance
  (work doc #37, split-brain safety).
### Added
- Initial `@reticulum/rngit` package: an rngit-compatible client and
  isomorphic-git transport for Git repositories over Reticulum.
- `parseRemoteUrl` / `stringifyRemoteUrl` for `rns://<hash>/<group>/<repo>`
  remote URLs.
- `RngitClient` — connects to an rngit node (`git.repositories`
  destination), identifies, and speaks the `/git/list` and `/git/fetch`
  request protocol (msgpack maps with integer keys, status-byte responses,
  bundle Resources with response metadata).
- `createRngitTransport` — an isomorphic-git `http` plugin that bridges the
  git smart-HTTP protocol onto rngit requests, so stock
  `git.fetch`/`git.clone` work against `rns://` remotes.
- `fetch` / `clone` command wrappers accepting `rns://` remote URLs.
- Bundle v2 parsing (refs, prerequisites, packfile extraction).
- Packfile thin-base resolution: rngit fetch bundles exclude objects
  reachable from the client's `have` list, so their embedded packfiles can
  carry deltas against objects that are not part of the pack. Canonical
  git refuses to keep such thin packs in `objects/pack`, so before the
  pack is handed to isomorphic-git the transport resolves external delta
  bases from the local object store and re-emits a self-contained pack
  (`fattenPack`, `resolvePack`, `buildPack`, `applyDelta` and a minimal
  inflate decoder `inflateWithBounds`).
- Push support, mirroring the reference `git-remote-rns` flows:
  - `RngitClient.push({ ref, bundle?, sha?, force })` — the bundle form
    (`{local_ref, remote_ref, force, bundle}`) for new objects, and the
    direct `update_ref` operations form when everything reachable already
    exists on the node.
  - `RngitClient.deleteRef(ref)` — `/git/delete`.
  - The `push` command wrapper (isomorphic-git `git.push` semantics for
    `rns://` remotes, including `force` and `delete`).
  - The transport's receive-pack endpoint: parses the pushed commands and
    packfile, wraps the pack in a bundle v2 (`buildBundle`), answers with
    a `report-status` reply (side-band-64k framed when negotiated).
  - Deletions map to `/git/delete`; zero-object pushes take the direct
    `update_ref` path without a bundle transfer.
- Transfer progress: `clone`/`fetch` report isomorphic-git progress
  events (`Receiving objects`) while bundle resources download, `push`
  reports `Writing objects` while they upload. Split transfers aggregate
  completed segments with a converging total estimate.
- Live interop coverage (env-gated): the test suite can clone, fetch, push
  and delete against a real rngit node.
### Fixed
- The bundled bz2 adapter failing on payloads that do not compress: the
  wasm module sizes its destination buffer from the input length and
  errors with `BZ_OUTBUFF_FULL` whenever compression would expand the
  data (small incompressible payloads, e.g. short push bundles). The
  adapter now returns the input unchanged in that case, which the
  Resource protocol already treats as "send uncompressed".
