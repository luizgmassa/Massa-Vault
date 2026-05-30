import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  summarizeTranscriptTitle,
  transcriptFilePath,
  writeTranscript
} from "../tools/llm-chat-cli/src/transcripts.js";

function pad(value) {
  return String(value).padStart(2, "0");
}

function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("transcriptFilePath uses local date folder and HH-mm-ss--summary filename", () => {
  const now = new Date("2026-05-26T12:34:56.789Z");
  const filePath = transcriptFilePath("/tmp/vault", now, "alpha-security-checklist");
  const expectedDay = localDay(now);
  assert.equal(filePath.includes(`/AI Chats/${expectedDay}/`), true);
  assert.equal(filePath.endsWith(".md"), true);
  const name = path.basename(filePath);
  assert.match(name, /^\d{2}-\d{2}-\d{2}--alpha-security-checklist\.md$/);
});

test("summarizeTranscriptTitle uses first meaningful user message and fallback chat", () => {
  assert.equal(
    summarizeTranscriptTitle([
      { role: "assistant", content: "hello" },
      { role: "user", content: "What files are in my vault today please help quickly now" }
    ]),
    "what-files-are-in-my-vault-today-please"
  );
  assert.equal(
    summarizeTranscriptTitle([{ role: "assistant", content: "hello" }]),
    "chat"
  );
});

test("writeTranscript stores created_at local offset and filename summary/fallback", () => {
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
  assert.match(path.basename(filePath), /^\d{2}-\d{2}-\d{2}--chat\.md$/);
  const createdAtLine = content
    .split("\n")
    .find((line) => line.startsWith("created_at: "));
  assert.ok(createdAtLine);
  assert.match(createdAtLine, /^created_at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"$/);
  assert.equal(createdAtLine.includes("Z"), false);

  const filePathWithSummary = writeTranscript({
    vaultPath: tempDir,
    id: "test-id-2",
    createdAt: "2026-05-26T12:35:56.789Z",
    gatewayUrl: "http://127.0.0.1:4100",
    model: "smart-router",
    routing: null,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    messages: [{ role: "user", content: "Summarize sync status for git and drive now please" }]
  });
  assert.match(
    path.basename(filePathWithSummary),
    /^\d{2}-\d{2}-\d{2}--summarize-sync-status-for-git-and-drive-now\.md$/
  );
});
