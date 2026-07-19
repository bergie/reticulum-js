This repository is for building a pure JavaScript implementaton of the Reticulum Networking stack.

We aim for as close to full compatibility with the Python reference implementation as possible.

## Specifications

Implementation specification can be found from `SPEC.md`.

See `PROCOL-SPEC.md` for a non-canonical but hopefully helpful protocol specification.

The canonical specification is the Reticulum Network Python implementation which can be found in the `./Reticulum/RNS` folder.

When the two protocol specifications disagree, the Python implementation is correct.

## Work documents

Technical work is planned with work documents (in Markdown) that are managed using `rngit` tool and repository in `rns://3ea5aad068a337670f5bb8073226adb4/public/reticulum-js`. The appropriate [pi skill extension](https://github.com/bergie/pi-rngit-work-document-skill) should be available.

When planning new work, there should always be a corresponding work document created explaining the idea. When implementing, the appropriate work document should be kept up-to-date by posting updates to it. Agent may _propose_ work documents, not _create_ them.

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

- ✅ **Always**: write at least smoketests for any new functionality
- ✅ **Always**: ensure type safety. Always check eith `npm run types` after changes and fix as needed
- ✅ **Always**: fix formatting with `npm run format` after any changes to source files or tests
- ✅ **Always**: compare implementation with how the Python reference implementation works and adapt to be compatible with it
- ✅ **Always**: Use `git mv` instead of `mv' for renaming files
- ✅ **Always**: Remove ambiguity and legacy support from APIs you modify. Right now there are no API consumers outside this repo so we can keep things fluid
- ✅ **Always**: Use the logging helper from `src/utils/log.js` instead of `console.log` (and `.warn/.error`)
- ✅ **Always**: Keep the work document associated with current task up-to-date
- ⚠️ **Ask first**: adding dependencies
- ⚠️ **Ask first**: modify CI config
- ⚠️ **Ask first**: allow an optional input to a method
- 🚫 **Never**: AI agents may not make commits on their own, instead notify user that there are uncommitted changes to review
- 🚫 **Never**: AI agents may not mark work documents completed on their own, instead ask user to do so
