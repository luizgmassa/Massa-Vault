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
