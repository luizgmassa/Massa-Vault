import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCommandRuntime,
  executeChatCommand
} from "../tools/llm-chat-cli/src/commands.js";
import { createDefaultCommandRuntime } from "../tools/llm-chat-cli/src/services/command-executor.js";
import {
  createChatSession,
  resetChatSession
} from "../tools/llm-chat-cli/src/services/chat-session.js";
import * as HistoryDomain from "../tools/llm-chat-cli/src/domain/history.js";

async function withCapturedConsoleLog(run) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.log = originalLog;
  }
}

// Builds the flat deps bag `executeChatCommand` expects (as opposed to the
// grouped `syncClient`/`historyClient`/... shape `createCommandRuntime`
// takes). Reuses the real domain/history.js pure functions wherever the
// runtime dereferences them unconditionally before any command dispatch, so
// the assembled runtime behaves like production rather than a stub tower.
function buildExecuteChatCommandDeps(overrides = {}) {
  return {
    HISTORY_FLOW_PREVIEW: HistoryDomain.HISTORY_FLOW_PREVIEW,
    HISTORY_FLOW_SUMMARY: HistoryDomain.HISTORY_FLOW_SUMMARY,
    DEFAULT_GATEWAY_MODEL: "smart-router",
    DEFAULT_RAG_MAX_CHARS: 6000,
    VAULT_CONTEXT_MODES: ["semantic", "manifest"],
    isVaultContextEnabled: () => true,
    addUsageToLedger: () => {},
    accumulateSessionUsage: (target, usage) => {
      target.total_tokens = (target.total_tokens || 0) + (usage?.total_tokens || 0);
    },
    asUsage: (usage) =>
      usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    buildGatewayOptions: () => ({ gatewayUrl: "http://127.0.0.1:4100", apiKey: "" }),
    buildHistoryContextText: HistoryDomain.buildHistoryContextText,
    captureRoutingFromTranscriptMetadata: HistoryDomain.captureRoutingFromTranscriptMetadata,
    clearHistoryFlowStack: HistoryDomain.clearHistoryFlowStack,
    createHistoryConversationsOnlyMessage: HistoryDomain.createHistoryConversationsOnlyMessage,
    createHistoryDateRows: () => [],
    createHistoryPanelState: HistoryDomain.createHistoryPanelState,
    createHistoryRowsFromDateEntries: HistoryDomain.createHistoryRowsFromDateEntries,
    createHistoryRowsFromSearchResults: HistoryDomain.createHistoryRowsFromSearchResults,
    createHistoryScreenAction: HistoryDomain.createHistoryScreenAction,
    createUsageSummary: ({ sessionUsage }) => ({
      allTimeTotalTokens: 1,
      sessionTotalTokens: sessionUsage.total_tokens,
      sessionEstimatedTokens: sessionUsage.total_tokens,
      model: "smart-router",
      remainingTpm: 999,
      remainingRpm: 9,
      quotaRefresh: "30s"
    }),
    formatHistoryConversationLines: HistoryDomain.formatHistoryConversationLines,
    formatHistoryDateLines: HistoryDomain.formatHistoryDateLines,
    formatHistoryPreviewLines: HistoryDomain.formatHistoryPreviewLines,
    formatHistorySummaryLines: HistoryDomain.formatHistorySummaryLines,
    formatRelativeTranscriptLabel: HistoryDomain.formatRelativeTranscriptLabel,
    formatSearchPanel: () => [],
    formatSearchScreenLines: () => ["Search ready."],
    formatSyncFeedback: (result) => result?.summary || "[chat] sync status=idle conflicts=0",
    formatUsagePanel: (summary) => [`session_total_tokens: ${summary.sessionTotalTokens}`],
    formatUsageScreenLines: (summary) => [
      `session=${summary.sessionTotalTokens}`,
      `model=${summary.model}`
    ],
    getHistoryRowFromSelection: HistoryDomain.getHistoryRowFromSelection,
    historyBackStep: HistoryDomain.historyBackStep,
    isHistoryConversationsScreen: HistoryDomain.isHistoryConversationsScreen,
    listTranscriptsForDate: () => [],
    normalizeHistoryDateInput: HistoryDomain.normalizeHistoryDateInput,
    normalizeHistoryInputShortcut: HistoryDomain.normalizeHistoryInputShortcut,
    parseHistoryConversationAlias: HistoryDomain.parseHistoryConversationAlias,
    parsePositiveIndex: HistoryDomain.parsePositiveIndex,
    printSearchPlain: () => {},
    printUsageSummary: () => {},
    pushHistoryFlowDetail: HistoryDomain.pushHistoryFlowDetail,
    readLocalSyncStatusModel: () => ({ status: "idle" }),
    resolveVaultPath: () => "/tmp/vault",
    runNotesAutomationCommand: () => ({ ok: true, output: "{}", payload: {} }),
    setHistoryFlowConversations: HistoryDomain.setHistoryFlowConversations,
    setHistoryFlowDatesRoot: HistoryDomain.setHistoryFlowDatesRoot,
    syncStatusModelFromResult: (result) => result?.syntheticModel || { status: "idle" },
    usageFromTranscriptMetadata: HistoryDomain.usageFromTranscriptMetadata,
    loadTranscriptIntoSession: () => {},
    resetConversation: resetChatSession,
    ...overrides
  };
}

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
      resetSession: resetChatSession,
      ...overrides.sessionClient
    },
    modelManagerClient: overrides.modelManagerClient || {
      readState: () => ({
        managers: [],
        verifiedModels: [],
        selectedManagerIds: [],
        preferences: { mode: "auto", pinnedAlias: null },
        restartRequired: false
      }),
      formatMmtScreenLines: () => ["No model managers configured."],
      formatModelScreenLines: () => ["No verified MMT models."],
      addManagerFromInput: () => ({}),
      editManagerFromInput: () => ({}),
      removeManagerFromInput: () => ({}),
      selectManagerFromInput: () => ({}),
      discoverManagers: async () => ({ state: {}, errors: [] }),
      applyModelManagerConfig: async () => ({ state: {}, error: null }),
      refreshActiveModels: async () => ({}),
      pinModelFromInput: () => ({}),
      autoModelMode: () => ({})
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
  session.activeConversationPrompt = "persona";
  const config = await runtime.execute({
    line: "/config",
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
  assert.match(config.action?.panelScreen?.lines?.join("\n") || "", /Conversation prompt.*Configured/);
});

test("createCommandRuntime edits and sets conversation prompt", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });
  const messages = [];

  const edit = await runtime.execute({
    line: "/prompt",
    session,
    limitsByModel: {},
    mode: "tui"
  });
  assert.equal(edit.handled, true);
  assert.equal(edit.action?.type, "edit-conversation-prompt");
  assert.equal(edit.action?.prompt, "");

  const updated = await runtime.execute({
    line: "/prompt Speak like a careful analyst.",
    session,
    limitsByModel: {},
    mode: "tui",
    io: { message: (text) => messages.push(text) }
  });
  assert.equal(updated.handled, true);
  assert.equal(session.activeConversationPrompt, "Speak like a careful analyst.");
  assert.match(messages.join("\n"), /conversation prompt updated/);

  const secondEdit = await runtime.execute({
    line: "/prompt",
    session,
    limitsByModel: {},
    mode: "tui"
  });
  assert.equal(secondEdit.action?.prompt, "Speak like a careful analyst.");

  await runtime.execute({
    line: '/prompt ""',
    session,
    limitsByModel: {},
    mode: "tui",
    io: { message: (text) => messages.push(text) }
  });
  assert.equal(session.activeConversationPrompt, "");
  assert.match(messages.join("\n"), /conversation prompt cleared/);

  session.activeConversationPrompt = "temporary persona";
  session.history.push({ role: "user", content: "hello" });
  const clearConversation = await runtime.execute({
    line: "/clear",
    session,
    limitsByModel: {},
    mode: "tui",
    io: { message: (text) => messages.push(text) }
  });
  assert.equal(clearConversation.handled, true);
  assert.equal(session.activeConversationPrompt, "");
  assert.deepEqual(session.history, []);
});

