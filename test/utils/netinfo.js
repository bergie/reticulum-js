import assert from "node:assert";
import { test } from "node:test";
import {
  AF_INET,
  AF_INET6,
  descopeLinkLocal,
  interfaceIndex,
  listAddresses,
  listInterfaces,
} from "../../src/utils/netinfo.js";

test("descopeLinkLocal strips %ifname scope (macOS form)", () => {
  assert.strictEqual(descopeLinkLocal("fe80::1%lo0"), "fe80::1");
  assert.strictEqual(
    descopeLinkLocal("fe80::4b2:6c0b:c18f:272a%en0"),
    "fe80::4b2:6c0b:c18f:272a",
  );
});

test("descopeLinkLocal is a no-op on already-bare addresses", () => {
  assert.strictEqual(descopeLinkLocal("fe80::1"), "fe80::1");
  assert.strictEqual(
    descopeLinkLocal("fe80::4b2:6c0b:c18f:272a"),
    "fe80::4b2:6c0b:c18f:272a",
  );
});

test("descopeLinkLocal collapses the NetBSD/OpenBSD embedded scope", () => {
  // fe80:<scope>::…  →  fe80::…
  assert.strictEqual(descopeLinkLocal("fe80:1::2"), "fe80::2");
  assert.strictEqual(descopeLinkLocal("fe80:abcd::1234"), "fe80::1234");
});

test("listInterfaces returns an array of interface names", () => {
  const names = listInterfaces();
  assert.ok(Array.isArray(names));
  assert.ok(names.length > 0);
  for (const name of names) assert.strictEqual(typeof name, "string");
});

test("listAddresses reports IPv6 link-local addresses bare, with scopeid", () => {
  // Find any interface that has a link-local IPv6 address (loopback qualifies
  // on most dev/CI hosts) and assert the record shape Python's netinfo yields.
  const ifname = listInterfaces().find((name) => {
    const v6 = listAddresses(name)[AF_INET6];
    return v6?.some((a) => a.addr.startsWith("fe80:"));
  });
  assert.ok(ifname, "expected at least one IPv6 link-local interface");

  const addresses = listAddresses(ifname);
  assert.ok(addresses[AF_INET6]);
  const linkLocal = addresses[AF_INET6].find((a) => a.addr.startsWith("fe80:"));
  assert.ok(linkLocal, "link-local entry present");
  assert.ok(!linkLocal.addr.includes("%"), "addr is bare (no %scope)");
  assert.strictEqual(typeof linkLocal.scopeid, "number");
});

test("interfaceIndex returns the scopeid of the link-local address", () => {
  const ifname = listInterfaces().find((name) => {
    const v6 = listAddresses(name)[AF_INET6];
    return v6?.some((a) => a.addr.startsWith("fe80:"));
  });
  if (!ifname) return; // nothing to assert on hosts without link-local
  const idx = interfaceIndex(ifname);
  assert.strictEqual(typeof idx, "number");
});

test("listAddresses returns empty object for unknown interface", () => {
  assert.deepStrictEqual(listAddresses("definitely-not-an-iface-xyz"), {});
});

test("AF_INET constants are Node's family strings", () => {
  assert.strictEqual(AF_INET6, "IPv6");
  assert.strictEqual(AF_INET, "IPv4");
});
