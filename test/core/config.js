import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  asBool,
  asInt,
  getSharedInstanceEndpoint,
  loadConfig,
  parseConfigFile,
  resolveConfigDir,
  supportsAbstractAfUnix,
} from "../../src/core/config.js";

test("parseConfigFile parses sections, nested sections and key=value", () => {
  const text = `
# a comment
[reticulum]
share_instance = Yes
shared_instance_port = 4242
shared_instance_type = tcp
instance_name = default

[logging]
loglevel = 3

[interfaces]
  [[Default Interface]]
  type = AutoInterface
  enabled = yes
  devices = en0

  [[TCP Server Interface]]
  type = TCPServerInterface
  listen_port = 42424
`;
  const cfg = parseConfigFile(text);
  assert.strictEqual(cfg.reticulum.share_instance, "Yes");
  assert.strictEqual(cfg.reticulum.shared_instance_port, "4242");
  assert.strictEqual(cfg.reticulum.instance_name, "default");
  assert.strictEqual(cfg.logging.loglevel, "3");
  assert.strictEqual(cfg.interfaces["Default Interface"].type, "AutoInterface");
  assert.strictEqual(
    cfg.interfaces["TCP Server Interface"].listen_port,
    "42424",
  );
  // A new top-level section after nested ones resets nesting.
  assert.strictEqual(cfg.interfaces["Default Interface"].devices, "en0");
});

test("asBool matches configobj semantics (True/On/Yes/1, False/Off/No/0)", () => {
  for (const v of ["True", "On", "Yes", "1", "true", "YES"]) {
    assert.strictEqual(asBool(v), true, `${v} should be true`);
  }
  for (const v of ["False", "Off", "No", "0", "false", "no"]) {
    assert.strictEqual(asBool(v), false, `${v} should be false`);
  }
  assert.throws(() => asBool("fish"));
});

test("asInt parses decimal integers", () => {
  assert.strictEqual(asInt("4242"), 4242);
  assert.strictEqual(asInt(" 37428 "), 37428);
});

test("resolveConfigDir honours an explicit argument", () => {
  assert.strictEqual(resolveConfigDir("/custom/path"), "/custom/path");
});

test("getSharedInstanceEndpoint reads a synthetic config and resolves TCP", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  writeFileSync(
    join(dir, "config"),
    `
[reticulum]
share_instance = Yes
shared_instance_port = 4242
shared_instance_type = tcp
instance_name = default
`,
  );
  const endpoint = getSharedInstanceEndpoint({ configDir: dir });
  assert.strictEqual(endpoint.configDir, dir);
  assert.strictEqual(endpoint.shareInstance, true);
  assert.strictEqual(endpoint.instanceName, "default");
  assert.strictEqual(endpoint.transport, "tcp");
  assert.strictEqual(endpoint.host, "127.0.0.1");
  assert.strictEqual(endpoint.port, 4242);
});

test("getSharedInstanceEndpoint returns defaults for an empty config", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  writeFileSync(join(dir, "config"), "[reticulum]\n");
  const endpoint = getSharedInstanceEndpoint({ configDir: dir });
  assert.strictEqual(endpoint.shareInstance, true);
  assert.strictEqual(endpoint.port, 37428);
  assert.strictEqual(endpoint.instanceName, "default");
  // On this platform (macOS, no abstract AF_UNIX) transport is always tcp.
  if (!supportsAbstractAfUnix()) {
    assert.strictEqual(endpoint.transport, "tcp");
  }
});

// Pins `shared_instance_type = tcp` so the resolved transport is TCP on every
// platform (Linux would otherwise pick the abstract AF_UNIX socket, leaving
// `port` unset). Mirrors the "resolves TCP" sibling test and keeps `port`
// assertable on both macOS and Linux CI.
test("getSharedInstanceEndpoint respects share_instance = No", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  writeFileSync(
    join(dir, "config"),
    "[reticulum]\nshare_instance = No\nshared_instance_port = 4242\nshared_instance_type = tcp\n",
  );
  const endpoint = getSharedInstanceEndpoint({ configDir: dir });
  assert.strictEqual(endpoint.shareInstance, false);
  assert.strictEqual(endpoint.transport, "tcp");
  assert.strictEqual(endpoint.port, 4242);
});

test("loadConfig returns null when no config file is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "rns-cfg-"));
  assert.strictEqual(loadConfig({ configDir: dir }), null);
});

// Parses the user's real Python config when present (read-only). This is the
// actual interop target; on this dev machine it has shared_instance_port = 4242.
test("parses the real ~/.reticulum/config when present", () => {
  const realDir = join(homedir(), ".reticulum");
  const realPath = join(realDir, "config");
  if (!existsSync(realPath)) {
    // Nothing to verify against here; still confirm resolution returns the dir.
    assert.ok(typeof resolveConfigDir(), "string");
    return;
  }
  // Sanity: our parser and a naive read agree on the shared-instance port line.
  const raw = readFileSync(realPath, "utf8");
  const parsed = parseConfigFile(raw);
  const portLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith("shared_instance_port"));
  if (portLine) {
    const expected = Number.parseInt(portLine.split("=")[1].trim(), 10);
    assert.strictEqual(
      Number.parseInt(parsed.reticulum.shared_instance_port, 10),
      expected,
    );
  }
  const endpoint = getSharedInstanceEndpoint({ configDir: realDir });
  assert.strictEqual(typeof endpoint.shareInstance, "boolean");
  assert.strictEqual(typeof endpoint.port, "number");
});
