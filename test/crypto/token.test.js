import assert from "node:assert";
import test from "node:test";
import { MODE, Token } from "../../src/crypto/token.js";

test("Token encryption and decryption", async (t) => {
  const key = await Token.generateKey(MODE.AES_256_CBC);
  const token = new Token(key, MODE.AES_256_CBC);
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const encrypted = await token.encrypt(data);
  assert.notStrictEqual(encrypted, data);
  assert.ok(encrypted.length > data.length);

  const decrypted = await token.decrypt(encrypted);
  assert.deepStrictEqual(decrypted, data);
});

test("Token HMAC verification", async (t) => {
  const key = await Token.generateKey(MODE.AES_128_CBC);
  const token = new Token(key, MODE.AES_128_CBC);
  const data = new Uint8Array([1, 2, 3]);

  const encrypted = await token.encrypt(data);
  assert.ok(await token.verifyHmac(encrypted));

  const tampered = new Uint8Array(encrypted);
  tampered[0] ^= 0xff;
  assert.strictEqual(await token.verifyHmac(tampered), false);
});

test("Token error on invalid key length", async (t) => {
  const invalidKey = new Uint8Array(10);
  assert.throws(
    () => new Token(invalidKey, MODE.AES_128_CBC),
    /Token key must be 32 bytes/,
  );
});

test("Token error on invalid mode", async (t) => {
  const key = await Token.generateKey(MODE.AES_256_CBC);
  assert.throws(() => new Token(key, "INVALID_MODE"), /Invalid token mode/);
});
