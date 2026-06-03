import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStatusRenderer, processPrompt } from "../tools/llm-chat-cli/src/cli.js";
import { createSessionUsage } from "../tools/llm-chat-cli/src/domain/usage.js";

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
