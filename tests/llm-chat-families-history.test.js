import test from "node:test";
import assert from "node:assert/strict";
import { createHistoryCommandSpecs } from "../tools/llm-chat-cli/src/commands/families/history.js";

function createDeps(overrides = {}) {
  const calls = {
    clearHistoryFlowStack: [],
    setHistoryFlowDatesRoot: [],
    setHistoryFlowConversations: [],
    pushHistoryFlowDetail: [],
    accumulateSessionUsage: [],
    addUsageToLedger: []
  };
  const deps = {
    HISTORY_FLOW_PREVIEW: "preview",
    HISTORY_FLOW_SUMMARY: "summary",
    DEFAULT_GATEWAY_MODEL: "smart-router",
    DEFAULT_RAG_MAX_CHARS: 6000,
    clearHistoryFlowStack: (state) => calls.clearHistoryFlowStack.push(state),
    historyBackStep: () => ({ type: "none" }),
    createHistoryPanelState: (panel) => ({ ...panel }),
    createHistoryScreenAction: (panel) => ({
      type: "switch-screen",
      screen: "panel",
      panelScreen: panel
    }),
    resolveVaultPath: () => "/vault",
    createHistoryDateRows: () => [],
    formatHistoryDateLines: ({ rows }) => rows.map((row) => `date:${row.date}`),
    setHistoryFlowDatesRoot: (state, panel) => calls.setHistoryFlowDatesRoot.push({ state, panel }),
    parsePositiveIndex: () => null,
    normalizeHistoryDateInput: (value) => value,
    createHistoryRowsFromDateEntries: (entries) => entries,
    listTranscriptsForDate: () => [],
    formatHistoryConversationLines: ({ rows, title }) => [
      `title:${title}`,
      ...rows.map((row) => `row:${row.fileName || row.date || row.id || "?"}`)
    ],
    setHistoryFlowConversations: (state, payload) => calls.setHistoryFlowConversations.push({ state, payload }),
    createHistoryRowsFromSearchResults: (results) => results,
    isHistoryConversationsScreen: () => true,
    createHistoryConversationsOnlyMessage: (command) => `[History] ${command} only in conversations view.`,
    getHistoryRowFromSelection: () => null,
    captureRoutingFromTranscriptMetadata: () => null,
    usageFromTranscriptMetadata: () => ({ total_tokens: 0 }),
    buildGatewayOptions: () => ({ gatewayUrl: "http://fallback-gateway" }),
    formatRelativeTranscriptLabel: (path) => (path ? `label:${path}` : ""),
    buildHistoryContextText: () => "",
    asUsage: (usage) => usage || { total_tokens: 0 },
    accumulateSessionUsage: (session, usage) => {
      calls.accumulateSessionUsage.push({ session, usage });
      session.total_tokens = Number(session.total_tokens || 0) + Number(usage.total_tokens || 0);
    },
    addUsageToLedger: (args) => calls.addUsageToLedger.push(args),
    formatHistorySummaryLines: ({ row, summary }) => [`summary-for:${row.fileName}`, summary],
    pushHistoryFlowDetail: (state, detail) => calls.pushHistoryFlowDetail.push({ state, detail }),
    formatHistoryPreviewLines: ({ row }) => [`preview-for:${row.fileName}`],
    ...overrides
  };
  return { deps, calls };
}

function findSpec(specs, line) {
  const spec = specs.find((entry) => entry.match(line));
  assert.ok(spec, `no command spec matched "${line}"`);
  return spec;
}

async function withConsoleLog(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

test("/conv in plain mode prints conversation-mode text and clears history flow stack", async () => {
  const { deps, calls } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/conv");
  const state = { marker: "session-state" };

  const { result, lines } = await withConsoleLog(() => spec.run({ mode: "plain", state }));

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["[chat] conversation mode"]);
  assert.deepEqual(calls.clearHistoryFlowStack, [state]);
});

test("/back exits directly to conversation from sync screen in plain mode", async () => {
  const { deps } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/back");
  const state = { activeScreen: "sync" };

  const { result, lines } = await withConsoleLog(() => spec.run({ mode: "plain", state, handlers: {} }));

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["[chat] conversation mode"]);
});

test("/back reports unavailable when no active history flow", async () => {
  const { deps } = createDeps({ historyBackStep: () => ({ type: "none" }) });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/back");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: { activeScreen: "conversation" },
    handlers: { message: (text) => messages.push(text) }
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["[History] /back available only inside history flow."]);
});

