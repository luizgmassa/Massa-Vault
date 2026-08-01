import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStatusRenderer, processPrompt } from "../tools/llm-chat-cli/src/cli.js";
import { createSessionUsage } from "../tools/llm-chat-cli/src/domain/usage.js";
import { buildMarkdownTable } from "../tools/llm-chat-cli/src/domain/info-screen.js";
import { formatHistoryConversationLines } from "../tools/llm-chat-cli/src/domain/history.js";

test("TTY chat rendering keeps assistant chunks contiguous", async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-rendering-"));
  const writes = [];
  const outputStream = {
    isTTY: true,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    }
  };
  const statusStream = {
    isTTY: true,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    }
  };

  process.chdir(tempDir);
  try {
    await processPrompt({
      prompt: "ping",
      history: [],
      systemPrompt: "",
      sessionUsage: createSessionUsage(),
      estimatedTokensRef: { value: 0 },
      statusRenderer: createStatusRenderer({ stream: statusStream }),
      limitsByModel: {},
      outputStream,
      chatCompletion: async ({ onRouting, onDelta, onUsage }) => {
        onRouting({
          lane: "general",
          confidence: "1.0000",
          targetModel: "smart-router-general"
        });
        onDelta("Hel");
        onDelta("lo");
        onUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
        return {
          assistantText: "Hello",
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          routing: {
            lane: "general",
            confidence: "1.0000",
            targetModel: "smart-router-general"
          }
        };
      }
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const rendered = writes.join("");
  assert.match(rendered, /assistant> Hello\n\[tokens session=3/);
  assert.equal((rendered.match(/\[tokens session=/g) || []).length, 1);
  assert.equal(rendered.includes("\u001b[1G"), false);
  assert.equal(rendered.includes("\u001b[2K"), false);
  assert.doesNotMatch(rendered, /Hel\[tokens|Hello\[tokens/);
});

test("markdown table cells escape backslashes so pipes cannot open a new column", () => {
  // `a\|b` must stay one cell. Escaping `|` before `\` would emit `a\\|b`,
  // where `\\` is a literal backslash and the pipe is left unescaped.
  const [, , row] = buildMarkdownTable(["Field", "Value"], [["Key", "a\\|b"]]);
  const cells = row.slice(2, -2).split(/(?<!\\)\|/);
  assert.equal(cells.length, 2);
  assert.equal(cells[1].trim(), "a\\\\\\|b");

  const [, , trailing] = buildMarkdownTable(["Field"], [["ends with backslash\\"]]);
  assert.equal(trailing.slice(2, -2).split(/(?<!\\)\|/).length, 1);

  const [, , newline] = buildMarkdownTable(["Field"], [["line one\nline two"]]);
  assert.equal(newline.includes("\n"), false);
  assert.equal(newline, "| line one line two |");
});

test("history tables reuse the shared escaping helper", () => {
  const lines = formatHistoryConversationLines({
    rows: [
      {
        number: 1,
        time: "10-00-00",
        date: "2026-05-30",
        fileName: "evil\\|injected.md",
        snippet: "safe"
      }
    ],
    title: "History conversations"
  });
  const dataRow = lines.find((line) => line.includes("injected"));
  assert.ok(dataRow, "expected a rendered row for the crafted file name");
  assert.equal(dataRow.slice(2, -2).split(/(?<!\\)\|/).length, 5);
});
