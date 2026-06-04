import test from "node:test";
import assert from "node:assert/strict";
import { createCommandRuntime } from "../tools/llm-chat-cli/src/commands.js";
import { createDefaultCommandRuntime } from "../tools/llm-chat-cli/src/services/command-executor.js";
import { createChatSession } from "../tools/llm-chat-cli/src/services/chat-session.js";

function createRuntime(overrides = {}) {
  const defaultSyncStatus = {
    status: "paused",
    running: false,
    paused: true,
    conflictCount: 0,
    backends: {
      git: { enabled: true, hasError: false },
      drive: { enabled: true, hasError: true }
    }
  };

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
        syncResult: { syntheticModel: defaultSyncStatus },
        summary: "[chat] sync status=idle conflicts=0"
      }),
      formatSyncFeedback: (result) => result.summary || "[chat] sync status=idle conflicts=0",
      readLocalSyncStatusModel: () => ({ status: "idle" }),
      syncStatusModelFromResult: (result) => result.syntheticModel || { status: "idle" },
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
      formatUsageScreenLines: (summary) => [
        `session=${summary.sessionTotalTokens}`,
        `model=${summary.model}`
      ],
      printUsageSummary: ({ sessionUsage }) => {
        console.log(`usage=${sessionUsage.total_tokens}`);
      },
      ...overrides.usageClient
    },
    searchClient: {
      formatSearchPanel: () => [],
      formatSearchScreenLines: () => ["Search ready."],
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
  assert.equal(result.action?.type, "refresh-sync-status");
  assert.equal(result.action?.syncStatus?.backends?.drive?.hasError, true);
});

test("createCommandRuntime returns screen actions for /usage and /routing without CLI globals", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });
  session.sessionUsage.total_tokens = 12;
  session.latestRouting = { targetModel: "smart-router-general", lane: "general" };

  const usageResult = await runtime.execute({
    line: "/usage",
    session,
    limitsByModel: {},
    mode: "tui"
  });
  const routingResult = await runtime.execute({
    line: "/routing",
    session,
    limitsByModel: {},
    mode: "tui"
  });

  assert.equal(usageResult.handled, true);
  assert.equal(routingResult.handled, true);
  assert.equal(usageResult.action?.screen, "panel");
  assert.match(usageResult.action?.panelScreen?.lines?.join("\n") || "", /session=12/);
  assert.equal(routingResult.action?.screen, "panel");
  assert.match(routingResult.action?.panelScreen?.lines?.join("\n") || "", /smart-router-general/);
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

test("createCommandRuntime returns info screens for sync conflicts and usage-style commands", async () => {
  const runtime = createRuntime({
    syncClient: {
      runNotesAutomationCommand: () => ({
        ok: true,
        output: "conflict A\nconflict B",
        payload: {}
      }),
      formatSyncFeedback: () => "[chat] sync status=conflict conflicts=2"
    }
  });
  const session = createChatSession({ systemPrompt: "" });

  const syncConflicts = await runtime.execute({
    line: "/sync conflicts",
    session,
    limitsByModel: {},
    mode: "tui"
  });
  const searchUsage = await runtime.execute({
    line: "/search",
    session,
    limitsByModel: {},
    mode: "tui"
  });
  const systemUsage = await runtime.execute({
    line: "/system",
    session,
    limitsByModel: {},
    mode: "tui"
  });

  assert.equal(syncConflicts.action?.screen, "panel");
  assert.match(syncConflicts.action?.panelScreen?.lines?.join("\n") || "", /conflict A/);
  assert.equal(searchUsage.action?.screen, "panel");
  assert.match(searchUsage.action?.panelScreen?.lines?.join("\n") || "", /\/search <query>/);
  assert.equal(systemUsage.action?.screen, "panel");
  assert.match(systemUsage.action?.panelScreen?.lines?.join("\n") || "", /\/system show/);
});

test("createDefaultCommandRuntime wires default saveAndSync for /sync", async () => {
  const runtime = createDefaultCommandRuntime({
    saveAndSync: async () => ({
      saveResult: { path: "/tmp/default-sync.md", saved: true },
      syncResult: {
        syntheticModel: {
          status: "idle",
          running: false,
          paused: false,
          conflictCount: 0,
          backends: {
            git: { enabled: true, hasError: false },
            drive: { enabled: true, hasError: false }
          }
        }
      },
      summary: "[chat] sync status=idle conflicts=0"
    }),
    syncClient: {
      formatSyncFeedback: (result) => result.summary || "[chat] sync status=idle conflicts=0",
      readLocalSyncStatusModel: () => ({ status: "idle" }),
      syncStatusModelFromResult: (result) => result.syntheticModel || { status: "idle" },
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
  assert.equal(result.action?.type, "refresh-sync-status");
});