test("createCommandRuntime handles MMT and model screens with active/pending selection", async () => {
  let state = {
    activeScreen: "conversation",
    managers: [{ id: "ollama", tool: "ollama", baseUrl: "http://127.0.0.1:11434" }],
    selectedManagerIds: ["ollama"],
    verifiedModels: [
      {
        alias: "mmt_ollama_qwen3_5_9b",
        name: "qwen3.5:9b",
        managerTool: "ollama",
        location: "local",
        status: "active"
      },
      {
        alias: "mmt_ollama_pending",
        name: "pending",
        managerTool: "ollama",
        location: "local",
        status: "pending"
      }
    ],
    preferences: { mode: "auto", pinnedAlias: null },
    restartRequired: true
  };
  const runtime = createRuntime({
    modelManagerClient: {
      readState: () => state,
      formatMmtScreenLines: (nextState) => [`Manager ${nextState.managers[0].id}`, "Actions : /mmt apply"],
      formatModelScreenLines: (nextState) => nextState.verifiedModels.map((model, index) => `${index + 1} ${model.alias} ${model.status}`),
      routingFromPinnedModelState: (nextState) => {
        if (nextState.preferences.mode !== "pin") return null;
        const selected = nextState.verifiedModels.find(
          (model) => model.alias === nextState.preferences.pinnedAlias
        );
        return selected
          ? {
              routedModel: selected.alias,
              displayModel: selected.name,
              modelLocation: selected.location,
              modelManagerTool: selected.managerTool
            }
          : null;
      },
      addManagerFromInput: () => state,
      editManagerFromInput: () => state,
      removeManagerFromInput: () => state,
      selectManagerFromInput: () => state,
      discoverManagers: async () => ({ state, errors: [] }),
      applyModelManagerConfig: async () => ({ state, error: "LiteLLM offline" }),
      refreshActiveModels: async () => state,
      pinModelFromInput: (value) => {
        const alias = value === "1" ? state.verifiedModels[0].alias : value === "2" ? state.verifiedModels[1].alias : value;
        const selected = state.verifiedModels.find((model) => model.alias === alias);
        if (selected?.status !== "active") {
          throw new Error(`Model alias ${alias} is pending; restart required before selection.`);
        }
        state = {
          ...state,
          preferences: { mode: "pin", pinnedAlias: alias }
        };
        return state;
      },
      autoModelMode: () => {
        state = { ...state, preferences: { mode: "auto", pinnedAlias: null } };
        return state;
      }
    }
  });
  const session = createChatSession({ systemPrompt: "" });

  const mmt = await runtime.execute({ line: "/mmt", session, limitsByModel: {}, mode: "tui" });
  assert.equal(mmt.action?.screen, "panel");
  assert.match(mmt.action?.panelScreen?.lines?.join("\n") || "", /Manager ollama/);

  const model = await runtime.execute({ line: "/model", session, limitsByModel: {}, mode: "tui" });
  assert.equal(model.action?.panelScreen?.id, "model");
  assert.equal(model.action?.panelScreen?.commandHint, "/model select <row|alias> or row number");
  assert.match(model.action?.panelScreen?.lines?.join("\n") || "", /mmt_ollama_qwen3_5_9b active/);

  session.activeScreen = "model";
  const pinned = await runtime.execute({ line: "1", session, limitsByModel: {}, mode: "tui" });
  assert.equal(pinned.action?.panelScreen?.id, "model");
  assert.equal(state.preferences.pinnedAlias, "mmt_ollama_qwen3_5_9b");
  assert.equal(session.latestRouting?.displayModel, "qwen3.5:9b");
  assert.equal(session.latestRouting?.modelLocation, "local");

  const rejected = await runtime.execute({ line: "/model select 2", session, limitsByModel: {}, mode: "tui" });
  assert.match(rejected.action?.panelScreen?.lines?.join("\n") || "", /restart required/);

  const auto = await runtime.execute({ line: "/model auto", session, limitsByModel: {}, mode: "tui" });
  assert.equal(auto.action?.panelScreen?.id, "model");
  assert.equal(state.preferences.mode, "auto");
  assert.equal(session.latestRouting, null);
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

test("createCommandRuntime redirects history-only shortcuts to the conversations-only message outside that screen", async () => {
  const runtime = createRuntime({
    historyClient: {
      parseHistoryConversationAlias: HistoryDomain.parseHistoryConversationAlias,
      createHistoryConversationsOnlyMessage: HistoryDomain.createHistoryConversationsOnlyMessage,
      isHistoryConversationsScreen: () => false
    }
  });
  const session = createChatSession({ systemPrompt: "" });
  const messages = [];

  const result = await runtime.execute({
    line: "/switch 3",
    session,
    limitsByModel: {},
    mode: "tui",
    io: { message: (text) => messages.push(text) }
  });

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.equal(
    messages.join("\n"),
    "[History] /switch available only in History conversations screen."
  );
});

test("createCommandRuntime lets history-only shortcuts through once the conversations screen is active", async () => {
  const runtime = createRuntime({
    historyClient: {
      parseHistoryConversationAlias: HistoryDomain.parseHistoryConversationAlias,
      normalizeHistoryInputShortcut: HistoryDomain.normalizeHistoryInputShortcut,
      isHistoryConversationsScreen: HistoryDomain.isHistoryConversationsScreen,
      getHistoryRowFromSelection: () => null
    }
  });
  const session = createChatSession({ systemPrompt: "" });
  HistoryDomain.setHistoryFlowConversations(session, {
    datePanel: HistoryDomain.createHistoryPanelState({ title: "History", lines: [] }),
    conversationsPanel: HistoryDomain.createHistoryPanelState({ title: "History", lines: [] })
  });
  const messages = [];

  const result = await runtime.execute({
    line: "/switch 3",
    session,
    limitsByModel: {},
    mode: "tui",
    io: { message: (text) => messages.push(text) }
  });

  // Because the session is already on the conversations screen, the
  // redirect message is never emitted; normalizeHistoryInputShortcut
  // instead expands "/switch 3" to "/history switch 3", which reaches the
  // real "/history switch" handler and reports "no row selected" since
  // getHistoryRowFromSelection returns null.
  assert.equal(result.handled, true);
  assert.match(messages.join("\n"), /Usage : \/history switch <number>/);
});

test("createCommandRuntime reports /sync usage for unrecognized /sync subcommands in plain mode", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });

  const { result, lines } = await withCapturedConsoleLog(() =>
    runtime.execute({
      line: "/sync bogus",
      session,
      limitsByModel: {},
      mode: "plain"
    })
  );

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.equal(result.action, undefined);
  assert.deepEqual(lines, ["usage: /sync | /sync status | /sync conflicts"]);
});

