import test from "node:test";
import assert from "node:assert/strict";
import { matchesGlob } from "../tools/notes-automation/src/service.js";

test("matches markdown files", () => {
  assert.equal(matchesGlob("notes/today.md", ["**/*.md"]), true);
});

test("ignores workspace state file", () => {
  assert.equal(matchesGlob(".obsidian/workspace.json", [".obsidian/workspace.json"]), true);
});

test("does not match binary patterns for markdown file", () => {
  assert.equal(matchesGlob("notes/today.md", ["**/*.png", "**/*.pdf"]), false);
});
