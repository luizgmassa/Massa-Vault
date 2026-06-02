import test from "node:test";
import assert from "node:assert/strict";
import { createChatSession, addContextEntry } from "../tools/llm-chat-cli/src/chat-session.js";
import { runPrompt } from "../tools/llm-chat-cli/src/chat-runtime.js";

test("runPrompt uses session context entries, updates routing, and clears staged context on success", async () => {
  const session = createChatSession({ systemPrompt: "global system" });
  session.history.push({ role: "user", content: "earlier question" });
  addContextEntry(session, {
    source: "AI Chats/2026-06-01/demo.md",
    content: "extra context from history"
  });

  let capturedBody = null;
  const result = await runPrompt(session, {
    prompt: "new prompt",
    renderMode: "silent",
    vaultContextBuilder: async () => ({
      message: "vault context",
      metadata: { source: "obsidian", retrieved_chunks: 1 }
    }),
    chatCompletion: async ({ body, onRouting, onUsage }) => {
      capturedBody = body;
      onRouting?.({ targetModel: "smart-router-general", lane: "general" });
      onUsage?.({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
      return {
        assistantText: "answer",
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        routing: { targetModel: "smart-router-general", lane: "general" }
      };
    }
  });

  assert.ok(capturedBody);
  assert.equal(capturedBody.messages[0].role, "system");
  assert.equal(capturedBody.messages[0].content, "global system");
  assert.equal(capturedBody.messages.at(-3).content, "extra context from history");
  assert.equal(capturedBody.messages.at(-2).content, "vault context");
  assert.equal(capturedBody.messages.at(-1).content, "new prompt");
  assert.equal(session.history.at(-2)?.content, "new prompt");
  assert.equal(session.history.at(-1)?.content, "answer");
  assert.equal(session.sessionUsage.total_tokens, 11);
  assert.equal(session.latestRouting?.targetModel, "smart-router-general");
  assert.equal(session.addedContextEntries.length, 0);
  assert.equal(result.routing?.targetModel, "smart-router-general");
});

test("runPrompt estimates usage when gateway omits usage payload", async () => {
  const session = createChatSession({ systemPrompt: "" });
  const result = await runPrompt(session, {
    prompt: "estimate me",
    renderMode: "silent",
    vaultContextBuilder: async () => null,
    chatCompletion: async () => ({
      assistantText: "done",
      usage: null,
      routing: null
    })
  });

  assert.equal(result.assistantText, "done");
  assert.equal(session.history.length, 2);
  assert.equal(session.sessionUsage.total_tokens > 0, true);
});