test("/back exits conversation in plain mode when history stack signals exit-conversation", async () => {
  const { deps } = createDeps({ historyBackStep: () => ({ type: "exit-conversation" }) });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/back");

  const { result, lines } = await withConsoleLog(() =>
    spec.run({ mode: "plain", state: { activeScreen: "conversation" }, handlers: {} })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["[chat] conversation mode"]);
});

test("/back renders parent panel lines in plain mode", async () => {
  const { deps } = createDeps({
    historyBackStep: () => ({
      type: "panel",
      panel: { title: "History", lines: ["Row 1", "Row 2"] }
    })
  });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/back");

  const { result, lines } = await withConsoleLog(() =>
    spec.run({ mode: "plain", state: { activeScreen: "conversation" }, handlers: {} })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["Row 1", "Row 2"]);
});

test("/history in plain mode logs date lines and seeds the history flow root", async () => {
  const rows = [{ date: "2024-04-01" }, { date: "2024-04-02" }];
  const { deps, calls } = createDeps({ createHistoryDateRows: () => rows });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history");
  const state = {};

  const { result, lines } = await withConsoleLog(() => spec.run({ mode: "plain", state }));

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["date:2024-04-01", "date:2024-04-02"]);
  assert.deepEqual(state.historyDateRows, rows);
  assert.equal(state.historySelectedDate, null);
  assert.deepEqual(state.historyVisibleRows, []);
  assert.equal(calls.setHistoryFlowDatesRoot.length, 1);
  assert.deepEqual(calls.setHistoryFlowDatesRoot[0].panel.lines, lines);
});

test("/history date without a value reports usage", async () => {
  const { deps } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history date");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: {},
    parsed: spec.parse("/history date"),
    handlers: { message: (text) => messages.push(text) }
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["Usage : /history date <number|YYYY-MM-DD>"]);
});

test("/history date selects by normalized date value when no index matches", async () => {
  const dateRows = [{ date: "2024-05-01" }];
  const { deps, calls } = createDeps({
    createHistoryDateRows: () => dateRows,
    parsePositiveIndex: () => null,
    normalizeHistoryDateInput: (value) => value
  });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history date 2024-05-01");
  const state = {};

  const result = await spec.run({
    mode: "tui",
    state,
    parsed: spec.parse("/history date 2024-05-01"),
    handlers: {}
  });

  assert.equal(state.historySelectedDate, "2024-05-01");
  assert.deepEqual(state.historyVisibleRows, []);
  assert.equal(result.action.panelScreen.lines[0], "title:History conversations for 2024-05-01");
  assert.equal(calls.setHistoryFlowConversations.length, 1);
});

test("/history date reports not found for an unmatched input", async () => {
  const dateRows = [{ date: "2024-05-01" }];
  const { deps } = createDeps({
    createHistoryDateRows: () => dateRows,
    parsePositiveIndex: () => null,
    normalizeHistoryDateInput: (value) => value
  });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history date 2024-05-02");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: {},
    parsed: spec.parse("/history date 2024-05-02"),
    handlers: { message: (text) => messages.push(text) }
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["[History] Date not found : 2024-05-02"]);
});

test("/history date logs conversation lines in plain mode when selected by index", async () => {
  const dateRows = [{ date: "2024-05-01" }];
  const { deps } = createDeps({
    createHistoryDateRows: () => dateRows,
    parsePositiveIndex: (input) => (input === "1" ? 1 : null)
  });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history date 1");
  const state = {};

  const { result, lines } = await withConsoleLog(() =>
    spec.run({ mode: "plain", state, parsed: spec.parse("/history date 1"), handlers: {} })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["title:History conversations for 2024-05-01"]);
  assert.equal(state.historySelectedDate, "2024-05-01");
});

test("/history search without a query reports usage", async () => {
  const { deps } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history search");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: {},
    parsed: spec.parse("/history search"),
    handlers: { message: (text) => messages.push(text) }
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["Usage : /history search <query>"]);
});

test("/history search logs conversation lines in plain mode and updates flow state", async () => {
  const { deps, calls } = createDeps({ createHistoryDateRows: () => [{ date: "2024-05-01" }] });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history search hello");
  const state = {};
  const historySearchRunner = async ({ query, includeGlobs }) => {
    assert.equal(query, "hello");
    assert.deepEqual(includeGlobs, ["AI Chats/**/*.md"]);
    return { results: [{ id: "a" }], rebuilt: false };
  };

  const { result, lines } = await withConsoleLog(() =>
    spec.run({
      mode: "plain",
      state,
      parsed: spec.parse("/history search hello"),
      handlers: {},
      historySearchRunner
    })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["title:History search : hello", "row:a"]);
  assert.deepEqual(state.historyVisibleRows, [{ id: "a" }]);
  assert.equal(state.historySelectedDate, null);
  assert.equal(calls.setHistoryFlowConversations.length, 1);
});

