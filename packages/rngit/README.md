# @reticulum/rngit

rngit (Reticulum Git) transport for [isomorphic-git](https://isomorphic-git.org/).

Clone, fetch from and push to `rns://` Git remotes served by an
[rngit](https://reticulum.network/manual/git.html) node — from Node.js,
Deno, Bun or the browser.

## Example: clone, commit, push

```js
import fs from "node:fs";
import git from "isomorphic-git";
import { AutoInterface, LocalClientInterface } from "@reticulum/node";
import { Reticulum } from "@reticulum/core";
import { RngitClient, clone, push } from "@reticulum/rngit";

// Connect to the mesh however your platform allows. Here: a local rnsd
// shared instance, falling back to AutoInterface.
const rns = new Reticulum();
const shared = await LocalClientInterface.connectToSharedInstance();
if (shared) {
  rns.addInterface(shared, true);
} else {
  const auto = new AutoInterface({ name: "auto" });
  await auto.connect();
  rns.addInterface(auto, true);
}

// The client ties the mesh connection to one rngit remote and holds your
// Reticulum identity, which the node needs to see for push permissions.
const url = "rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js";
const client = new RngitClient({ url, reticulum: rns });

// Clone into a working directory. The remote stays recorded as `rns://…`
// in .git/config, so later fetches and pushes only need `dir` and the client.
await clone({ fs, dir: "./reticulum-js", url, client });

// Make a commit.
fs.writeFileSync("./reticulum-js/EXAMPLE.md", "# Hello from rngit\n");
await git.commit({
  fs,
  dir: "./reticulum-js",
  message: "Add EXAMPLE.md",
  author: { name: "Your Name", email: "you@example.com" },
});

// Push it back over the mesh.
await push({ fs, dir: "./reticulum-js", ref: "main", client });
```

The push requires `w` (write) permission for your Reticulum identity on
the node — see the rngit node's access configuration.

Fetches pick up new commits the same way:

```js
import { fetch } from "@reticulum/rngit";

await fetch({ fs, dir: "./reticulum-js", client });
```

And `RngitClient.deleteRef("refs/heads/…")` removes a remote ref
(`/git/delete`).

## Where the client identity lives

With a `reticulum` instance backed by a storage adapter, the client
identity persists between runs:

```js
import { FileStorageAdapter } from "@reticulum/node";
import { Reticulum } from "@reticulum/core";
import { RngitClient, clone } from "@reticulum/rngit";

const rns = new Reticulum({ storageAdapter: new FileStorageAdapter("~/.reticulum-js") });
await clone({
  fs,
  dir: "./reticulum-js",
  url: "rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js",
  client: new RngitClient({
    url: "rns://adafb3153efd4d96d532568a5208b3b5/reticulum/reticulum-js",
    reticulum: rns,
  }),
});
```

See the [package changelog](./CHANGELOG.md) for the current
implementation state, and the rngit section of the
[Reticulum manual](https://reticulum.network/manual/rngit.html) for the
node-side protocol.
