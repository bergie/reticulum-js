import {
  Destination,
  DestType,
  Identity,
  Reticulum,
  toHex,
} from "@reticulum/core";
import {
  AutoInterface,
  FileStorageAdapter,
  LocalClientInterface,
} from "@reticulum/node";

async function main() {
  const rns = new Reticulum({
    storageAdapter: new FileStorageAdapter("./auto-storage"),
  });

  // AutoInterface: zero-config IPv6-multicast peering on the local network.
  // No `devices` filter ⇒ it adopts every suitable non-ignored interface
  // (Wi-Fi, Ethernet, …) and discovers any Reticulum node on the same link.
  // Peers it discovers are spawned as AutoInterfacePeers and auto-registered
  // with the transport, so the routing table just fills in.
  // Prefer the local shared instance (a running rnsd, or our own daemon): it
  // already owns the mesh interfaces, so we attach to it over the shared-
  // instance socket (auto-discovered from ~/.reticulum/config) instead of
  // opening our own AutoInterface. Falls back to a direct AutoInterface
  // (the original point of this example) when no shared instance is reachable.
  const shared = await LocalClientInterface.connectToSharedInstance();
  if (shared) {
    rns.addInterface(shared, true);
  } else {
    const auto = new AutoInterface({ name: "auto" });
    auto.addEventListener("connection", (/** @type {any} */ event) => {
      const peer = event.detail;
      console.log(`[peer] discovered ${peer.address} (${peer.name})`);
    });
    await auto.connect();
    rns.addInterface(auto, true);
  }

  // Load or create our Identity and announce a SINGLE destination so other
  // nodes on the mesh can see us. The app_data shows up as our "name" in
  // Sideband/NomadNetwork style clients (SPEC §4.3).
  const identity = await Identity.loadOrGenerate(rns.storage);
  identity.setAppData("reticulum-js AutoInterface example");
  console.log(`Our identity hash: ${toHex(identity.identityHash)}`);

  const dest = await Destination.IN(
    "reticulum-js.auto.example",
    DestType.SINGLE,
    identity,
    rns,
  );
  rns.transport.bindLocalDestination(dest);

  // Log every validated announce we hear from the mesh — these arrive over
  // the AutoInterface data path, proving discovery + data interoperability.
  rns.transport.addEventListener("announce", (/** @type {any} */ event) => {
    const d = event.detail;
    const hash = toHex(d.destinationHash);
    const hops = d.packet?.hops ?? "?";
    console.log(`[announce] ${hash} (${hops} hop(s))`);
  });

  await dest.announce();
  console.log(
    `Announced ${toHex(dest.destinationHash)}; listening for peers on the LAN…`,
  );
  console.log("(Ctrl+C to stop)\n");

  process.on("SIGINT", async () => {
    console.log("\nShutting down…");
    await auto.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
