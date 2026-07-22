/**
 * @file netinfo.js
 * @description Network interface enumeration helpers for the
 *   {@link AutoInterface}, mirroring the role of the Python reference
 *   `RNS.Interfaces.util.netinfo` module.
 *
 * The Python reference reaches into the system `getifaddrs`/`GetAdapters*` APIs
 * via `ctypes` and reports interface names, per-interface address families,
 * link-local IPv6 addresses and numeric interface indexes. Node.js exposes the
 * same information through `os.networkInterfaces()`, so this module adapts that
 * API into the Python-shaped calls (`listInterfaces`, `listAddresses`,
 * `descopeLinkLocal`, `interfaceIndex`) that `AutoInterface` relies on.
 *
 * This module is Node-only (`node:os`).
 */
import os from "node:os";

/**
 * Address-family tag mirroring Python's `netinfo.AF_INET6`, as compared with
 * `if AF_INET6 in listAddresses(ifname)`. Node's `networkInterfaces()` reports
 * families as the strings `"IPv4"` / `"IPv6"`, so those strings are the tags.
 */
export const AF_INET6 = "IPv6";
/**
 * Address-family tag mirroring Python's `netinfo.AF_INET`.
 */
export const AF_INET = "IPv4";

/**
 * Lists the names of all present network interfaces (configured or not),
 * matching the shape of Python's `netinfo.interfaces()`.
 *
 * The order is whatever `os.networkInterfaces()` yields (insertion order of the
 * host's interface table); callers that need determinism for tests should pin a
 * specific interface via the `devices` option.
 * @returns {string[]}
 */
export function listInterfaces() {
  return Object.keys(os.networkInterfaces());
}

/**
 * Returns the addresses configured on `ifname`, keyed by family tag
 * ({@link AF_INET6} / {@link AF_INET}), mirroring the shape of Python's
 * `netinfo.ifaddresses(ifname)`.
 *
 * IPv6 entries carry the **bare** address in `addr` (no `%scope` suffix, just as
 * Python's netinfo does) plus the numeric `scopeid` that Node exposes
 * separately. IPv4 entries carry `addr` and `netmask`.
 *
 * Returns an empty object for an unknown interface.
 * @param {string} ifname
 * @returns {{ [family: string]: Array<{ addr: string; scopeid?: number; netmask?: string; cidr?: string | null }> }}
 */
export function listAddresses(ifname) {
  const entries = os.networkInterfaces()[ifname];
  /** @type {{ [family: string]: Array<{ addr: string; scopeid?: number; netmask?: string; cidr?: string | null }> }} */
  const out = {};
  if (!entries) return out;
  for (const entry of entries) {
    if (entry.family !== AF_INET6 && entry.family !== AF_INET) continue;
    if (!out[entry.family]) out[entry.family] = [];
    const list = out[entry.family];
    if (entry.family === AF_INET6) {
      list.push({ addr: entry.address, scopeid: entry.scopeid });
    } else {
      list.push({
        addr: entry.address,
        netmask: entry.netmask,
        cidr: entry.cidr,
      });
    }
  }
  return out;
}

/**
 * Normalizes a link-local IPv6 address string by dropping its scope specifier,
 * matching Python's `AutoInterface.descope_linklocal`:
 *
 * - Drops the `%ifname` scope suffix as used on macOS (`fe80::1%lo0` →
 *   `fe80::1`).
 * - Drops the embedded scope form used on NetBSD/OpenBSD
 *   (`fe80:1::…` → `fe80::`).
 *
 * Both the local adopted addresses and the source addresses compared against
 * discovery tokens are descope'd, so sender and receiver agree on the bare
 * link-local string regardless of how the host spells the scope.
 * @param {string} addr
 * @returns {string}
 */
export function descopeLinkLocal(addr) {
  // Drop scope specifier expressed as %ifname (macOS).
  let a = String(addr).split("%")[0];
  // Drop embedded scope specifier (NetBSD, OpenBSD). Unanchored, matching
  // Python's `re.sub(r"fe80:[0-9a-f]*::", "fe80::", …)`.
  a = a.replace(/fe80:[0-9a-f]*::/, "fe80::");
  return a;
}

/**
 * Best-effort numeric interface index for `ifname`, mirroring Python's
 * `interface_name_to_index` (which wraps `socket.if_nametoindex`).
 *
 * Node does not expose `if_nametoindex` directly; the IPv6 `scopeid` that Node
 * reports for a link-local address is, however, the same kernel interface index
 * on every platform we target, so we return that. The {@link AutoInterface}
 * itself binds and joins multicast by **scoped address** (`fe80::1%lo0`) rather
 * than by numeric index, so this is provided for parity and future use (e.g.
 * the link-local rebind job) rather than required for discovery.
 *
 * Returns `undefined` when the interface has no IPv6 link-local address.
 * @param {string} ifname
 * @returns {number | undefined}
 */
export function interfaceIndex(ifname) {
  const v6 = listAddresses(ifname)[AF_INET6];
  if (!v6) return undefined;
  for (const entry of v6) {
    if (entry.addr.startsWith("fe80:")) return entry.scopeid;
  }
  return undefined;
}