test("createCommandRuntime returns an info screen for unrecognized /sync subcommands in tui mode", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });

  const result = await runtime.execute({
    line: "/sync bogus",
    session,
    limitsByModel: {},
    mode: "tui"
  });

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.equal(result.action?.screen, "panel");
  assert.equal(result.action?.panelScreen?.id, "sync");
  assert.equal(result.action?.panelScreen?.commandHint, "/sync commands");
  assert.deepEqual(result.action?.panelScreen?.lines, [
    "Usage : `/sync` | `/sync status` | `/sync conflicts` | `/back` | `/conv`"
  ]);
});

test("createCommandRuntime reports unhandled for plain chat text that is not a slash command", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });

  const result = await runtime.execute({
    line: "hello, how are you today?",
    session,
    limitsByModel: {},
    mode: "tui"
  });

  assert.deepEqual(result, { handled: false, exit: false });
});

test("createCommandRuntime prints /system usage in plain mode", async () => {
  const runtime = createRuntime();
  const session = createChatSession({ systemPrompt: "" });

  const { result, lines } = await withCapturedConsoleLog(() =>
    runtime.execute({
      line: "/system",
      session,
      limitsByModel: {},
      mode: "plain"
    })
  );

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.deepEqual(lines, ["usage: /system show|set <prompt>|clear"]);
});

