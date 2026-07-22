import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCompiledSection,
  compileChangelog,
  emitDoc,
  parseCategories,
  parseDoc,
  stampPackage,
} from "./compile-changelog.mjs";

const DATE = "2026-07-30";
const VER = "0.4.0";

test("parseDoc / emitDoc round-trip with blank-line normalization", () => {
  const text =
    "# Changelog\n## [Unreleased]\n### Added\n- a\n\n## [0.3.0] - 2026-01-01\n### Added\n- old\n";
  const doc = parseDoc(text);
  assert.equal(doc.title.join("\n"), "# Changelog");
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].header, "## [Unreleased]");
  assert.deepEqual(doc.sections[0].body, ["### Added", "- a"]);
  // Re-emitting normalizes to single blank lines between sections + title.
  const expected =
    "# Changelog\n\n## [Unreleased]\n### Added\n- a\n\n## [0.3.0] - 2026-01-01\n### Added\n- old\n";
  assert.equal(emitDoc(doc), expected);
});

test("parseCategories splits categories and keeps entry sub-lines, drops blanks", () => {
  const body = [
    "### Added",
    "- Feature Y",
    "  - subdetail",
    "- Feature Z",
    "",
    "### Changed (breaking)",
    "- Break X",
  ];
  const cats = parseCategories(body);
  assert.equal(cats.length, 2);
  assert.equal(cats[0].name, "Added");
  assert.deepEqual(cats[0].entries, [
    ["- Feature Y", "  - subdetail"],
    ["- Feature Z"],
  ]);
  assert.equal(cats[1].name, "Changed (breaking)");
  assert.deepEqual(cats[1].entries, [["- Break X"]]);
});

test("stampPackage stamps [Unreleased] and opens a fresh one", () => {
  const text = "# Changelog\n## [Unreleased]\n### Added\n- a\n";
  const out = stampPackage(text, VER, DATE);
  assert.equal(
    out,
    "# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-07-30\n### Added\n- a\n",
  );
});

test("stampPackage returns null when there is no [Unreleased] (gap package)", () => {
  const text = "# Changelog\n\n## [0.3.0] - 2026-01-01\n### Added\n- old\n";
  assert.equal(stampPackage(text, VER, DATE), null);
});

test("buildCompiledSection merges packages, breaking-first, prefixed", () => {
  const perPkg = [
    {
      pkg: "reticulum-js",
      cats: [
        {
          name: "Added",
          entries: [["- Feature Y", "  - subdetail"], ["- Feature Z"]],
        },
        { name: "Changed (breaking)", entries: [["- Break X"]] },
      ],
    },
    {
      pkg: "reticulum-js-node",
      cats: [{ name: "Added", entries: [["- New package thing"]] }],
    },
  ];
  assert.equal(
    buildCompiledSection(VER, DATE, perPkg),
    [
      "## [0.4.0] - 2026-07-30",
      "### Changed (breaking)",
      "- **reticulum-js**: Break X",
      "### Added",
      "- **reticulum-js**: Feature Y",
      "  - subdetail",
      "- **reticulum-js**: Feature Z",
      "- **reticulum-js-node**: New package thing",
    ].join("\n"),
  );
});

test("compileChangelog end-to-end: stamps, skips gaps, writes root", () => {
  const root = mkdtempSync(join(tmpdir(), "rjs-cl-"));
  try {
    mkdirSync(join(root, "packages"), { recursive: true });
    const coreDir = join(root, "packages", "reticulum-js");
    const nodeDir = join(root, "packages", "reticulum-js-node");
    const webrtcDir = join(root, "packages", "reticulum-js-webrtc-node");
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    mkdirSync(webrtcDir, { recursive: true });

    const coreOrig =
      "# Changelog\n## [Unreleased]\n### Changed (breaking)\n- Break X\n### Added\n- Feature Y\n  - subdetail\n- Feature Z\n\n## [0.3.0] - 2026-01-01\n### Added\n- Old thing\n";
    const nodeOrig =
      "# Changelog\n\n## [Unreleased]\n### Added\n- New package thing\n";
    // webrtc has NO [Unreleased] — must be skipped, leaving a version gap.
    const webrtcOrig =
      "# Changelog\n\n## [0.3.0] - 2026-01-01\n### Added\n- preexisting\n";
    writeFileSync(join(coreDir, "CHANGELOG.md"), coreOrig);
    writeFileSync(join(nodeDir, "CHANGELOG.md"), nodeOrig);
    writeFileSync(join(webrtcDir, "CHANGELOG.md"), webrtcOrig);

    const res = compileChangelog({
      version: VER,
      date: DATE,
      root,
      dryRun: false,
      log: () => {},
    });

    assert.deepEqual(res.stamped, ["reticulum-js", "reticulum-js-node"]);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].pkg, "reticulum-js-webrtc-node");

    // Gap package is untouched.
    assert.equal(
      readFileSync(join(webrtcDir, "CHANGELOG.md"), "utf8"),
      webrtcOrig,
    );

    // Core is stamped: fresh [Unreleased] on top, old one -> [0.4.0].
    assert.equal(
      readFileSync(join(coreDir, "CHANGELOG.md"), "utf8"),
      "# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-07-30\n### Changed (breaking)\n- Break X\n### Added\n- Feature Y\n  - subdetail\n- Feature Z\n\n## [0.3.0] - 2026-01-01\n### Added\n- Old thing\n",
    );

    // Root is created with the compiled [0.4.0] section only (no old history).
    assert.equal(
      readFileSync(join(root, "CHANGELOG.md"), "utf8"),
      "# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-07-30\n### Changed (breaking)\n- **reticulum-js**: Break X\n### Added\n- **reticulum-js**: Feature Y\n  - subdetail\n- **reticulum-js**: Feature Z\n- **reticulum-js-node**: New package thing\n",
    );

    // Re-running for the same version is rejected (no duplicate sections).
    assert.throws(
      () =>
        compileChangelog({
          version: VER,
          date: DATE,
          root,
          dryRun: false,
          log: () => {},
        }),
      /already present/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
