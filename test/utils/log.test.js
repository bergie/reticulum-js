import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
  getLogLevel,
  LogLevel,
  log,
  parseLogLevel,
  setLogLevel,
} from "../../src/utils/log.js";

describe("log level parsing", () => {
  it("accepts level names case-insensitively", () => {
    assert.equal(parseLogLevel("debug"), LogLevel.DEBUG);
    assert.equal(parseLogLevel("NOTICE"), LogLevel.NOTICE);
    assert.equal(parseLogLevel("Warning"), LogLevel.WARNING);
  });

  it("accepts numeric levels in the Python-aligned scheme", () => {
    assert.equal(parseLogLevel(0), LogLevel.CRITICAL);
    assert.equal(parseLogLevel("6"), LogLevel.DEBUG);
    assert.equal(parseLogLevel(8), LogLevel.EXTREME);
  });

  it("clamps out-of-range numbers to [CRITICAL, EXTREME] like Python", () => {
    assert.equal(parseLogLevel(-5), LogLevel.CRITICAL);
    assert.equal(parseLogLevel(99), LogLevel.EXTREME);
  });

  it("falls back for empty / unknown input", () => {
    assert.equal(parseLogLevel(undefined), LogLevel.NOTICE);
    assert.equal(parseLogLevel(""), LogLevel.NOTICE);
    assert.equal(parseLogLevel("nope"), LogLevel.NOTICE);
    assert.equal(parseLogLevel("nope", LogLevel.ERROR), LogLevel.ERROR);
  });

  it("aligns with the Python RNS.LOG_* enum", () => {
    assert.equal(LogLevel.NONE, -1);
    assert.equal(LogLevel.CRITICAL, 0);
    assert.equal(LogLevel.ERROR, 1);
    assert.equal(LogLevel.WARNING, 2);
    assert.equal(LogLevel.NOTICE, 3);
    assert.equal(LogLevel.INFO, 4);
    assert.equal(LogLevel.VERBOSE, 5);
    assert.equal(LogLevel.DEBUG, 6);
    assert.equal(LogLevel.PATHING, 7);
    assert.equal(LogLevel.EXTREME, 8);
    // DEBUG must be more verbose than VERBOSE (this was previously inverted).
    assert.ok(LogLevel.DEBUG > LogLevel.VERBOSE);
  });
});

describe("setLogLevel / getLogLevel", () => {
  const original = getLogLevel();
  beforeEach(() => {
    // Restore after each case so test ordering doesn't matter.
    setLogLevel(original);
  });

  it("sets the threshold from a name and a number", () => {
    setLogLevel("VERBOSE");
    assert.equal(getLogLevel(), LogLevel.VERBOSE);
    setLogLevel(LogLevel.ERROR);
    assert.equal(getLogLevel(), LogLevel.ERROR);
  });

  it("ignores unknown values (keeps the previous level)", () => {
    setLogLevel(LogLevel.DEBUG);
    setLogLevel("bogus");
    assert.equal(getLogLevel(), LogLevel.DEBUG);
  });
});

describe("log filtering", () => {
  const original = getLogLevel();
  const originalLog = console.log;
  let printed = [];

  beforeEach(() => {
    printed = [];
    console.log = (...args) => printed.push(args.join(" "));
  });

  it("prints messages at or below the threshold", () => {
    setLogLevel(LogLevel.NOTICE);
    log("Mod", "a notice", LogLevel.NOTICE);
    log("Mod", "an error", LogLevel.ERROR);
    assert.equal(printed.length, 2);
  });

  it("drops messages above the threshold", () => {
    setLogLevel(LogLevel.NOTICE);
    log("Mod", "hidden debug", LogLevel.DEBUG);
    log("Mod", "bare default call");
    assert.equal(printed.length, 0);
  });

  // Restore globals after the describe block runs.
  it("restores globals", () => {
    console.log = originalLog;
    setLogLevel(original);
    assert.equal(console.log, originalLog);
  });
});

describe("Reticulum({ logLevel }) wiring", () => {
  const original = getLogLevel();
  beforeEach(() => setLogLevel(original));

  it("constructor option overrides the current threshold", async () => {
    setLogLevel(LogLevel.EXTREME);
    const { Reticulum } = await import("../../src/core/reticulum.js");
    // eslint-disable-next-line no-new
    new Reticulum({ logLevel: "ERROR" });
    assert.equal(getLogLevel(), LogLevel.ERROR);
  });
});
