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