test("executeChatCommand assembles createCommandRuntime from the flat legacy deps bag and wires /usage correctly", async () => {
  const session = createChatSession({ systemPrompt: "" });
  session.sessionUsage.total_tokens = 42;
  const deps = buildExecuteChatCommandDeps();

  const result = await executeChatCommand(
    {
      line: "/usage",
      state: session,
      limitsByModel: {},
      mode: "tui",
      handlers: {}
    },
    deps
  );

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.equal(result.action?.screen, "panel");
  assert.deepEqual(result.action?.panelScreen?.lines, ["session=42", "model=smart-router"]);
});

test("executeChatCommand assembles createCommandRuntime from the flat legacy deps bag and wires /sync correctly", async () => {
  const session = createChatSession({ systemPrompt: "" });
  const messages = [];
  const deps = buildExecuteChatCommandDeps();

  const result = await executeChatCommand(
    {
      line: "/sync",
      state: session,
      limitsByModel: {},
      mode: "tui",
      handlers: { message: (text) => messages.push(text) },
      onSaveAndSync: async () => ({
        saveResult: { path: "/tmp/exec-sync.md", saved: true },
        syncResult: { syntheticModel: { status: "idle", backends: {} } },
        summary: "[chat] sync status=idle conflicts=0"
      })
    },
    deps
  );

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.match(messages.join("\n"), /exec-sync\.md/);
  assert.match(messages.join("\n"), /sync status=idle/i);
  assert.equal(result.action?.type, "refresh-sync-status");
  assert.equal(result.action?.syncStatus?.status, "idle");
});

test("executeChatCommand falls through unknown commands the same way createCommandRuntime does directly", async () => {
  const session = createChatSession({ systemPrompt: "" });
  const messages = [];
  const deps = buildExecuteChatCommandDeps();

  const result = await executeChatCommand(
    {
      line: "/nonexistent",
      state: session,
      limitsByModel: {},
      mode: "tui",
      handlers: { message: (text) => messages.push(text) }
    },
    deps
  );

  assert.equal(result.handled, true);
  assert.match(messages[0], /unknown command: \/nonexistent/i);
});
