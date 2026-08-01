import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideBump,
  deriveRelease,
  nextVersion,
  promoteChangelog,
  unreleasedHeadings,
  unreleasedNotes
} from "../scripts/release-version.js";

function withTempDir(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-version-"));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedRepo(dir, { version = "1.1.0", changelog }) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }, null, 2));
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
}

test("decideBump prefers minor when both minor- and patch-class headings have content", () => {
  assert.equal(decideBump(["fixed", "added"]), "minor");
  assert.equal(decideBump(["security", "changed"]), "minor");
});

test("decideBump returns patch for patch-only headings", () => {
  assert.equal(decideBump(["fixed"]), "patch");
  assert.equal(decideBump(["security"]), "patch");
});

test("decideBump returns null when no heading qualifies", () => {
  assert.equal(decideBump([]), null);
  assert.equal(decideBump(["notes"]), null);
});

test("unreleasedHeadings ignores a heading with no content lines", () => {
  assert.deepEqual(unreleasedHeadings("\n### Added\n\n### Fixed\n- did a fix\n"), ["fixed"]);
});

test("unreleasedHeadings lowercases and dedupes heading names", () => {
  assert.deepEqual(unreleasedHeadings("\n### Added\n- one\n\n### added\n- two\n"), ["added"]);
});

test("nextVersion minor bump increments minor and resets patch", () => {
  assert.equal(nextVersion("1.9.9", "minor"), "1.10.0");
  assert.equal(nextVersion("4.0.0", "minor"), "4.1.0");
});

test("nextVersion patch bump increments patch only", () => {
  assert.equal(nextVersion("1.9.9", "patch"), "1.9.10");
});

test("nextVersion never increments the major component", () => {
  assert.equal(nextVersion("2.999.999", "patch"), "2.999.1000");
  assert.equal(nextVersion("2.999.999", "minor"), "2.1000.0");
});

test("nextVersion throws on a non-semver current version", () => {
  assert.throws(() => nextVersion("v1.2", "patch"), /not X\.Y\.Z semver/);
});

test("unreleasedNotes strips only the surrounding blank lines", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- a thing",
    "",
    "## [1.1.0] - 2026-01-01",
    "",
    "old"
  ].join("\n");
  assert.equal(unreleasedNotes(changelog), "### Added\n\n- a thing");
});

test("promoteChangelog inserts a fresh Unreleased and dates the promoted body", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- a thing",
    "",
    "## [1.1.0] - 2026-01-01",
    "",
    "old"
  ].join("\n");
  const promoted = promoteChangelog(changelog, "1.2.0", "2026-08-01");
  assert.match(promoted, /## \[Unreleased\]\n\n## \[1\.2\.0\] - 2026-08-01/);
  assert.match(promoted, /### Added\n\n- a thing/);
  assert.match(promoted, /## \[1\.1\.0\] - 2026-01-01\n\nold/);
});

test("promoteChangelog throws when there is no Unreleased heading", () => {
  assert.throws(
    () => promoteChangelog("# Changelog\n\nnothing here\n", "1.2.0", "2026-08-01"),
    /no `## \[Unreleased\]` heading/
  );
});

test("deriveRelease writes nothing and returns a null version when nothing is releasable", () => {
  withTempDir((dir) => {
    const changelog =
      "# Changelog\n\n## [Unreleased]\n\nJust prose, no heading.\n\n## [1.1.0] - 2026-01-01\n\nold\n";
    seedRepo(dir, { changelog });
    const before = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");

    const result = deriveRelease(dir, { today: "2026-08-01" });

    assert.deepEqual(result, { current: "1.1.0", next: null, bump: null, notes: "" });
    assert.equal(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), before);
  });
});

test("deriveRelease dry run derives a version without writing either file", () => {
  withTempDir((dir) => {
    const changelog =
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- a thing\n\n## [1.1.0] - 2026-01-01\n\nold\n";
    seedRepo(dir, { changelog });
    const pkgBefore = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    const changelogBefore = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");

    const result = deriveRelease(dir, { dryRun: true, today: "2026-08-01" });

    assert.equal(result.next, "1.2.0");
    assert.equal(result.bump, "minor");
    assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkgBefore);
    assert.equal(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), changelogBefore);
  });
});

test("deriveRelease bumps package.json and promotes CHANGELOG.md on a real run", () => {
  withTempDir((dir) => {
    const changelog =
      "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- a bug\n\n## [1.1.0] - 2026-01-01\n\nold\n";
    seedRepo(dir, { changelog });

    const result = deriveRelease(dir, { today: "2026-08-01" });

    assert.equal(result.next, "1.1.1");
    assert.equal(result.bump, "patch");
    assert.equal(result.notes, "### Fixed\n\n- a bug");

    const pkgAfter = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkgAfter.version, "1.1.1");
    assert.match(
      fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
      /## \[Unreleased\]\n\n## \[1\.1\.1\] - 2026-08-01\n\n### Fixed\n\n- a bug/
    );
  });
});
