/**
 * LXMF "paper" messaging — interop with the Python reference.
 *
 * Paper messages are encrypted, out-of-band delivery units: byte-identical to
 * the propagation `lxmf_data` form, but carried as a QR code or an `lxm://`
 * URI instead of over the network (LXMessage.py `pack()` PAPER branch +
 * `as_uri`, LXMRouter.ingest_lxm_uri).
 *
 * Covered:
 *   - URL-safe base64 + `lxm://` URI codec (round-trip & Python parity)
 *   - JS → JS pack/ingest round-trip (Message level)
 *   - Python → JS: a Python-generated `lxm://` URI decrypts & unpacks in JS
 *   - transient_id parity + PAPER_MDU oversize guard
 *   - LXMRouter.ingestUri dispatch + de-duplication
 *   - JS → Python: a JS-generated URI ingests under the Python reference
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Destination } from "../../src/core/destination.js";
import { Identity } from "../../src/core/identity.js";
import { DestType } from "../../src/core/packet.js";
import { PAPER_MDU, URI_SCHEMA } from "../../src/lxmf/constants.js";
import { Message } from "../../src/lxmf/message.js";
import { LXMRouter } from "../../src/lxmf/router.js";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  fromHex,
  toHex,
} from "../../src/utils/encoding.js";

const FIX = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "fixtures", "lxmf_propagation.json"),
    "utf8",
  ),
);

/** Python verifier for the JS→Python direction; skipped if unavailable. */
function pythonAvailable() {
  try {
    execFileSync("python3", ["-c", "import RNS, LXMF"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("paper-message geometry constants", () => {
  test("PAPER_MDU and URI_SCHEMA match the Python reference", () => {
    assert.strictEqual(URI_SCHEMA, "lxm");
    assert.strictEqual(PAPER_MDU, 2210);
  });
});

describe("URL-safe base64 codec", () => {
  test("bytesToBase64Url / base64UrlToBytes round-trip arbitrary bytes", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 62, 63, 64, 65, 250]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const encoded = bytesToBase64Url(bytes);
      // Never contains standard-alphabet chars nor padding.
      assert.ok(!/[+/=]/.test(encoded));
      assert.deepStrictEqual(base64UrlToBytes(encoded), bytes);
    }
  });

  test("base64UrlToBytes tolerates the standard alphabet and missing padding", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255, 0, 127]);
    const urlSafe = bytesToBase64Url(bytes);
    // Translate to the standard alphabet and drop padding; decoder must cope.
    const standard = urlSafe.replace(/-/g, "+").replace(/_/g, "/");
    assert.deepStrictEqual(base64UrlToBytes(standard), bytes);
    assert.deepStrictEqual(base64UrlToBytes(urlSafe), bytes);
  });
});

describe("lxm:// URI codec", () => {
  test("paperDataToUri / paperDataFromUri round-trip", () => {
    const paperData = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const uri = Message.paperDataToUri(paperData);
    assert.strictEqual(uri.slice(0, URI_SCHEMA.length + 3), "lxm://");
    assert.deepStrictEqual(Message.paperDataFromUri(uri), paperData);
  });

  test("paperDataFromUri matches the Python-generated URI byte-for-byte", () => {
    assert.deepStrictEqual(
      Message.paperDataFromUri(FIX.pythonPaper.uri),
      fromHex(FIX.pythonPaper.paperData),
    );
  });

  test("paperDataFromUri rejects non-lxm URIs", () => {
    assert.throws(
      () => Message.paperDataFromUri("https://example.com/x"),
      Error,
    );
    assert.throws(() => Message.paperDataFromUri("LXM:abc"), Error);
    // Case-insensitive scheme is accepted; body still decodes.
    assert.deepStrictEqual(
      Message.paperDataFromUri("LXM://YWJj"),
      new Uint8Array([0x61, 0x62, 0x63]),
    );
  });
});

describe("JS paper round-trip (pack → ingest)", () => {
  test("toPaperUri → fromPaperUri recovers the message and verifies", async () => {
    const recipient = await Identity.generate();
    const source = await Identity.generate();
    const outDest = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient,
      null,
    );
    const inDest = await Destination.IN(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient,
      null,
    );
    const srcOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      source,
      null,
    );

    const msg = new Message({
      destinationHash: outDest.destinationHash,
      sourceHash: srcOut.destinationHash,
      timestamp: 1716000000,
      title: "Paper Round Trip",
      content: "encrypted out of band",
    });
    const { paperData } = await msg.toPaperData(source, outDest);
    const uri = Message.paperDataToUri(paperData);

    const recovered = await Message.fromPaperUri(uri, inDest);
    assert.ok(recovered, "decryption should succeed");
    assert.strictEqual(recovered.title, "Paper Round Trip");
    assert.strictEqual(recovered.content, "encrypted out of band");
    assert.ok(await recovered.verifySignature(source));

    // The decoded bytes match what we packed.
    assert.deepStrictEqual(Message.paperDataFromUri(uri), paperData);
  });
});

