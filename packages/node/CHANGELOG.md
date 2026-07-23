# Changelog

## [Unreleased]
### Added
- New package, carved out of [`@reticulum/core`](../core) (work doc #22):
  the Node.js-only Reticulum interfaces and the interface registry, so the
  core can stay browser-safe. Hosts `TCPClientInterface`/`TCPServerInterface`
  (`tcp`), `AutoInterface` (`auto`), `LocalClientInterface` (`local-client`,
  including shared-instance endpoint discovery and `~/.reticulum/config`
  parsing), `HttpPostServerInterface` (`http-server`), and the registry
  (`listInterfaces`/`getInterface`/`getSchema`/`registerInterface`, which also
  aggregates the browser-safe interfaces from `@reticulum/core`). Depends on
  `@reticulum/core`.
- `FileStorageAdapter` (`src/storage/file.js`, work doc #16): the Node.js
  reference `StorageAdapter`, exported from the package index. Constructed with
  a client-chosen root folder — `new FileStorageAdapter(directory)` — under
  which it writes `<dir>/identity.key` and `<dir>/<namespace>/<key>.bin`. Uses
  `node:fs/promises` (non-blocking); reads return `null`/`[]` on missing
  records, `delete` is idempotent, and a guard rejects path-traversing keys /
  namespaces. `examples/*` now import it instead of each carrying an inline
  loadKey/saveKey-only copy.
