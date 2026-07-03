This repository is for building a pure JavaScript implementaton of the Reticulum Networking stack.

We aim for as close to full compatibility with the Python reference implementation as possible.

## Specifications

Implementation specification can be found from `SPEC.md`.

See `PROCOL-SPEC.md` for a non-canonical but hopefully helpful protocol specification.

The canonical specification is the Reticulum Network Python implementation which can be found in the `./Reticulum/RNS` folder.

When the two protocol specifications disagree, the Python implementation is correct.

## Work documents

Technical work is planned with work documents (in Markdown) that are managed using `rngit` tool and repository in `rns://3ea5aad068a337670f5bb8073226adb4/public/reticulum-js`. Commands to read work documents:

- List work documents: `rngit work rns://3ea5aad068a337670f5bb8073226adb4/public/reticulum-js list`.
- Read work document: `rngit work rns://3ea5aad068a337670f5bb8073226adb4/public/reticulum-js view -d N` (where `N` is the document number from the work documents list)

AI agents may not create work documents on their own. Create a markdown file in the root folder of the project and ask user to move it to rngit.

## Designing interfaces

We aim for modern standard JavaScript feel. This means consistent use of Promises, Web Streams, and if needed, EventTarget. No platform-specific patterns for Node.js or Deno.

At this stage there are no external users for this library, and so API changes are totally OK to do. It is important to keep the API simple and disambiguated. Backwards compatibility is not necessary, just make sure to adapt tests and type definitions.

It is also important to use same terms and concepts as in the Python implementation to maintain familiarity. On high level we should expose roughly the same objects and methods as Python does (allowing for "JavaScriptization" of them). Naming should be changed from Python's `snake_case` to JavaScript's `camelCase` convention.

## Type definitions

Every API interface needs to have TypeScript definitions in JsDoc format. Run `npm run types` after every change to verify compatibility.

## Tests

We aim for good test coverage. Tests are to be implemented using the Node.js built-in `node:test` library. Tests for each library file should recide in corresponding file under `test` folder, so that for instance tests for Identity (implementation `src/core/identity.js` are in `test/core/identity.js`.

All tests should be verified against the Python reference implementation to make sure we are testing Reticulum compatibility instead of just quirks of our local implementation.

## Dependencies

This tool aims to run on all modern JavaScript environments. There may be environment-specific interfaces, like for example the TCP Client interface that requires a server-side JavaScript runner like Node.js.

We should minimize or even seek to eliminate dependencies outside of what's in the WinterTC Minimum Common API:
https://min-common-api.proposal.wintertc.org/

## Boundaries

- ⚠️ **Ask first**: adding dependencies
- ⚠️ **Ask first**: modify CI config
- 🚫 **Never**: AI agents may not make commits on their own, instead notify user that there are uncommitted changes to review
