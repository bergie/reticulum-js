# Changelog

## [Unreleased]
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
