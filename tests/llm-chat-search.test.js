import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSearchIndex, searchIndex } from "../tools/llm-chat-cli/src/search.js";

function vectorForText(text) {
  const value = String(text || "").toLowerCase();
  return [
    value.includes("alpha") ? 1 : 0,
    value.includes("beta") ? 1 : 0,
    value.includes("gamma") ? 1 : 0
  ];
}

test("semantic search indexes markdown files and ranks query matches", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-search-"));
  const previousCwd = process.cwd();
  process.chdir(tempRoot);

  const vaultPath = path.join(tempRoot, "vault");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "one.md"), "# Note One\nalpha alpha context", "utf8");
  fs.writeFileSync(path.join(vaultPath, "two.md"), "# Note Two\nbeta context", "utf8");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const embeddings = inputs.map(vectorForText);
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const first = await ensureSearchIndex({
      vaultPath,
      ignoreGlobs: [],
      baseUrl: "http://127.0.0.1:11434",
      model: "embeddinggemma"
    });
    assert.equal(first.rebuilt, true);

    const second = await ensureSearchIndex({
      vaultPath,
      ignoreGlobs: [],
      baseUrl: "http://127.0.0.1:11434",
      model: "embeddinggemma"
    });
    assert.equal(second.rebuilt, false);

    const results = await searchIndex({
      indexData: second.index,
      query: "alpha",
      baseUrl: "http://127.0.0.1:11434",
      model: "embeddinggemma",
      limit: 3
    });
    assert.equal(results.length > 0, true);
    assert.equal(results[0].filePath, "one.md");

    fs.appendFileSync(path.join(vaultPath, "two.md"), "\nalpha also appears now", "utf8");
    const third = await ensureSearchIndex({
      vaultPath,
      ignoreGlobs: [],
      baseUrl: "http://127.0.0.1:11434",
      model: "embeddinggemma"
    });
    assert.equal(third.rebuilt, true);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(previousCwd);
  }
});

test("ensureSearchIndex includeGlobs scopes index to transcript folder", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-search-scope-"));
  const previousCwd = process.cwd();
  process.chdir(tempRoot);

  const vaultPath = path.join(tempRoot, "vault");
  fs.mkdirSync(path.join(vaultPath, "AI Chats", "2026-05-30"), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "Notes.md"), "# note\nalpha from regular note", "utf8");
  fs.writeFileSync(
    path.join(vaultPath, "AI Chats", "2026-05-30", "10-00-00--chat.md"),
    "# chat\nalpha from chat transcript",
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const embeddings = inputs.map(vectorForText);
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const scoped = await ensureSearchIndex({
      vaultPath,
      ignoreGlobs: [],
      includeGlobs: ["AI Chats/**/*.md"],
      baseUrl: "http://127.0.0.1:11434",
      model: "embeddinggemma"
    });

    const indexedFiles = new Set(scoped.index.items.map((item) => item.relativePath));
    assert.equal(indexedFiles.has("Notes.md"), false);
    assert.equal(indexedFiles.has("AI Chats/2026-05-30/10-00-00--chat.md"), true);

    const results = await searchIndex({
      indexData: scoped.index,
      query: "alpha",
      baseUrl: "http://127.0.0.1:11434",
      model: "embeddinggemma",
      limit: 5
    });
    assert.equal(results.every((entry) => entry.filePath.startsWith("AI Chats/")), true);
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(previousCwd);
  }
});
