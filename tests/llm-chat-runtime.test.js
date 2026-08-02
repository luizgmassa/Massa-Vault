import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createChatSession,
  addContextEntry
} from "../tools/llm-chat-cli/src/services/chat-session.js";
import { runPrompt } from "../tools/llm-chat-cli/src/services/chat-runtime.js";

test("runPrompt uses session context entries, updates routing, and clears staged context on success", async () => {
  const session = createChatSession({ systemPrompt: "global system" });
  session.activeConversationPrompt = "answer as a concise analyst";
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
  assert.equal(capturedBody.messages[1].role, "system");
  assert.equal(capturedBody.messages[1].content, "answer as a concise analyst");
  assert.equal(capturedBody.messages.at(-3).content, "extra context from history");
  assert.equal(capturedBody.messages.at(-2).content, "vault context");
  assert.equal(capturedBody.messages.at(-1).content, "new prompt");
  assert.equal(session.history.at(-2)?.content, "new prompt");
  assert.equal(session.history.at(-1)?.content, "answer");
  assert.equal(session.sessionUsage.total_tokens, 11);
  assert.equal(session.latestRouting?.targetModel, "smart-router-general");
  assert.equal(session.addedContextEntries.length, 0);
  assert.equal(session.activeConversationPrompt, "answer as a concise analyst");
  assert.equal(
    session.history.some((entry) => /concise analyst/i.test(entry.content || "")),
    false
  );
  assert.equal(result.routing?.targetModel, "smart-router-general");
});

test("runPrompt keeps conversation prompt across future model calls", async () => {
  const session = createChatSession({ systemPrompt: "" });
  session.activeConversationPrompt = "Stay in persona.";
  const capturedBodies = [];

  for (const prompt of ["first", "second"]) {
    await runPrompt(session, {
      prompt,
      renderMode: "silent",
      vaultContextBuilder: async () => null,
      chatCompletion: async ({ body, onUsage }) => {
        capturedBodies.push(body);
        onUsage?.({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        return {
          assistantText: "ok",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          routing: null
        };
      }
    });
  }

  assert.equal(capturedBodies.length, 2);
  assert.equal(capturedBodies[0].messages[0].content, "Stay in persona.");
  assert.equal(capturedBodies[1].messages[0].content, "Stay in persona.");
  assert.equal(capturedBodies[1].messages.at(-1).content, "second");
  assert.equal(session.history.length, 4);
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

test("runPrompt emits fallback warning when routing downgrades from cloud to local", async () => {
  const session = createChatSession({ systemPrompt: "" });
  const warnings = [];

  const result = await runPrompt(session, {
    prompt: "hello",
    renderMode: "silent",
    vaultContextBuilder: async () => null,
    onWarning: (message) => warnings.push(message),
    chatCompletion: async ({ onRouting, onUsage }) => {
      onRouting?.({
        lane: "general",
        confidence: "1.0000",
        targetModel: "smart-router-general",
        routedModel: "general_cloud",
        providerModel: "ollama_chat/deepseek-v3.2:cloud",
        displayModel: "deepseek-v3.2:cloud",
        modelLocation: "cloud"
      });
      onRouting?.({
        lane: "general",
        confidence: "1.0000",
        targetModel: "smart-router-general",
        routedModel: "general_local",
        providerModel: "ollama_chat/qwen3.5:9b",
        displayModel: "qwen3.5:9b",
        modelLocation: "local",
        responseModel: "ollama_chat/qwen3.5:9b",
        fallbackUsed: true,
        fallbackWarning: "cloud route fell back to local model qwen3.5:9b"
      });
      onUsage?.({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      return {
        assistantText: "ok",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        routing: {
          lane: "general",
          confidence: "1.0000",
          targetModel: "smart-router-general",
          routedModel: "general_local",
          providerModel: "ollama_chat/qwen3.5:9b",
          displayModel: "qwen3.5:9b",
          modelLocation: "local",
          responseModel: "ollama_chat/qwen3.5:9b",
          fallbackUsed: true,
          fallbackWarning: "cloud route fell back to local model qwen3.5:9b"
        }
      };
    }
  });

  assert.equal(result.routing?.fallbackUsed, true);
  assert.deepEqual(warnings, ["[chat] warning: cloud route fell back to local model qwen3.5:9b"]);
});
