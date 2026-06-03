import test from "node:test";
import assert from "node:assert/strict";
import { createCommandRuntime } from "../tools/llm-chat-cli/src/commands.js";
import { createDefaultCommandRuntime } from "../tools/llm-chat-cli/src/services/command-executor.js";
import { createChatSession } from "../tools/llm-chat-cli/src/services/chat-session.js";

function createRuntime(overrides = {}) {
  return createCommandRuntime({
    config: {
      defaultGatewayModel: "smart-router",
      defaultRagMaxChars: 6000,
      historyFlowPreview: "preview",
      historyFlowSummary: "summary",
      vaultContextModes: ["semantic", "manifest"],
      isVaultContextEnabled: () => true
    },
    syncClient: {
      saveAndSync: async () => ({
        saveResult: { path: "/tmp/chat.md", saved: true },
        summary: "[chat] sync status=idle conflicts=0"
      }),
      formatSyncFeedback: (result) => result.summary || "[chat] sync status=idle conflicts=0",
      readLocalSyncStatusModel: () => ({ status: "idle" }),
      runNotesAutomationCommand: () => ({ ok: true, output: "{}", payload: {} }),
      ...overrides.syncClient
    },
    historyClient: {
      isHistoryConversationsScreen: () => false,
      normalizeHistoryInputShortcut: (line) => line,
      parseHistoryConversationAlias: () => null,
      ...overrides.historyClient
    },
    usageClient: {
      asUsage: (usage) => usage,
      createUsageSummary: () => ({
        allTimeTotalTokens: 20,
        sessionTotalTokens: 12,
        sessionEstimatedTokens: 12,
        model: "smart-router",
        remainingTpm: 1000,
        remainingRpm: 10,
        quotaRefresh: "60s"
      }),
      formatUsagePanel: (summary) => [
        `session_total_tokens: ${summary.sessionTotalTokens}`,
        `model: ${summary.model}`
      ],
      printUsageSummary: ({ sessionUsage }) => {
        console.log(`usage=${sessionUsage.total_tokens}`);
      },
      ...overrides.usageClient
    },
    searchClient: {
      formatSearchPanel: () => [],
      printSearchPlain: () => {},
      ...overrides.searchClient
    },
    sessionClient: {
      resetSession: (session) => {
        session.history = [];
      },
      ...overrides.sessionClient
    }
  });
}

test("createCommandRuntime handles /sync via grouped clients", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });
  const messages = [];

  const result = await runtime.execute({
    line: "/sync",
    session,
    limitsByModel: {},
    mode: "tui",
    io: {
      message: (text) => messages.push(text)
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.match(messages.join("\n"), /transcript saved/i);
  assert.match(messages.join("\n"), /sync status=idle/i);
});

test("createCommandRuntime renders /usage and /routing without CLI globals", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });
  session.sessionUsage.total_tokens = 12;
  session.latestRouting = { targetModel: "smart-router-general", lane: "general" };
  const panels = [];

  const usageResult = await runtime.execute({
    line: "/usage",
    session,
    limitsByModel: {},
    mode: "tui",
    io: {
      panel: (title, lines) => panels.push({ title, lines })
    }
  });
  const routingResult = await runtime.execute({
    line: "/routing",
    session,
    limitsByModel: {},
    mode: "tui",
    io: {
      panel: (title, lines) => panels.push({ title, lines })
    }
  });

  assert.equal(usageResult.handled, true);
  assert.equal(routingResult.handled, true);
  assert.equal(panels[0].title, "usage");
  assert.match(panels[0].lines.join("\n"), /session_total_tokens: 12/);
  assert.equal(panels[1].title, "routing");
  assert.match(panels[1].lines.join("\n"), /smart-router-general/);
});

test("createCommandRuntime keeps unknown commands user-visible", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });
  const messages = [];

  const result = await runtime.execute({
    line: "/unknown",
    session,
    limitsByModel: {},
    mode: "tui",
    io: {
      message: (text) => messages.push(text)
    }
  });

  assert.equal(result.handled, true);
  assert.match(messages[0], /unknown command: \/unknown/i);
});

test("createDefaultCommandRuntime wires default saveAndSync for /sync", async () => {
  const runtime = createDefaultCommandRuntime({
    saveAndSync: async () => ({
      saveResult: { path: "/tmp/default-sync.md", saved: true },
      summary: "[chat] sync status=idle conflicts=0"
    }),
    syncClient: {
      formatSyncFeedback: (result) => result.summary || "[chat] sync status=idle conflicts=0",
      readLocalSyncStatusModel: () => ({ status: "idle" }),
      runNotesAutomationCommand: () => ({ ok: true, output: "{}", payload: {} })
    }
  });
  const session = createChatSession({ systemPrompt: "" });
  const messages = [];

  const result = await runtime.execute({
    line: "/sync",
    session,
    limitsByModel: {},
    mode: "tui",
    io: {
      message: (text) => messages.push(text)
    }
  });

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.match(messages.join("\n"), /default-sync\.md/);
  assert.match(messages.join("\n"), /sync status=idle/i);
});
