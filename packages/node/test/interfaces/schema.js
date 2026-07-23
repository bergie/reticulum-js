import assert from "node:assert";
import { test } from "node:test";
import { Interface } from "@reticulum/core/src/interfaces/base.js";
import { WebSocketClientInterface } from "@reticulum/core/src/interfaces/websocket.js";
import { AutoInterface } from "../../src/interfaces/auto.js";
import {
  getInterface,
  getSchema,
  listInterfaces,
  registerInterface,
} from "../../src/interfaces/registry.js";
import {
  TCPClientInterface,
  TCPServerInterface,
} from "../../src/interfaces/tcp.js";

/** @param {object} schema */
function assertValidSchema(schema) {
  assert.strictEqual(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.strictEqual(schema.type, "object");
  assert.ok(schema.properties, "schema should have properties");
  assert.ok(Array.isArray(schema.required), "schema should declare required");
}

test("Interface base class declares the common options (name, ifacSize)", () => {
  const schema = Interface.getConfigurationSchema();
  assertValidSchema(schema);
  assert.ok(schema.properties.name, "base should declare name");
  assert.ok(schema.properties.ifacSize, "base should declare ifacSize");
});

test("subclasses inherit name and ifacSize from the base schema", () => {
  const baseSchema = Interface.getConfigurationSchema();
  for (const cls of [
    AutoInterface,
    TCPClientInterface,
    TCPServerInterface,
    WebSocketClientInterface,
  ]) {
    const schema = cls.getConfigurationSchema();
    // Inherited structurally from the base schema (not redefined locally).
    assert.deepStrictEqual(
      schema.properties.name,
      baseSchema.properties.name,
      `${cls.name} should inherit name from base`,
    );
    assert.deepStrictEqual(
      schema.properties.ifacSize,
      baseSchema.properties.ifacSize,
      `${cls.name} should inherit ifacSize from base`,
    );
    assert.strictEqual(schema.$schema, baseSchema.$schema);
  }
});

test("TCPClientInterface schema documents its options", () => {
  const schema = TCPClientInterface.getConfigurationSchema();
  assertValidSchema(schema);
  assert.ok(schema.properties.host, "should expose host");
  assert.ok(schema.properties.port, "should expose port");
  assert.ok(schema.properties.ifacSize, "should expose ifacSize");
  assert.ok(schema.properties.name, "should expose name");
  assert.ok(schema.properties.i2pTunneled, "should expose i2pTunneled");
  // Reconnect options are shared with the WebSocket client.
  assert.ok(schema.properties.autoReconnect, "should expose autoReconnect");
  assert.ok(schema.properties.reconnectWait, "should expose reconnectWait");
  assert.ok(
    schema.properties.maxReconnectTries,
    "should expose maxReconnectTries",
  );
  assert.ok(schema.properties.connectTimeout, "should expose connectTimeout");
  // The internal `socket` adoption option is deliberately excluded.
  assert.ok(!schema.properties.socket, "should not expose internal socket");
  assert.deepStrictEqual(schema.required, ["host", "port"]);
});

test("TCPServerInterface schema documents its options", () => {
  const schema = TCPServerInterface.getConfigurationSchema();
  assertValidSchema(schema);
  assert.ok(schema.properties.port);
  assert.ok(schema.properties.listenIp);
  assert.ok(schema.properties.ifacSize);
  assert.deepStrictEqual(schema.required, ["port"]);
});

test("WebSocketClientInterface schema documents its options", () => {
  const schema = WebSocketClientInterface.getConfigurationSchema();
  assertValidSchema(schema);
  assert.ok(schema.properties.url);
  assert.ok(schema.properties.host);
  assert.ok(schema.properties.port);
  assert.ok(schema.properties.autoReconnect, "should expose autoReconnect");
  assert.ok(schema.properties.reconnectWait, "should expose reconnectWait");
  assert.ok(
    schema.properties.maxReconnectTries,
    "should expose maxReconnectTries",
  );
  assert.ok(schema.properties.connectTimeout, "should expose connectTimeout");
  // The internal `websocket` adoption option is deliberately excluded.
  assert.ok(
    !schema.properties.websocket,
    "should not expose internal websocket",
  );
  // No single required field: either url or host+port at runtime.
  assert.deepStrictEqual(schema.required, []);
});

test("every declared option has a description", () => {
  for (const cls of [
    AutoInterface,
    TCPClientInterface,
    TCPServerInterface,
    WebSocketClientInterface,
  ]) {
    const schema = cls.getConfigurationSchema();
    for (const [key, prop] of Object.entries(schema.properties)) {
      assert.ok(
        prop.description,
        `${cls.name}.${key} should have a description`,
      );
    }
  }
});

test("TCP ports default to the standard rnsd port 4242", () => {
  assert.strictEqual(
    TCPClientInterface.getConfigurationSchema().properties.port.default,
    4242,
  );
  assert.strictEqual(
    TCPServerInterface.getConfigurationSchema().properties.port.default,
    4242,
  );
});

test("reconnect schema defaults mirror the Python reference", () => {
  for (const cls of [TCPClientInterface, WebSocketClientInterface]) {
    const props = cls.getConfigurationSchema().properties;
    assert.strictEqual(props.autoReconnect.default, true);
    assert.strictEqual(props.reconnectWait.default, 5);
    assert.strictEqual(props.connectTimeout.default, 5);
    // maxReconnectTries is null/unlimited by default.
    assert.ok(
      props.maxReconnectTries.anyOf,
      "maxReconnectTries accepts null for unlimited",
    );
  }
});

test("server interfaces do not expose reconnect options", () => {
  // Reconnect is an initiator-only concern; server interfaces must not list it.
  const tcpServer = TCPServerInterface.getConfigurationSchema().properties;
  assert.ok(!tcpServer.autoReconnect);
  assert.ok(!tcpServer.reconnectWait);
});

test("schema defaults track the constructor fallbacks", () => {
  // WebSocketClientInterface constructor defaults host to "localhost".
  assert.strictEqual(
    WebSocketClientInterface.getConfigurationSchema().properties.host.default,
    "localhost",
  );
});

test("port options carry illustrative examples", () => {
  for (const cls of [
    TCPClientInterface,
    TCPServerInterface,
    WebSocketClientInterface,
  ]) {
    const portProp =
      cls.getConfigurationSchema().properties.port ??
      cls.getConfigurationSchema().properties.listenPort;
    assert.ok(
      Array.isArray(portProp.examples) && portProp.examples.length > 0,
      `${cls.name} port should have examples`,
    );
  }
});

test("AutoInterface schema documents its options", () => {
  const schema = AutoInterface.getConfigurationSchema();
  assertValidSchema(schema);
  assert.ok(schema.properties.groupId, "should expose groupId");
  assert.ok(schema.properties.discoveryPort, "should expose discoveryPort");
  assert.ok(schema.properties.dataPort, "should expose dataPort");
  assert.ok(schema.properties.devices, "should expose devices allow-list");
  assert.ok(schema.properties.ignoredDevices, "should expose ignoredDevices");
  assert.strictEqual(schema.title, "AutoInterface");
  // AutoInterface needs no single option at construction time.
  assert.deepStrictEqual(schema.required, []);
});

test("registry lists all built-in interfaces", () => {
  const ids = listInterfaces().map((entry) => entry.id);
  assert.ok(ids.includes("auto"));
  assert.ok(ids.includes("tcp-client"));
  assert.ok(ids.includes("tcp-server"));
  assert.ok(ids.includes("ws-client"));
});

test("registry entries expose id, name, schema and interfaceClass", () => {
  for (const entry of listInterfaces()) {
    assert.ok(entry.id);
    assert.ok(entry.name);
    assertValidSchema(entry.schema);
    assert.strictEqual(typeof entry.interfaceClass, "function");
  }
});

test("getInterface and getSchema resolve registered ids", () => {
  assert.strictEqual(getInterface("tcp-client"), TCPClientInterface);
  assert.strictEqual(getInterface("missing"), undefined);
  // Fresh schema literals, so compare structurally.
  assert.deepStrictEqual(
    getSchema("tcp-server"),
    TCPServerInterface.getConfigurationSchema(),
  );
  assert.strictEqual(getSchema("missing"), undefined);
});

test("registerInterface adds a custom interface", () => {
  class CustomInterface extends Interface {}
  registerInterface("custom-test", CustomInterface);
  assert.strictEqual(getInterface("custom-test"), CustomInterface);
  assert.ok(getSchema("custom-test"));
});
