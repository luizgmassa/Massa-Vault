import test from "node:test";
import assert from "node:assert/strict";
import {
  addContextEntry,
  createChatSession,
  loadTranscriptIntoSession,
  resetChatSession
} from "../tools/llm-chat-cli/src/services/chat-session.js";

test("createChatSession initializes mutable chat state and resetChatSession clears conversation data", () => {
  const session = createChatSession({ systemPrompt: "system prompt" });
  session.history.push({ role: "user", content: "hello" });
  session.sessionUsage.prompt_tokens = 4;
  session.sessionUsage.completion_tokens = 2;
  session.sessionUsage.total_tokens = 6;
  session.estimatedTokensRef.value = 6;
  session.latestRouting = { targetModel: "smart-router-general" };
  session.transcriptSavedPath = "/tmp/chat.md";
  session.lastSavedHistoryLength = 1;
  session.historyFlowStack = [{ screen: "dates" }];
  addContextEntry(session, { source: "AI Chats/2026-06-02/demo.md", content: "prior context" });

  resetChatSession(session);

  assert.equal(session.activeSystemPrompt, "system prompt");
  assert.equal(session.activeConversationPrompt, "");
  assert.equal(Array.isArray(session.history), true);
  assert.equal(session.history.length, 0);
  assert.equal(session.sessionUsage.total_tokens, 0);
  assert.equal(session.estimatedTokensRef.value, 0);
  assert.equal(session.latestRouting, null);
  assert.equal(session.transcriptSavedPath, null);
  assert.equal(session.historyFlowStack.length, 0);
  assert.equal(session.addedContextEntries.length, 0);
});

test("conversation prompt is transcript-bound session state", () => {
  const session = createChatSession({
    systemPrompt: "system prompt",
    conversationPrompt: "persona prompt"
  });
  session.history.push({ role: "user", content: "hello" });
  session.lastSavedConversationPrompt = "persona prompt";

  resetChatSession(session);

  assert.equal(session.activeSystemPrompt, "system prompt");
  assert.equal(session.activeConversationPrompt, "");
  assert.equal(session.lastSavedConversationPrompt, "");
});

test("loadTranscriptIntoSession hydrates transcript metadata and clears staged context", () => {
  const session = createChatSession({ systemPrompt: "" });
  addContextEntry(session, { source: "history.md", content: "temp context" });
  session.historyFlowStack = [{ screen: "conversations" }];

  loadTranscriptIntoSession(session, {
    transcriptPath: "/tmp/history.md",
    transcript: {
      messages: [
        { role: "user", content: "old prompt" },
        { role: "assistant", content: "old answer" }
      ]
    },
    metadata: {
      id: "history-1",
      created_at: "2026-06-01T12:00:00.000Z",
      gateway_url: "http://127.0.0.1:4100",
      model: "smart-router-general",
      conversation_prompt: "restored prompt"
    },
    fallbackSessionId: "fallback-id",
    fallbackSessionStartedAt: "2026-06-01T00:00:00.000Z",
    fallbackGatewayUrl: "http://fallback",
    fallbackModel: "smart-router",
    routing: { targetModel: "smart-router-general" },
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    }
  });

  assert.equal(session.history.length, 2);
  assert.equal(session.activeTranscript?.path, "/tmp/history.md");
  assert.equal(session.activeTranscript?.id, "history-1");
  assert.equal(session.activeTranscript?.conversationPrompt, "restored prompt");
  assert.equal(session.activeConversationPrompt, "restored prompt");
  assert.equal(session.lastSavedConversationPrompt, "restored prompt");
  assert.equal(session.activeTranscript?.routing?.targetModel, "smart-router-general");
  assert.equal(session.latestRouting, null);
  assert.equal(session.transcriptSavedPath, "/tmp/history.md");
  assert.equal(session.lastSavedHistoryLength, 2);
  assert.equal(session.sessionUsage.total_tokens, 15);
  assert.equal(session.estimatedTokensRef.value, 15);
  assert.equal(session.historyFlowStack.length, 0);
  assert.equal(session.addedContextEntries.length, 0);
});
