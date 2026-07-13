import assert from "node:assert";
import { test } from "node:test";
import * as C from "../../src/lxmf/constants.js";

test("LXMF constants match upstream LXMF/LXMF.py (§5.9)", () => {
  // Top-level fields dict keys (§5.9.1)
  assert.strictEqual(C.APP_NAME, "lxmf");
  assert.strictEqual(C.FIELD_EMBEDDED_LXMS, 0x01);
  assert.strictEqual(C.FIELD_TELEMETRY, 0x02);
  assert.strictEqual(C.FIELD_TELEMETRY_STREAM, 0x03);
  assert.strictEqual(C.FIELD_ICON_APPEARANCE, 0x04);
  assert.strictEqual(C.FIELD_FILE_ATTACHMENTS, 0x05);
  assert.strictEqual(C.FIELD_IMAGE, 0x06);
  assert.strictEqual(C.FIELD_AUDIO, 0x07);
  assert.strictEqual(C.FIELD_THREAD, 0x08);
  assert.strictEqual(C.FIELD_COMMANDS, 0x09);
  assert.strictEqual(C.FIELD_RESULTS, 0x0a);
  assert.strictEqual(C.FIELD_GROUP, 0x0b);
  assert.strictEqual(C.FIELD_TICKET, 0x0c);
  assert.strictEqual(C.FIELD_EVENT, 0x0d);
  assert.strictEqual(C.FIELD_RNR_REFS, 0x0e);
  assert.strictEqual(C.FIELD_RENDERER, 0x0f);
  assert.strictEqual(C.FIELD_REPLY_TO, 0x30);
  assert.strictEqual(C.FIELD_REPLY_QUOTE, 0x31);
  assert.strictEqual(C.FIELD_REACTION, 0x40);
  assert.strictEqual(C.FIELD_COMMENT, 0x41);
  assert.strictEqual(C.FIELD_CONTINUATION, 0x42);
  assert.strictEqual(C.FIELD_CUSTOM_TYPE, 0xfb);
  assert.strictEqual(C.FIELD_CUSTOM_DATA, 0xfc);
  assert.strictEqual(C.FIELD_CUSTOM_META, 0xfd);
  assert.strictEqual(C.FIELD_NON_SPECIFIC, 0xfe);
  assert.strictEqual(C.FIELD_DEBUG, 0xff);

  // Audio modes (§5.9.3)
  assert.strictEqual(C.AM_CODEC2_450PWB, 0x01);
  assert.strictEqual(C.AM_CODEC2_3200, 0x09);
  assert.strictEqual(C.AM_OPUS_OGG, 0x10);
  assert.strictEqual(C.AM_OPUS_LOSSLESS, 0x19);
  assert.strictEqual(C.AM_CUSTOM, 0xff);

  // Renderers (§5.9.4)
  assert.strictEqual(C.RENDERER_PLAIN, 0x00);
  assert.strictEqual(C.RENDERER_MICRON, 0x01);
  assert.strictEqual(C.RENDERER_MARKDOWN, 0x02);
  assert.strictEqual(C.RENDERER_BBCODE, 0x03);

  // Reaction / comment / continuation dict indices
  assert.strictEqual(C.REACTION_TO, 0x00);
  assert.strictEqual(C.REACTION_CONTENT, 0x01);
  assert.strictEqual(C.COMMENT_FOR, 0x00);
  assert.strictEqual(C.CONTINUATION_OF, 0x00);

  // Propagation-node metadata keys (§5.9.5)
  assert.strictEqual(C.PN_META_VERSION, 0x00);
  assert.strictEqual(C.PN_META_NAME, 0x01);
  assert.strictEqual(C.PN_META_CUSTOM, 0xff);

  // Functionality signalling (§5.9.6)
  assert.strictEqual(C.SF_COMPRESSION, 0x00);
});