test("/history switch reports usage when no row is selected", async () => {
  const { deps } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history switch 9");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: {},
    parsed: spec.parse("/history switch 9"),
    handlers: { message: (text) => messages.push(text) }
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["Usage : /history switch <number> (pick from current history table)"]);
});

test("/history switch manually reconstructs active transcript when loadTranscriptIntoSession is unavailable", async () => {
  const row = {
    transcriptPath: "/vault/chats/2024-05-01/session.md",
    fileName: "session.md",
    relativePath: "AI Chats/2024-05-01/session.md"
  };
  const transcript = {
    messages: [{ role: "user", content: "hi" }],
    metadata: {
      conversation_prompt: "Speak like a pirate.",
      id: "transcript-1",
      created_at: "2024-05-01T10:00:00.000Z",
      gateway_url: "http://gateway.local",
      model: "smart-router-code"
    }
  };
  const loadedRouting = {
    displayModel: "qwen3.5:9b",
    modelLocation: "local",
    targetModel: "ollama/qwen3.5:9b"
  };
  const { deps, calls } = createDeps({
    getHistoryRowFromSelection: () => row,
    captureRoutingFromTranscriptMetadata: () => loadedRouting
  });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history switch 1");
  const state = {
    history: [],
    activeTranscript: null,
    sessionId: "session-fallback",
    sessionStartedAt: "2024-01-01T00:00:00.000Z",
    latestRouting: null,
    activeConversationPrompt: "",
    transcriptSavedPath: null,
    lastSavedHistoryLength: 0,
    lastSavedConversationPrompt: "",
    sessionUsage: {},
    estimatedTokensRef: { value: 0 },
    addedContextEntries: ["stale-context"]
  };
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state,
    parsed: spec.parse("/history switch 1"),
    handlers: { message: (text) => messages.push(text) },
    onSaveAndSync: async () => ({
      saveResult: { path: "/tmp/saved.md", saved: true },
      summary: "[chat] sync status=idle conflicts=0"
    }),
    transcriptReader: () => transcript
  });

  assert.deepEqual(state.history, transcript.messages);
  assert.equal(state.activeTranscript.path, row.transcriptPath);
  assert.equal(state.activeTranscript.id, "transcript-1");
  assert.equal(state.activeTranscript.createdAt, "2024-05-01T10:00:00.000Z");
  assert.equal(state.activeTranscript.gatewayUrl, "http://gateway.local");
  assert.equal(state.activeTranscript.model, "smart-router-code");
  assert.equal(state.activeTranscript.conversationPrompt, "Speak like a pirate.");
  assert.equal(state.latestRouting, loadedRouting);
  assert.equal(state.activeConversationPrompt, "Speak like a pirate.");
  assert.equal(state.transcriptSavedPath, row.transcriptPath);
  assert.equal(state.lastSavedHistoryLength, 1);
  assert.equal(state.lastSavedConversationPrompt, "Speak like a pirate.");
  assert.deepEqual(state.sessionUsage, { total_tokens: 0 });
  assert.equal(state.estimatedTokensRef.value, 0);
  assert.deepEqual(state.addedContextEntries, []);
  assert.deepEqual(calls.clearHistoryFlowStack, [state]);
  assert.equal(messages[0], "[chat] transcript saved: /tmp/saved.md");
  assert.equal(messages[2], "[History] Switched to : label:AI Chats/2024-05-01/session.md");
  assert.equal(result.action.type, "switch-screen");
  assert.equal(result.action.screen, "conversation");
  assert.deepEqual(result.action.historyLoaded.history, transcript.messages);
});

test("/history switch logs transcript summary lines in plain mode", async () => {
  const row = {
    transcriptPath: "/vault/chats/2024-05-01/other.md",
    fileName: "other.md",
    relativePath: "AI Chats/2024-05-01/other.md"
  };
  const transcript = { messages: [], metadata: {} };
  const { deps } = createDeps({ getHistoryRowFromSelection: () => row });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history switch 1");
  const state = {
    history: [],
    sessionId: "sess",
    sessionStartedAt: "t0",
    latestRouting: null,
    activeConversationPrompt: "",
    sessionUsage: {},
    estimatedTokensRef: { value: 0 },
    addedContextEntries: []
  };

  const { result, lines } = await withConsoleLog(() =>
    spec.run({
      mode: "plain",
      state,
      parsed: spec.parse("/history switch 1"),
      handlers: {},
      onSaveAndSync: async () => ({
        saveResult: { path: "/tmp/other.md", saved: false },
        summary: "[chat] sync status=idle conflicts=0"
      }),
      transcriptReader: () => transcript
    })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, [
    "[chat] transcript already up to date",
    "[chat] sync status=idle conflicts=0",
    "[History] Switched to : label:AI Chats/2024-05-01/other.md"
  ]);
});

