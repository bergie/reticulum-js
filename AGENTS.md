This repository is for building a pure JavaScript implementation of the Reticulum Networking stack.

We aim for as close to full compatibility with the Python reference implementation as possible.

## Specifications

Implementation specification can be found from `SPEC.md`.

See `PROCOL-SPEC.md` for a non-canonical but hopefully helpful protocol specification.

The canonical specification is the Reticulum Network Python implementation which can be found in the `./Reticulum/RNS` folder.

When the two protocol specifications disagree, the Python implementation is correct.

## Designing interfaces

We aim for modern standard JavaScript feel. This means consistent use of Promises, Web Streams, and if needed, EventTarget. No platform-specific patterns for Node.js or Deno.

At this stage there are no external users for this library, and so API changes are totally OK to do. It is important to keep the API simple and disambiguated. Backwards compatibility is not necessary, just make sure to adapt tests and type definitions.

It is also important to use same terms and concepts as in the Python implementation to maintain familiarity. On high level we should expose roughly the same objects and methods as Python does (allowing for "JavaScriptization" of them). Naming should be changed from Python's `snake_case` to JavaScript's `camelCase` convention.

## Type definitions

Every API interface needs to have TypeScript definitions in JsDoc format. Run `npm run types` after every change to verify compatibility.

## Formatting

Fix formatting with `npm run format` after any changes to source files or tests.

## Tests

We aim for good test coverage. Tests are to be implemented using the Node.js built-in `node:test` library. Tests for each library file should reside in corresponding file under `test` folder, so that for instance tests for Identity (implementation `packages/core/src/core/identity.js` are in `packages/core/test/core/identity.test.js`.

All tests should be verified against the Python reference implementation to make sure we are testing Reticulum compatibility instead of just quirks of our local implementation.

In the end of implementing something, we need to ensure the whole suite works by:
* Running tests with Node.js (`npm test`)
* Running tests with Deno (`npm run test:deno`) if `deno` command is available on the system
* Running tests with Bun (`npm run test:bun`) if `bun` command is available on the system

## Dependencies

This tool aims to run on all modern JavaScript environments. There may be environment-specific interfaces, like for example the TCP Client interface that requires a server-side JavaScript runner like Node.js.

We should minimize or even seek to eliminate dependencies outside of what's in the WinterTC Minimum Common API:
https://min-common-api.proposal.wintertc.org/

The `@reticulum/core` package (`packages/core`) may only depend on the standard web platform. Anything that needs a Node.js core library (`node:`) dependency should live in `packages/node`. Interfaces and other things requiring 3rd party dependencies need packages of their own (see for example the Node.js WebSocket Server package).

## Boundaries

In addition to the global boundaries:

- ✅ **Always**: compare implementation with how the Python reference implementation works and adapt to be compatible with it
- ✅ **Always**: use the logging helper from `packages/core/src/utils/log.js` instead of `console.log` (and `.warn/.error`)
- ✅ **Always**: document major changes in the per-package `CHANGELOG.md` (Unreleased segment)
- 🚫 **Never**: update the root-level `CHANGELOG.md` — that is done as part of the release process