describe("Python → JS paper interop", () => {
  const py = FIX.pythonPaper;

  test("fromPaperUri decrypts & unpacks the Python-generated URI", async () => {
    const recipient = await Identity.fromBytes(
      fromHex(FIX.recipientIdentity128),
    );
    const inDest = await Destination.IN(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient,
      null,
    );
    assert.strictEqual(
      toHex(inDest.destinationHash),
      FIX.recipientDestinationHash,
    );

    const msg = await Message.fromPaperUri(py.uri, inDest);
    assert.ok(msg, "the recipient must decrypt its own paper message");
    assert.strictEqual(msg.title, py.title);
    assert.strictEqual(msg.content, py.content);

    // Signature validates against the source identity.
    const source = await Identity.fromBytes(fromHex(FIX.sourceIdentity128));
    assert.ok(await msg.verifySignature(source));
  });

  test("transient_id == SHA-256(paperData) == Python", async () => {
    const transientId = await Message.transientIdFromPropagationData(
      fromHex(py.paperData),
    );
    assert.strictEqual(toHex(transientId), py.transientId);
  });

  test("fromPaperUri returns null for a URI addressed to someone else", async () => {
    const other = await Identity.generate();
    const inDest = await Destination.IN(
      "lxmf.delivery",
      DestType.SINGLE,
      other,
      null,
    );
    const msg = await Message.fromPaperUri(py.uri, inDest);
    assert.strictEqual(msg, null);
  });
});

describe("PAPER_MDU oversize guard", () => {
  test("toPaperData throws when the encrypted payload exceeds PAPER_MDU", async () => {
    const recipient = await Identity.generate();
    const source = await Identity.generate();
    const outDest = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient,
      null,
    );
    const srcOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      source,
      null,
    );

    const msg = new Message({
      destinationHash: outDest.destinationHash,
      sourceHash: srcOut.destinationHash,
      content: "x".repeat(PAPER_MDU + 256),
    });
    await assert.rejects(() => msg.toPaperData(source, outDest), TypeError);
  });
});

describe("LXMRouter.ingestUri", () => {
  test("ingests a paper URI, dispatches a message event, and de-duplicates", async () => {
    /** @type {any} */
    const interfaceLayer = {
      registerDestination: () => {},
      transport: Object.assign(new EventTarget(), {
        bindLocalDestination: () => {},
        addLink: () => {},
        sendPacket: async () => {},
      }),
    };

    const recipientIdentity = await Identity.generate();
    const senderIdentity = await Identity.generate();

    const recipientRouter = new LXMRouter(recipientIdentity, interfaceLayer);
    await recipientRouter.init();
    const senderRouter = new LXMRouter(senderIdentity, interfaceLayer);
    await senderRouter.init();

    // OUT destination the sender encrypts to (only needs the public key).
    const recipientOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      recipientIdentity,
      null,
    );
    // Remember the sender so the recipient can verify the signature.
    const senderSourceHash = senderRouter.deliveryDest.destinationHash;
    await Destination.remember(
      senderIdentity.identityHash,
      senderSourceHash,
      senderIdentity.publicKey,
    );

    const message = new Message({
      sourceHash: senderSourceHash,
      destinationHash: recipientRouter.deliveryDest.destinationHash,
      title: "paper via router",
      content: "ingested out of band!",
    });
    const uri = await message.toPaperUri(senderIdentity, recipientOut);

    /** @type {import("../../src/lxmf/message.js").Message[]} */
    const delivered = [];
    recipientRouter.addEventListener("message", (event) => {
      delivered.push(/** @type {any} */ (event).detail.message);
    });

    const result = await recipientRouter.ingestUri(uri);
    assert.ok(result, "ingestUri resolves to the reconstructed message");
    assert.strictEqual(delivered.length, 1);
    assert.strictEqual(delivered[0].content, "ingested out of band!");
    assert.strictEqual(delivered[0].title, "paper via router");
    assert.ok(await delivered[0].verifySignature(senderIdentity));

    // Re-ingesting the same URI is a no-op (de-duplication by transient_id).
    const second = await recipientRouter.ingestUri(uri);
    assert.strictEqual(second, null);
    assert.strictEqual(delivered.length, 1);
  });

  test("ingestUri returns null for a URI addressed elsewhere", async () => {
    /** @type {any} */
    const interfaceLayer = {
      registerDestination: () => {},
      transport: Object.assign(new EventTarget(), {
        bindLocalDestination: () => {},
        addLink: () => {},
        sendPacket: async () => {},
      }),
    };
    const recipientIdentity = await Identity.generate();
    const router = new LXMRouter(recipientIdentity, interfaceLayer);
    await router.init();

    const result = await router.ingestUri(FIX.pythonPaper.uri);
    assert.strictEqual(result, null);
  });
});

describe("JS → Python paper interop", () => {
  test("a JS-generated paper URI decrypts & unpacks under the Python reference", async () => {
    if (!pythonAvailable()) {
      console.warn(
        "python3/RNS/LXMF not available — skipping JS→Python interop",
      );
      return;
    }
    const recipient = await Identity.fromBytes(
      fromHex(FIX.recipientIdentity128),
    );
    const source = await Identity.fromBytes(fromHex(FIX.sourceIdentity128));
    const outDest = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      recipient,
      null,
    );
    const srcOut = await Destination.OUT(
      "lxmf.delivery",
      DestType.SINGLE,
      source,
      null,
    );

    const msg = new Message({
      destinationHash: outDest.destinationHash,
      sourceHash: srcOut.destinationHash,
      timestamp: 1720500000,
      title: "From JS Paper",
      content: "Python ingests this paper",
    });
    const uri = await msg.toPaperUri(source, outDest);

    const outJson = join(
      tmpdir(),
      `paper-verify-${process.pid}-${Date.now()}.json`,
    );
    execFileSync(
      "python3",
      [
        join(
          import.meta.dirname,
          "..",
          "..",
          "scripts",
          "verify_paper_ingest.py",
        ),
        FIX.recipientIdentity128,
        uri,
        outJson,
      ],
      { stdio: "ignore" },
    );
    const res = JSON.parse(readFileSync(outJson, "utf8"));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.title, "From JS Paper");
    assert.strictEqual(res.content, "Python ingests this paper");
  });
});