test("/history add_context reports usage when no row is selected", async () => {
  const { deps } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history add_context 3");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: {},
    parsed: spec.parse("/history add_context 3"),
    handlers: { message: (text) => messages.push(text) },
    transcriptReader: () => ({})
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["Usage : /history add_context <number> (pick from current history table)"]);
});

test("/history add_context reports when no usable messages are found", async () => {
  const row = { transcriptPath: "/vault/x.md", fileName: "x.md", relativePath: "AI Chats/x.md" };
  const { deps } = createDeps({
    getHistoryRowFromSelection: () => row,
    buildHistoryContextText: () => ""
  });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history add_context 1");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: { addedContextEntries: [] },
    parsed: spec.parse("/history add_context 1"),
    handlers: { message: (text) => messages.push(text) },
    transcriptReader: () => ({})
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["[History] No usable messages in x.md"]);
});

test("/history summary reports usage when no row is selected", async () => {
  const { deps } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history summary 1");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: {},
    parsed: spec.parse("/history summary 1"),
    handlers: { message: (text) => messages.push(text) },
    transcriptMarkdownReader: () => "",
    historySummaryRunner: async () => ({})
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["Usage : /history summary <number> (pick from current history table)"]);
});

test("/history summary logs summary lines in plain mode and records usage", async () => {
  const row = { transcriptPath: "/vault/conv.md", fileName: "conv.md", relativePath: "AI Chats/conv.md" };
  const { deps, calls } = createDeps({ getHistoryRowFromSelection: () => row });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history summary 1");
  const state = {
    sessionUsage: { total_tokens: 0 },
    estimatedTokensRef: { value: 0 },
    latestRouting: null
  };

  const { result, lines } = await withConsoleLog(() =>
    spec.run({
      mode: "plain",
      state,
      parsed: spec.parse("/history summary 1"),
      handlers: {},
      transcriptMarkdownReader: () => "# transcript",
      historySummaryRunner: async () => ({
        summary: "Short summary text.",
        usage: { total_tokens: 5 },
        routing: { lane: "code" }
      })
    })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["summary-for:conv.md", "Short summary text."]);
  assert.deepEqual(state.latestRouting, { lane: "code" });
  assert.equal(state.sessionUsage.total_tokens, 5);
  assert.equal(state.estimatedTokensRef.value, 5);
  assert.equal(calls.accumulateSessionUsage.length, 1);
  assert.equal(calls.addUsageToLedger.length, 1);
  assert.equal(calls.addUsageToLedger[0].modelName, "smart-router");
  assert.equal(calls.pushHistoryFlowDetail.length, 1);
  assert.equal(calls.pushHistoryFlowDetail[0].detail.screen, "summary");
});

test("/history preview reports usage when no row is selected", async () => {
  const { deps } = createDeps();
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history preview 1");
  const messages = [];

  const result = await spec.run({
    mode: "tui",
    state: {},
    parsed: spec.parse("/history preview 1"),
    handlers: { message: (text) => messages.push(text) },
    transcriptMarkdownReader: () => ""
  });

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(messages, ["Usage : /history preview <number> (pick from current history table)"]);
});

test("/history preview logs preview lines in plain mode and pushes flow detail", async () => {
  const row = { transcriptPath: "/vault/preview.md", fileName: "preview.md", relativePath: "AI Chats/preview.md" };
  const { deps, calls } = createDeps({ getHistoryRowFromSelection: () => row });
  const specs = createHistoryCommandSpecs(deps);
  const spec = findSpec(specs, "/history preview 1");

  const { result, lines } = await withConsoleLog(() =>
    spec.run({
      mode: "plain",
      state: {},
      parsed: spec.parse("/history preview 1"),
      handlers: {},
      transcriptMarkdownReader: () => "# transcript body"
    })
  );

  assert.deepEqual(result, { handled: true, exit: false });
  assert.deepEqual(lines, ["preview-for:preview.md"]);
  assert.equal(calls.pushHistoryFlowDetail.length, 1);
  assert.equal(calls.pushHistoryFlowDetail[0].detail.screen, "preview");
  assert.equal(calls.pushHistoryFlowDetail[0].detail.panel.previewMode, true);
});
