import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcriptFilePath, writeTranscript } from "../tools/llm-chat-cli/src/transcripts.js";

function pad(value) {
  return String(value).padStart(2, "0");
}

function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("transcriptFilePath uses local date folder and local timestamp filename", () => {
  const now = new Date("2026-05-26T12:34:56.789Z");
  const filePath = transcriptFilePath("/tmp/vault", now);
  const expectedDay = localDay(now);
  assert.equal(filePath.includes(`/AI Chats/${expectedDay}/`), true);
  assert.equal(filePath.endsWith(".md"), true);
  const name = path.basename(filePath);
  assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4}\.md$/);
  assert.equal(name.includes("Z"), false);
});

test("writeTranscript stores created_at as local timestamp with timezone offset", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-transcript-"));
  const filePath = writeTranscript({
    vaultPath: tempDir,
    id: "test-id",
    createdAt: "2026-05-26T12:34:56.789Z",
    gatewayUrl: "http://127.0.0.1:4100",
    model: "smart-router",
    routing: null,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    messages: [{ role: "assistant", content: "hello" }]
  });

  const content = fs.readFileSync(filePath, "utf8");
  const createdAtLine = content
    .split("\n")
    .find((line) => line.startsWith("created_at: "));
  assert.ok(createdAtLine);
  assert.match(createdAtLine, /^created_at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"$/);
  assert.equal(createdAtLine.includes("Z"), false);
});
