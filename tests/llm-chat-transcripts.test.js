import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listTranscriptDates,
  listTranscriptsForDate,
  parseTranscriptMarkdown,
  readTranscript,
  summarizeTranscriptTitle,
  transcriptFilePath,
  writeTranscript
} from "../tools/llm-chat-cli/src/infrastructure/transcripts.js";

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

test("writeTranscript stores optional concrete routing and MMT metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-transcript-routing-"));
  const filePath = writeTranscript({
    vaultPath: tempDir,
    id: "routing-id",
    createdAt: "2026-05-26T12:34:56.789Z",
    gatewayUrl: "http://127.0.0.1:4100",
    model: "smart-router",
    routing: {
      lane: "general",
      targetModel: "smart-router-general",
      confidence: "1.0000",
      routedModel: "mmt_ollama_qwen3_5_9b",
      providerModel: "ollama_chat/qwen3.5:9b",
      displayModel: "qwen3.5:9b",
      modelLocation: "local",
      modelManagerId: "ollama",
      modelManagerTool: "ollama"
    },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    messages: [{ role: "user", content: "hello" }]
  });

  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /router_routed_model: "mmt_ollama_qwen3_5_9b"/);
  assert.match(content, /router_model_manager_id: "ollama"/);
  assert.match(content, /router_model_manager_tool: "ollama"/);
  const parsed = readTranscript(filePath);
  assert.equal(parsed.metadata.router_model_manager_tool, "ollama");
});

test("listTranscriptDates and listTranscriptsForDate are newest-first", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-transcript-list-"));
  const chatsDir = path.join(tempDir, "AI Chats");
  fs.mkdirSync(path.join(chatsDir, "2026-05-29"), { recursive: true });
  fs.mkdirSync(path.join(chatsDir, "2026-05-30"), { recursive: true });
  fs.mkdirSync(path.join(chatsDir, "invalid-date"), { recursive: true });

  fs.writeFileSync(
    path.join(chatsDir, "2026-05-30", "10-00-00--alpha.md"),
    "---\nid: \"a\"\n---\n\n## USER\nhi\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(chatsDir, "2026-05-30", "12-30-00--beta.md"),
    "---\nid: \"b\"\n---\n\n## USER\nhello\n",
    "utf8"
  );
  fs.writeFileSync(path.join(chatsDir, "2026-05-29", "09-00-00--older.md"), "## USER\nx\n", "utf8");

  const dates = listTranscriptDates(tempDir);
  assert.deepEqual(dates, ["2026-05-30", "2026-05-29"]);

  const rows = listTranscriptsForDate(tempDir, "2026-05-30");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fileName, "12-30-00--beta.md");
  assert.equal(rows[1].fileName, "10-00-00--alpha.md");
  assert.equal(rows[0].time, "12:30:00");
  assert.match(rows[0].relativePath, /^AI Chats\/2026-05-30\/12-30-00--beta\.md$/);
});

test("parseTranscriptMarkdown and readTranscript map USER/ASSISTANT/SYSTEM sections", () => {
  const markdown = [
    "---",
    "id: \"session-1\"",
    "created_at: \"2026-05-30T12:00:00-03:00\"",
    "prompt_tokens: 4",
    "---",
    "",
    "# Chat session-1",
    "",
    "## SYSTEM",
    "",
    "system note",
    "",
    "## USER",
    "",
    "hello there",
    "",
    "## ASSISTANT",
    "",
    "hi",
    ""
  ].join("\n");

  const parsed = parseTranscriptMarkdown(markdown);
  assert.equal(parsed.metadata.id, "session-1");
  assert.equal(parsed.metadata.prompt_tokens, 4);
  assert.deepEqual(parsed.messages, [
    { role: "system", content: "system note" },
    { role: "user", content: "hello there" },
    { role: "assistant", content: "hi" }
  ]);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-transcript-parse-"));
  const filePath = path.join(tempDir, "chat.md");
  fs.writeFileSync(filePath, markdown, "utf8");
  const fromFile = readTranscript(filePath);
  assert.deepEqual(fromFile.messages, parsed.messages);
});
