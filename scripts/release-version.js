#!/usr/bin/env node
/**
 * release-version.js
 *
 * Derives the next release version from the `[Unreleased]` section of CHANGELOG.md
 * and promotes that section under a dated heading.
 *
 * Ported from massa-ai's scripts/release-version.ts. This repo is a single package
 * with no workspaces, so there is no version-sync step: only the root package.json
 * is rewritten.
 *
 * Bump rules:
 *   ### Added | Changed | Removed | Deprecated  -> minor
 *   ### Fixed | Security                        -> patch
 *   nothing with content                        -> null (no release)
 *
 * The major component is never incremented automatically.
 *
 * Usage:
 *   node scripts/release-version.js --dry-run   # derive only, write nothing
 *   node scripts/release-version.js             # derive and write
 *
 * Emits a single JSON object on stdout; all diagnostics go to stderr, so callers can
 * parse stdout directly from a workflow step.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Headings that mean "feature / improvement / refactor" -> bump Y. */
const MINOR_HEADINGS = new Set(["added", "changed", "removed", "deprecated"]);
/** Headings that mean "bug / security" -> bump Z. */
const PATCH_HEADINGS = new Set(["fixed", "security"]);

const UNRELEASED_RE = /^##\s+\[Unreleased\]/i;
const ANY_SECTION_RE = /^##\s+\[/;

/** UTC `YYYY-MM-DD`, matching the `## [1.1.0] - 2026-08-01` format. */
export function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

/** Index of the `## [Unreleased]` line and of the next `## [` line (exclusive). */
function unreleasedBounds(lines) {
  const start = lines.findIndex((line) => UNRELEASED_RE.test(line));
  if (start === -1) {
    throw new Error(
      "release-version: CHANGELOG.md has no `## [Unreleased]` heading - refusing to guess a version"
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (ANY_SECTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Slice CHANGELOG.md from `## [Unreleased]` (exclusive) to the next `## [` (exclusive). */
export function extractUnreleased(changelog) {
  const lines = changelog.split("\n");
  const { start, end } = unreleasedBounds(lines);
  return lines.slice(start + 1, end).join("\n");
}

/**
 * `### Heading` names (lowercased, deduped) that hold at least one non-blank content
 * line. An empty heading must not force a bump, so it is dropped here.
 */
export function unreleasedHeadings(section) {
  const found = new Set();
  let current = null;
  let hasContent = false;

  const flush = () => {
    if (current !== null && hasContent) found.add(current);
  };

  for (const line of section.split("\n")) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].toLowerCase();
      hasContent = false;
      continue;
    }
    if (current !== null && line.trim() !== "") hasContent = true;
  }
  flush();

  return [...found];
}

/** minor-class wins over patch-class; no qualifying heading yields null. */
export function decideBump(headings) {
  if (headings.some((heading) => MINOR_HEADINGS.has(heading))) return "minor";
  if (headings.some((heading) => PATCH_HEADINGS.has(heading))) return "patch";
  return null;
}

/** Never touches the major component. Throws on a non-semver input. */
export function nextVersion(current, bump) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current).trim());
  if (!parsed) {
    throw new Error(
      `release-version: root version is not X.Y.Z semver: ${JSON.stringify(current)}`
    );
  }
  const [major, minor, patch] = parsed.slice(1, 4).map(Number);
  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** The `[Unreleased]` body with surrounding blank lines stripped - the release notes. */
export function unreleasedNotes(changelog) {
  return extractUnreleased(changelog).replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * Insert a fresh empty `## [Unreleased]` and promote the previous body under
 * `## [version] - date`, leaving every other section untouched.
 */
export function promoteChangelog(changelog, version, isoDate) {
  const lines = changelog.split("\n");
  const { start, end } = unreleasedBounds(lines);
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  return [
    ...lines.slice(0, start),
    "## [Unreleased]",
    "",
    `## [${version}] - ${isoDate}`,
    "",
    body,
    "",
    ...lines.slice(end)
  ].join("\n");
}

/**
 * Derive and (unless `dryRun`) apply the release: bump the root version and promote
 * the changelog section.
 */
export function deriveRelease(rootDir, opts = {}) {
  const rootPkgPath = path.join(rootDir, "package.json");
  const changelogPath = path.join(rootDir, "CHANGELOG.md");

  const rootPkgRaw = fs.readFileSync(rootPkgPath, "utf8");
  const current = JSON.parse(rootPkgRaw).version;
  const changelog = fs.readFileSync(changelogPath, "utf8");

  const bump = decideBump(unreleasedHeadings(extractUnreleased(changelog)));
  if (bump === null) {
    return { current, next: null, bump: null, notes: "" };
  }

  const next = nextVersion(current, bump);
  const notes = unreleasedNotes(changelog);
  if (opts.dryRun) return { current, next, bump, notes };

  // Replace only the first `"version": "..."` - the manifest's own field - so the diff
  // stays one line regardless of how the file happens to be formatted.
  fs.writeFileSync(
    rootPkgPath,
    rootPkgRaw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`)
  );

  fs.writeFileSync(
    changelogPath,
    promoteChangelog(changelog, next, opts.today ?? utcToday())
  );

  return { current, next, bump, notes };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = deriveRelease(rootDir, {
      dryRun: process.argv.includes("--dry-run")
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
