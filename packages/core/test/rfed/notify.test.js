/**
 * rfed notify primitives (work doc #25, Phase 5).
 *
 * Unit-tests the relay-hash validator, the §9.3 wake-packet codec, the notify
 * command parser, and the `NotifyRegistry` against Rust `rfed::notify`
 * semantics. End-to-end wake dispatch (register → deferred publish → relay
 * receives wake) is covered in `node.test.js`.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import { MicroMsgPack } from "../../src/utils/msgpack.js";
import { fromHex, toHex } from "../../src/utils/encoding.js";
import {
  NotifyRegistry,
  encodeWakePayload,
  parseNotifyCommand,
  validateRelayHash,
  NOTIFY_CLEAR,
  NOTIFY_REGISTER,
  NOTIFY_UNREGISTER,
} from "../../src/rfed/notify.js";

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const HEX32 = () => toHex(rnd(16));

describe("rfed notify — relay hash validation", () => {
  test("accepts a 32-char lowercase hex hash", () => {
    assert.strictEqual(validateRelayHash("aabbccdd11223344aabbccdd11223344"), null);
  });
  test("rejects wrong length", () => {
    assert.ok(validateRelayHash("aabb"));
    assert.ok(validateRelayHash("aabbccdd11223344aabbccdd1122334")); // 31 chars
  });
  test("rejects uppercase / non-hex", () => {
    assert.ok(validateRelayHash("AABBCCDD11223344AABBCCDD11223344"));
    assert.ok(validateRelayHash("zzbbccdd11223344aabbccdd1122334z"));
  });
});

describe("rfed notify — §9.3 wake-packet codec", () => {
  test("channel fanout wake: receiver + channel, no sender", () => {
    const receiver = rnd(16);
    const channel = rnd(16);
    const payload = encodeWakePayload({ receiver, channel });
    const map = MicroMsgPack.decode(payload);
    assert.deepStrictEqual(toHex(map.receiver), toHex(receiver));
    assert.deepStrictEqual(toHex(map.channel), toHex(channel));
    assert.strictEqual(map.sender, undefined);
  });

  test("LXMF wake: receiver + sender, no channel", () => {
    const receiver = rnd(16);
    const sender = rnd(16);
    const payload = encodeWakePayload({ receiver, sender });
    const map = MicroMsgPack.decode(payload);
    assert.deepStrictEqual(toHex(map.receiver), toHex(receiver));
    assert.deepStrictEqual(toHex(map.sender), toHex(sender));
    assert.strictEqual(map.channel, undefined);
  });

  test("minimal wake: receiver only", () => {
    const receiver = rnd(16);
    const map = MicroMsgPack.decode(encodeWakePayload({ receiver }));
    assert.deepStrictEqual(toHex(map.receiver), toHex(receiver));
    assert.strictEqual(map.sender, undefined);
    assert.strictEqual(map.channel, undefined);
  });
});

describe("rfed notify — command parsing", () => {
  test("modern register command", () => {
    const relay = HEX32();
    const ch = rnd(16);
    const value = MicroMsgPack.encode(["register", relay, ch]);
    const cmd = parseNotifyCommand(value, NOTIFY_REGISTER);
    assert.strictEqual(cmd.kind, "register");
    assert.strictEqual(cmd.relayHash, relay);
    assert.deepStrictEqual(toHex(cmd.channelHash), toHex(ch));
  });

  test("global register (no channel) → channelHash null", () => {
    const relay = HEX32();
    const value = MicroMsgPack.encode(["register", relay, null]);
    const cmd = parseNotifyCommand(value, NOTIFY_REGISTER);
    assert.strictEqual(cmd.kind, "register");
    assert.strictEqual(cmd.relayHash, relay);
    assert.strictEqual(cmd.channelHash, null);
  });

  test("clear with empty value → clear kind", () => {
    const cmd = parseNotifyCommand(new Uint8Array(0), NOTIFY_CLEAR);
    assert.strictEqual(cmd.kind, "clear");
    assert.strictEqual(cmd.relayHash, null);
    assert.strictEqual(cmd.channelHash, null);
  });

  test("legacy 2-array form uses the path's default kind", () => {
    const relay = HEX32();
    const ch = rnd(16);
    const value = MicroMsgPack.encode([relay, ch]);
    const cmd = parseNotifyCommand(value, NOTIFY_REGISTER);
    assert.strictEqual(cmd.kind, "register");
    assert.strictEqual(cmd.relayHash, relay);
    assert.deepStrictEqual(toHex(cmd.channelHash), toHex(ch));
  });

  test("op mismatch with the path's default kind throws", () => {
    const relay = HEX32();
    const value = MicroMsgPack.encode(["register", relay, null]);
    assert.throws(() => parseNotifyCommand(value, NOTIFY_UNREGISTER), /op mismatch/);
  });
});

describe("rfed notify — NotifyRegistry", () => {
  test("register/unregister/clear by (subscriber, channel, relay)", () => {
    const reg = new NotifyRegistry();
    const sub = rnd(16);
    const ch = rnd(16);
    const relayA = HEX32();
    const relayB = HEX32();

    reg.register(sub, ch, relayA);
    reg.register(sub, ch, relayB);
    assert.strictEqual(reg.getForSubscriber(sub, ch).length, 2);

    // Re-registering the same triple refreshes (no duplicate).
    reg.register(sub, ch, relayA);
    assert.strictEqual(reg.getForSubscriber(sub, ch).length, 2);

    reg.unregister(sub, ch, relayA);
    assert.strictEqual(reg.getForSubscriber(sub, ch).length, 1);

    reg.clear(sub);
    assert.strictEqual(reg.getForSubscriber(sub, ch).length, 0);
  });

  test("channel-scoped vs global (LXMF) registrations are distinct", () => {
    const reg = new NotifyRegistry();
    const sub = rnd(16);
    const ch = rnd(16);
    const relay = HEX32();
    reg.register(sub, ch, relay); // channel-scoped
    reg.register(sub, null, relay); // global/LXMF
    assert.strictEqual(reg.getForSubscriber(sub, ch).length, 1);
    assert.strictEqual(reg.getForSubscriber(sub, null).length, 1);
  });
});
