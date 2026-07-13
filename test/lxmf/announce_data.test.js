/**
 * Tests for the `lxmf.delivery` announce `app_data` msgpack format (SPEC §4.3).
 *
 * The builder must emit the exact upstream wire bytes; the parser must tolerate
 * the four legacy shapes (3/2/1-element arrays + raw UTF-8).
 */
import assert from "node:assert";
import test from "node:test";
import {
  buildAnnounceAppData,
  parseAnnounceAppData,
} from "../../src/lxmf/announce_data.js";
import { MicroMsgPack } from "../../src/utils/msgpack.js";
import { SF_COMPRESSION } from "../../src/lxmf/constants.js";

// ---------------------------------------------------------------------------
// Builder — canonical wire bytes
// ---------------------------------------------------------------------------

test("§4.3 buildAnnounceAppData emits the canonical 3-element msgpack array", () => {
  // display_name = "Reticulum5", stamp_cost = nil (stamping off).
  // Expected bytes (SPEC §4.3):
  //   93                            fixarray(3)
  //   c4 0a <"Reticulum5">          bin8 len=10
  //   c0                            nil
  //   91 00                         fixarray(1): [SF_COMPRESSION]
  const bytes = buildAnnounceAppData("Reticulum5", null);
  assert.deepStrictEqual(
    Array.from(bytes),
    [
      0x93,
      0xc4,
      0x0a,
      0x52,
      0x65,
      0x74,
      0x69,
      0x63,
      0x75,
      0x6c,
      0x75,
      0x6d,
      0x35,
      0xc0,
      0x91,
      0x00,
    ],
  );
});

test("§4.3 display name is encoded as msgpack bin (0xc4), not str", () => {
  // §9.3: a str-encoded name breaks peer-name display in Sideband/Nomadnet.
  const bytes = buildAnnounceAppData("Alice", null);
  assert.strictEqual(bytes[0], 0x93, "outer fixarray(3)");
  assert.strictEqual(bytes[1], 0xc4, "element 0 must be bin8, not a fixstr");
  assert.strictEqual(bytes[2], 0x05, "bin8 length = 5");
  assert.strictEqual(bytes[8], 0xc0, "element 1 must be nil");
});

test("§4.3 stamp_cost is emitted as a fixint when set", () => {
  const bytes = buildAnnounceAppData("Bob", 8);
  // After bin8(name=3) we expect stamp_cost = fixint 8 (0x08), then 91 00.
  // 93 c4 03 <"Bob"> 08 91 00
  assert.deepStrictEqual(
    Array.from(bytes),
    [0x93, 0xc4, 0x03, 0x42, 0x6f, 0x62, 0x08, 0x91, 0x00],
  );
});

test("§4.3 defaults: stamp_cost nil + [SF_COMPRESSION] when omitted", () => {
  const bytes = buildAnnounceAppData("Zed");
  // stamp_cost defaults to nil, capabilities to [SF_COMPRESSION].
  assert.strictEqual(bytes[bytes.length - 2], 0x91);
  assert.strictEqual(bytes[bytes.length - 1], SF_COMPRESSION);
  // The nil sits right before the capability list.
  assert.strictEqual(bytes[bytes.length - 3], 0xc0);
});

// ---------------------------------------------------------------------------
// Parser — round-trip + legacy tolerance
// ---------------------------------------------------------------------------

test("§4.3 parseAnnounceAppData round-trips a freshly-built blob", () => {
  const bytes = buildAnnounceAppData("Carol", 16, [SF_COMPRESSION]);
  const parsed = parseAnnounceAppData(bytes);
  assert.ok(parsed);
  assert.strictEqual(parsed.displayName, "Carol");
  assert.strictEqual(parsed.stampCost, 16);
  assert.deepStrictEqual(parsed.supportedFunctions, [SF_COMPRESSION]);
});

test("§4.3 parser reads a name emitted as msgpack str by a legacy sender", () => {
  // Some clients encoded element 0 as str (fixstr/str8) rather than bin.
  const legacy = MicroMsgPack.encode(["Dave", null, [SF_COMPRESSION]]);
  const parsed = parseAnnounceAppData(legacy);
  assert.ok(parsed);
  assert.strictEqual(parsed.displayName, "Dave");
});

test("§4.3 parser tolerates a 2-element array (no capability list)", () => {
  // Historical LXMF emitted [name, stamp_cost]; missing caps default to
  // [SF_COMPRESSION] for backward compatibility (§4.3).
  const legacy = MicroMsgPack.encode([new TextEncoder().encode("Eve"), 4]);
  const parsed = parseAnnounceAppData(legacy);
  assert.ok(parsed);
  assert.strictEqual(parsed.displayName, "Eve");
  assert.strictEqual(parsed.stampCost, 4);
  assert.deepStrictEqual(parsed.supportedFunctions, [SF_COMPRESSION]);
});

test("§4.3 parser tolerates a 1-element array (name only)", () => {
  const legacy = MicroMsgPack.encode([new TextEncoder().encode("Frank")]);
  const parsed = parseAnnounceAppData(legacy);
  assert.ok(parsed);
  assert.strictEqual(parsed.displayName, "Frank");
  assert.strictEqual(parsed.stampCost, null);
  assert.deepStrictEqual(parsed.supportedFunctions, [SF_COMPRESSION]);
});

test("§4.3 parser tolerates the raw UTF-8 'original announce format'", () => {
  const raw = new TextEncoder().encode("Grace");
  const parsed = parseAnnounceAppData(raw);
  assert.ok(parsed);
  assert.strictEqual(parsed.displayName, "Grace");
  assert.strictEqual(parsed.stampCost, null);
});

test("§4.3 parser returns null for empty / absent app_data", () => {
  assert.strictEqual(parseAnnounceAppData(null), null);
  assert.strictEqual(parseAnnounceAppData(undefined), null);
  assert.strictEqual(parseAnnounceAppData(new Uint8Array(0)), null);
});

test("§4.3 stamp_cost=0 round-trips (parser is permissive, §4.3)", () => {
  // Upstream's stamp_cost_from_app_data does not strict-type-check; a 0 is a
  // valid integer and must survive the round-trip even though the producer
  // only emits 1-254.
  const bytes = buildAnnounceAppData("Heidi", 0);
  const parsed = parseAnnounceAppData(bytes);
  assert.ok(parsed);
  assert.strictEqual(parsed.stampCost, 0);
});

test("§4.3 an explicit empty capability list is preserved", () => {
  // A present-but-empty list means the sender signals no supported functions.
  const bytes = buildAnnounceAppData("Ivan", null, []);
  const parsed = parseAnnounceAppData(bytes);
  assert.ok(parsed);
  assert.deepStrictEqual(parsed.supportedFunctions, []);
});
