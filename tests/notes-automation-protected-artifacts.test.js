import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  isProtectedArtifactPath,
  normalizeRelativePath
} from "../tools/notes-automation/src/domain/protected-artifacts.js";

test("isProtectedArtifactPath: empty path is not protected", () => {
  assert.equal(isProtectedArtifactPath(""), false);
});

test("isProtectedArtifactPath: nested .DS_Store is protected", () => {
  assert.equal(isProtectedArtifactPath("a/b/.DS_Store"), true);
});

test("isProtectedArtifactPath: top-level .DS_Store is protected", () => {
  assert.equal(isProtectedArtifactPath(".DS_Store"), true);
});

test("isProtectedArtifactPath: bare .automation directory (no trailing slash) is protected", () => {
  assert.equal(isProtectedArtifactPath(".automation"), true);
});

test("isProtectedArtifactPath: files under .automation/ are protected", () => {
  assert.equal(isProtectedArtifactPath(".automation/state.json"), true);
});

test("isProtectedArtifactPath: an ordinary vault note is not protected", () => {
  assert.equal(isProtectedArtifactPath("notes/note.md"), false);
});

test("isProtectedArtifactPath: a name merely starting with .automation is not protected", () => {
  assert.equal(isProtectedArtifactPath(".automationX/state.json"), false);
});

// normalizeRelativePath splits on the *current platform's* path.sep, so a literal
// hardcoded "\\" only round-trips on Windows. Build the separator-joined input with
// `path.sep` so this test is meaningful (and passing) on every platform, including
// this repo's CI runner (ubuntu-latest / POSIX).
test("normalizeRelativePath: converts platform separators to posix and strips a leading ./", () => {
  const platformSeparated = ["a", "b", ".DS_Store"].join(path.sep);
  assert.equal(normalizeRelativePath(platformSeparated), "a/b/.DS_Store");
  assert.equal(normalizeRelativePath(`.${path.sep}notes${path.sep}note.md`), "notes/note.md");
});

test("isProtectedArtifactPath: detects a nested .DS_Store expressed with platform separators", () => {
  const platformSeparated = ["a", "b", ".DS_Store"].join(path.sep);
  assert.equal(isProtectedArtifactPath(platformSeparated), true);
});

test("normalizeRelativePath: empty and falsy inputs normalize to an empty string", () => {
  assert.equal(normalizeRelativePath(""), "");
  assert.equal(normalizeRelativePath(undefined), "");
  assert.equal(normalizeRelativePath(null), "");
});
