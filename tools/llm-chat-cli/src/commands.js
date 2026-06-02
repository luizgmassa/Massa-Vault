const CHAT_COMMAND_DEFINITIONS = Object.freeze([
  {
    command: "/sync",
    description: "Save transcript (if needed) and trigger sync"
  },
  {
    command: "/sync status",
    description: "Open live sync status screen (TUI) / print JSON status (plain)"
  },
  {
    command: "/sync conflicts",
    description: "Show sync conflict details"
  },
  {
    command: "/conv",
    description: "Return from sync status screen to conversation (TUI)"
  },
  {
    command: "/back",
    description: "Back in history flow (preview/summary -> conversations -> dates -> conversation)"
  },
  {
    command: "/history",
    description: "Open history screen with transcript dates"
  },
  {
    command: "/history date",
    description: "Show conversation rows for date number or YYYY-MM-DD",
    requiresInput: true
  },
  {
    command: "/history search",
    description: "Semantic search only in AI Chats transcripts",
    requiresInput: true
  },
  {
    command: "/history switch",
    description: "Switch active conversation to selected history row",
    requiresInput: true
  },
  {
    command: "/history add_context",
    description: "Inject selected history conversation into next prompt",
    requiresInput: true
  },
  {
    command: "/history summary",
    description: "Generate short LLM summary for selected history row",
    requiresInput: true
  },
  {
    command: "/history preview",
    description: "Open full transcript preview for selected history row",
    requiresInput: true
  },
  {
    command: "/exit",
    description: "Save transcript and exit"
  },
  {
    command: "/clear",
    description: "Clear conversation memory"
  },
  {
    command: "/usage",
    description: "Show token counters and quota estimates"
  },
  {
    command: "/config",
    description: "Show active gateway/system settings"
  },
  {
    command: "/system show",
    description: "Show system prompt"
  },
  {
    command: "/system set",
    description: "Set system prompt",
    requiresInput: true
  },
  {
    command: "/system clear",
    description: "Clear system prompt"
  },
  {
    command: "/routing",
    description: "Show latest router metadata"
  },
  {
    command: "/search",
    description: "Semantic search in chats + vault markdown",
    requiresInput: true
  }
]);

function startsWithCommand(line, command) {
  return line === command || line.startsWith(`${command} `);
}

function commandMeta(command) {
  return CHAT_COMMAND_DEFINITIONS.find((definition) => definition.command === command) || {
    command,
    description: ""
  };
}

function createCommandSpec(command, run, { requiresInput = false } = {}) {
  return {
    ...commandMeta(command),
    requiresInput,
    match: (line) => (requiresInput ? startsWithCommand(line, command) : line === command),
    parse: (line) =>
      requiresInput
        ? { value: line.slice(command.length).trim() }
        : { value: "" },
    run
  };
}

function writeMessage(mode, handlers, text) {
  if (mode === "plain") {
    console.log(text);
  } else {
    handlers.message(text);
  }
}

function writeLines(mode, handlers, title, lines) {
  if (mode === "plain") {
    for (const line of lines) {
      console.log(line);
    }
  } else {
    handlers.panel(title, lines);
  }
}

function renderCommands(mode, handlers) {
  const commandLines = getCommandPanelLines();
  if (mode === "plain") {
    console.log("Commands:");
    for (const commandLine of commandLines) {
      console.log(`  ${commandLine}`);
    }
  } else {
    handlers.panel("commands", commandLines);
  }
  return { handled: true, exit: false };
}

function createHistorySelectionUsage(command) {
  return `Usage : ${command} <number> (pick from current history table)`;
}

function createCommandSpecs(deps) {
  const {
    HISTORY_FLOW_PREVIEW,
    HISTORY_FLOW_SUMMARY,
    DEFAULT_GATEWAY_MODEL,
    DEFAULT_RAG_MAX_CHARS,
    VAULT_CONTEXT_MODES
  } = deps;

  return [
    {
      match: (line) => line === "/",
      parse: () => ({}),
      run: ({ mode, handlers }) => renderCommands(mode, handlers)
    },
    createCommandSpec("/exit", async () => ({ handled: true, exit: true })),
    createCommandSpec("/conv", async ({ mode, state }) => {
      deps.clearHistoryFlowStack(state);
      if (mode === "plain") {
        console.log("[chat] conversation mode");
        return { handled: true, exit: false };
      }
      return {
        handled: true,
        exit: false,
        action: {
          type: "switch-screen",
          screen: "conversation"
        }
      };
    }),
    createCommandSpec("/back", async ({ mode, handlers, state }) => {
      const back = deps.historyBackStep(state);
      if (back.type === "none") {
        writeMessage(mode, handlers, "[History] /back available only inside history flow.");
        return { handled: true, exit: false };
      }
      if (back.type === "exit-conversation") {
        if (mode === "plain") {
          console.log("[chat] conversation mode");
          return { handled: true, exit: false };
        }
        return {
          handled: true,
          exit: false,
          action: {
            type: "switch-screen",
            screen: "conversation"
          }
        };
      }
      const panel = deps.createHistoryPanelState(back.panel);
      if (mode === "plain") {
        for (const historyLine of panel.lines) {
          console.log(historyLine);
        }
        return { handled: true, exit: false };
      }
      return {
        handled: true,
        exit: false,
        action: deps.createHistoryScreenAction(panel)
      };
    }),
    createCommandSpec("/history", async ({ mode, state }) => {
      const vaultPath = deps.resolveVaultPath();
      const rows = deps.createHistoryDateRows(vaultPath);
      state.historyDateRows = rows;
      state.historySelectedDate = null;
      state.historyVisibleRows = [];
      const historyLines = deps.formatHistoryDateLines({ rows });
      deps.setHistoryFlowDatesRoot(
        state,
        deps.createHistoryPanelState({
          title: "History",
          lines: historyLines
        })
      );
      if (mode === "plain") {
        for (const historyLine of historyLines) {
          console.log(historyLine);
        }
        return { handled: true, exit: false };
      }
      return {
        handled: true,
        exit: false,
        action: deps.createHistoryScreenAction({
          title: "History",
          lines: historyLines
        })
      };
    }),
    createCommandSpec(
      "/history date",
      async ({ mode, handlers, state, parsed }) => {
        const rawInput = parsed.value;
        if (!rawInput) {
          writeMessage(mode, handlers, "Usage : /history date <number|YYYY-MM-DD>");
          return { handled: true, exit: false };
        }

        const vaultPath = deps.resolveVaultPath();
        const dateRows = deps.createHistoryDateRows(vaultPath);
        const dates = dateRows.map((row) => row.date);
        state.historyDateRows = dateRows;
        const selectedByIndex = deps.parsePositiveIndex(rawInput);
        const selectedByValue = deps.normalizeHistoryDateInput(rawInput);
        let selectedDate = "";
        if (selectedByIndex) {
          selectedDate = dateRows[selectedByIndex - 1]?.date || "";
        } else if (selectedByValue && dates.includes(selectedByValue)) {
          selectedDate = selectedByValue;
        }

        if (!selectedDate) {
          writeMessage(mode, handlers, `[History] Date not found : ${rawInput}`);
          return { handled: true, exit: false };
        }

        const rows = deps.createHistoryRowsFromDateEntries(
          deps.listTranscriptsForDate(vaultPath, selectedDate)
        );
        state.historySelectedDate = selectedDate;
        state.historyVisibleRows = rows;
        const historyLines = deps.formatHistoryConversationLines({
          rows,
          title: `History conversations for ${selectedDate}`
        });
        deps.setHistoryFlowConversations(state, {
          datePanel: deps.createHistoryPanelState({
            title: "History",
            lines: deps.formatHistoryDateLines({ rows: dateRows })
          }),
          conversationsPanel: deps.createHistoryPanelState({
            title: "History",
            lines: historyLines
          })
        });

        if (mode === "plain") {
          for (const historyLine of historyLines) {
            console.log(historyLine);
          }
          return { handled: true, exit: false };
        }

        return {
          handled: true,
          exit: false,
          action: deps.createHistoryScreenAction({
            title: "History",
            lines: historyLines
          })
        };
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/history search",
      async ({ mode, handlers, state, parsed, historySearchRunner }) => {
        const query = parsed.value;
        if (!query) {
          writeMessage(mode, handlers, "Usage : /history search <query>");
          return { handled: true, exit: false };
        }

        const vaultPath = deps.resolveVaultPath();
        const dateRows = deps.createHistoryDateRows(vaultPath);
        state.historyDateRows = dateRows;
        const result = await historySearchRunner({
          query,
          includeGlobs: ["AI Chats/**/*.md"]
        });
        const rows = deps.createHistoryRowsFromSearchResults(result.results, vaultPath);
        state.historySelectedDate = null;
        state.historyVisibleRows = rows;
        const historyLines = deps.formatHistoryConversationLines({
          rows,
          title: `History search : ${query}`,
          includeScore: true
        });
        if (result.rebuilt) {
          historyLines.splice(2, 0, "Index rebuilt.", "");
        }
        deps.setHistoryFlowConversations(state, {
          datePanel: deps.createHistoryPanelState({
            title: "History",
            lines: deps.formatHistoryDateLines({ rows: dateRows })
          }),
          conversationsPanel: deps.createHistoryPanelState({
            title: "History",
            lines: historyLines
          })
        });

        if (mode === "plain") {
          for (const historyLine of historyLines) {
            console.log(historyLine);
          }
          return { handled: true, exit: false };
        }

        return {
          handled: true,
          exit: false,
          action: deps.createHistoryScreenAction({
            title: "History",
            lines: historyLines
          })
        };
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/history switch",
      async ({ mode, handlers, state, parsed, onSaveAndSync, transcriptReader }) => {
        if (!deps.isHistoryConversationsScreen(state)) {
          writeMessage(mode, handlers, deps.createHistoryConversationsOnlyMessage("/history switch"));
          return { handled: true, exit: false };
        }
        const row = deps.getHistoryRowFromSelection(state, parsed.value);
        if (!row) {
          writeMessage(mode, handlers, createHistorySelectionUsage("/history switch"));
          return { handled: true, exit: false };
        }

        const result = await onSaveAndSync(state, {
          reason: "chat-history-switch"
        });
        const transcript = transcriptReader(row.transcriptPath);
        const metadata = transcript.metadata || {};
        const loadedRouting = deps.captureRoutingFromTranscriptMetadata(metadata);
        if (typeof deps.loadTranscriptIntoSession === "function") {
          deps.loadTranscriptIntoSession(state, {
            transcriptPath: row.transcriptPath,
            transcript,
            metadata,
            routing: loadedRouting,
            usage: deps.usageFromTranscriptMetadata(metadata)
          });
        } else {
          state.history = Array.isArray(transcript.messages) ? [...transcript.messages] : [];
          state.activeTranscript = {
            path: row.transcriptPath,
            id: String(metadata.id || "").trim() || state.sessionId,
            createdAt: String(metadata.created_at || "").trim() || state.sessionStartedAt,
            gatewayUrl: String(metadata.gateway_url || "").trim() || deps.buildGatewayOptions().gatewayUrl,
            model: String(metadata.model || "").trim() || DEFAULT_GATEWAY_MODEL,
            routing: loadedRouting
          };
          state.latestRouting = state.activeTranscript.routing;
          state.transcriptSavedPath = row.transcriptPath;
          state.lastSavedHistoryLength = state.history.length;
          state.sessionUsage = deps.usageFromTranscriptMetadata(metadata);
          state.estimatedTokensRef.value = Number(state.sessionUsage.total_tokens || 0);
          state.addedContextEntries = [];
          deps.clearHistoryFlowStack(state);
        }

        const switchSummary = `[History] Switched to : ${
          deps.formatRelativeTranscriptLabel(row.relativePath) || row.fileName
        }`;
        const transcriptMessage = result.saveResult.path
          ? result.saveResult.saved
            ? `[chat] transcript saved: ${result.saveResult.path}`
            : "[chat] transcript already up to date"
          : "[chat] nothing to save";
        if (mode === "plain") {
          console.log(transcriptMessage);
          console.log(result.summary);
          console.log(switchSummary);
          return { handled: true, exit: false };
        }

        handlers.message(transcriptMessage);
        handlers.message(result.summary);
        handlers.message(switchSummary);
        return {
          handled: true,
          exit: false,
          action: {
            type: "switch-screen",
            screen: "conversation",
            historyLoaded: {
              history: [...state.history]
            }
          }
        };
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/history add_context",
      async ({ mode, handlers, state, parsed, transcriptReader }) => {
        if (!deps.isHistoryConversationsScreen(state)) {
          writeMessage(mode, handlers, deps.createHistoryConversationsOnlyMessage("/history add_context"));
          return { handled: true, exit: false };
        }
        const row = deps.getHistoryRowFromSelection(state, parsed.value);
        if (!row) {
          writeMessage(mode, handlers, createHistorySelectionUsage("/history add_context"));
          return { handled: true, exit: false };
        }

        const transcript = transcriptReader(row.transcriptPath);
        const content = deps.buildHistoryContextText({
          row,
          transcript,
          maxChars: DEFAULT_RAG_MAX_CHARS
        });
        if (!content) {
          writeMessage(mode, handlers, `[History] No usable messages in ${row.fileName}`);
          return { handled: true, exit: false };
        }

        state.addedContextEntries = [
          ...state.addedContextEntries,
          {
            source: row.relativePath,
            content
          }
        ];
        writeMessage(
          mode,
          handlers,
          `[History] Added context from ${
            deps.formatRelativeTranscriptLabel(row.relativePath) || row.fileName
          } for next prompt.`
        );
        return { handled: true, exit: false };
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/history summary",
      async ({ mode, handlers, state, parsed, transcriptMarkdownReader, historySummaryRunner }) => {
        if (!deps.isHistoryConversationsScreen(state)) {
          writeMessage(mode, handlers, deps.createHistoryConversationsOnlyMessage("/history summary"));
          return { handled: true, exit: false };
        }
        const row = deps.getHistoryRowFromSelection(state, parsed.value);
        if (!row) {
          writeMessage(mode, handlers, createHistorySelectionUsage("/history summary"));
          return { handled: true, exit: false };
        }

        const transcriptMarkdown = transcriptMarkdownReader(row.transcriptPath);
        const summaryResult = await historySummaryRunner({
          row,
          transcriptPath: row.transcriptPath,
          transcriptMarkdown
        });
        const summaryText = String(summaryResult?.summary || "").trim() || "No summary generated.";
        const summaryUsage = deps.asUsage(summaryResult?.usage || null);
        if (summaryUsage.total_tokens > 0) {
          deps.accumulateSessionUsage(state.sessionUsage, summaryUsage);
          deps.addUsageToLedger({
            usage: summaryUsage,
            modelName: summaryResult?.routing?.targetModel || DEFAULT_GATEWAY_MODEL
          });
          state.estimatedTokensRef.value = Number(state.sessionUsage.total_tokens || 0);
        }

        const historyLines = deps.formatHistorySummaryLines({
          row,
          summary: summaryText
        });
        deps.pushHistoryFlowDetail(state, {
          screen: HISTORY_FLOW_SUMMARY,
          panel: deps.createHistoryPanelState({
            title: "History summary",
            lines: historyLines
          })
        });
        if (mode === "plain") {
          for (const historyLine of historyLines) {
            console.log(historyLine);
          }
          return { handled: true, exit: false };
        }
        return {
          handled: true,
          exit: false,
          action: deps.createHistoryScreenAction({
            title: "History summary",
            lines: historyLines
          })
        };
      },
      { requiresInput: true }
    ),
    createCommandSpec(
      "/history preview",
      async ({ mode, handlers, state, parsed, transcriptMarkdownReader }) => {
        if (!deps.isHistoryConversationsScreen(state)) {
          writeMessage(mode, handlers, deps.createHistoryConversationsOnlyMessage("/history preview"));
          return { handled: true, exit: false };
        }
        const row = deps.getHistoryRowFromSelection(state, parsed.value);
        if (!row) {
          writeMessage(mode, handlers, createHistorySelectionUsage("/history preview"));
          return { handled: true, exit: false };
        }

        const transcriptMarkdown = transcriptMarkdownReader(row.transcriptPath);
        const historyLines = deps.formatHistoryPreviewLines({ row, transcriptMarkdown });
        deps.pushHistoryFlowDetail(state, {
          screen: HISTORY_FLOW_PREVIEW,
          panel: deps.createHistoryPanelState({
            title: "History preview",
            lines: historyLines,
            scrollable: true,
            previewMode: true
          })
        });
        if (mode === "plain") {
          for (const historyLine of historyLines) {
            console.log(historyLine);
          }
          return { handled: true, exit: false };
        }
        return {
          handled: true,
          exit: false,
          action: deps.createHistoryScreenAction({
            title: "History preview",
            lines: historyLines,
            scrollable: true,
            previewMode: true
          })
        };
      },
      { requiresInput: true }
    ),
    createCommandSpec("/sync", async ({ mode, handlers, state, onSaveAndSync }) => {
      const result = await onSaveAndSync(state, { reason: "chat-manual-sync" });
      const transcriptMessage = result.saveResult.path
        ? `[chat] transcript saved: ${result.saveResult.path}`
        : "[chat] transcript already up to date";
      writeMessage(mode, handlers, transcriptMessage);
      writeMessage(mode, handlers, result.summary);
      return { handled: true, exit: false };
    }),
    createCommandSpec(
      "/sync status",
      async ({ mode, handlers }) => {
        if (mode !== "plain") {
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "sync",
              syncStatus: deps.readLocalSyncStatusModel()
            }
          };
        }
        const result = deps.runNotesAutomationCommand(["status"]);
        const summary = deps.formatSyncFeedback(result);
        console.log(summary);
        if (result.output) {
          console.log(result.output);
        }
        return { handled: true, exit: false };
      }
    ),
    createCommandSpec("/sync conflicts", async ({ mode, handlers }) => {
      const result = deps.runNotesAutomationCommand(["sync-conflicts"]);
      const summary = deps.formatSyncFeedback(result);
      writeMessage(mode, handlers, summary);
      if (result.output) {
        if (mode === "plain") {
          console.log(result.output);
        } else {
          handlers.panel("sync", result.output.split("\n"));
        }
      }
      return { handled: true, exit: false };
    }),
    createCommandSpec("/clear", async ({ mode, handlers, state }) => {
      deps.resetConversation(state);
      writeMessage(mode, handlers, "[chat] conversation cleared");
      return { handled: true, exit: false };
    }),
    createCommandSpec("/usage", async ({ mode, handlers, state, limitsByModel }) => {
      if (mode === "plain") {
        deps.printUsageSummary({
          sessionUsage: state.sessionUsage,
          estimatedTokens: state.estimatedTokensRef.value,
          routing: state.latestRouting,
          limitsByModel
        });
      } else {
        const summary = deps.createUsageSummary({
          sessionUsage: state.sessionUsage,
          estimatedTokens: state.estimatedTokensRef.value,
          routing: state.latestRouting,
          limitsByModel
        });
        handlers.panel("usage", deps.formatUsagePanel(summary));
      }
      return { handled: true, exit: false };
    }),
    createCommandSpec("/config", async ({ mode, handlers, state }) => {
      const gateway = deps.buildGatewayOptions();
      const lines = [
        `gateway_url: ${gateway.gatewayUrl}`,
        `system_prompt: ${state.activeSystemPrompt ? "configured" : "empty"}`,
        `auth_header: ${gateway.apiKey ? "enabled" : "disabled"}`,
        `vault_context: ${deps.isVaultContextEnabled() ? "auto" : "disabled"}`,
        `vault_context_modes: ${VAULT_CONTEXT_MODES.join(", ")}`
      ];
      writeLines(mode, handlers, "config", lines);
      return { handled: true, exit: false };
    }),
    createCommandSpec("/system show", async ({ mode, handlers, state }) => {
      writeLines(mode, handlers, "system", [state.activeSystemPrompt || "[empty]"]);
      return { handled: true, exit: false };
    }),
    createCommandSpec(
      "/system set",
      async ({ mode, handlers, state, parsed }) => {
        state.activeSystemPrompt = parsed.value;
        writeMessage(mode, handlers, "[chat] system prompt updated");
        return { handled: true, exit: false };
      },
      { requiresInput: true }
    ),
    createCommandSpec("/system clear", async ({ mode, handlers, state }) => {
      state.activeSystemPrompt = "";
      writeMessage(mode, handlers, "[chat] system prompt cleared");
      return { handled: true, exit: false };
    }),
    createCommandSpec("/routing", async ({ mode, handlers, state }) => {
      if (!state.latestRouting) {
        writeMessage(mode, handlers, "[chat] no routing metadata yet");
        return { handled: true, exit: false };
      }
      const lines = JSON.stringify(state.latestRouting, null, 2).split("\n");
      writeLines(mode, handlers, "routing", lines);
      return { handled: true, exit: false };
    }),
    createCommandSpec(
      "/search",
      async ({ mode, handlers, parsed, historySearchRunner }) => {
        if (!parsed.value) {
          writeMessage(mode, handlers, "Usage : /search <query>");
          return { handled: true, exit: false };
        }
        const searchResult = await historySearchRunner({ query: parsed.value });
        if (mode === "plain") {
          deps.printSearchPlain(searchResult);
        } else {
          handlers.panel("search", deps.formatSearchPanel(searchResult));
        }
        return { handled: true, exit: false };
      },
      { requiresInput: true }
    )
  ];
}

export function getCommandDefinitions() {
  return CHAT_COMMAND_DEFINITIONS;
}

export function getCommandSuggestions(inputValue, definitions = CHAT_COMMAND_DEFINITIONS) {
  const normalized = String(inputValue || "").trim().toLowerCase();
  if (!normalized.startsWith("/")) return [];
  return definitions.filter((definition) => definition.command.startsWith(normalized));
}

export function completeCommandInput(inputValue, definitions = CHAT_COMMAND_DEFINITIONS) {
  const suggestions = getCommandSuggestions(inputValue, definitions);
  if (suggestions.length !== 1) return String(inputValue || "");
  const selected = suggestions[0];
  return selected.requiresInput ? `${selected.command} ` : selected.command;
}

export function resolveCommandSubmission(definition) {
  const command = String(definition?.command || "").trim();
  if (!command) return null;
  if (definition?.requiresInput) {
    return { mode: "fill", line: `${command} ` };
  }
  return { mode: "submit", line: command };
}

export function getCommandPanelLines(definitions = CHAT_COMMAND_DEFINITIONS) {
  const commandLabel = (definition) => (definition.requiresInput ? `${definition.command} ...` : definition.command);
  const width = definitions.reduce((max, definition) => Math.max(max, commandLabel(definition).length), 0);
  return definitions.map(
    (definition) => `${commandLabel(definition).padEnd(width)}  ${definition.description}`
  );
}

export function createCommandRuntime({
  config = {},
  syncClient = {},
  historyClient = {},
  usageClient = {},
  searchClient = {},
  sessionClient = {}
} = {}) {
  const deps = {
    HISTORY_FLOW_PREVIEW: config.historyFlowPreview,
    HISTORY_FLOW_SUMMARY: config.historyFlowSummary,
    DEFAULT_GATEWAY_MODEL: config.defaultGatewayModel,
    DEFAULT_RAG_MAX_CHARS: config.defaultRagMaxChars,
    VAULT_CONTEXT_MODES: config.vaultContextModes,
    isVaultContextEnabled: config.isVaultContextEnabled,
    addUsageToLedger: usageClient.addUsageToLedger,
    accumulateSessionUsage: usageClient.accumulateSessionUsage,
    asUsage: usageClient.asUsage,
    buildGatewayOptions: historyClient.buildGatewayOptions,
    buildHistoryContextText: historyClient.buildHistoryContextText,
    captureRoutingFromTranscriptMetadata: historyClient.captureRoutingFromTranscriptMetadata,
    clearHistoryFlowStack: historyClient.clearHistoryFlowStack,
    createHistoryConversationsOnlyMessage: historyClient.createHistoryConversationsOnlyMessage,
    createHistoryDateRows: historyClient.createHistoryDateRows,
    createHistoryPanelState: historyClient.createHistoryPanelState,
    createHistoryRowsFromDateEntries: historyClient.createHistoryRowsFromDateEntries,
    createHistoryRowsFromSearchResults: historyClient.createHistoryRowsFromSearchResults,
    createHistoryScreenAction: historyClient.createHistoryScreenAction,
    createUsageSummary: usageClient.createUsageSummary,
    formatHistoryConversationLines: historyClient.formatHistoryConversationLines,
    formatHistoryDateLines: historyClient.formatHistoryDateLines,
    formatHistoryPreviewLines: historyClient.formatHistoryPreviewLines,
    formatHistorySummaryLines: historyClient.formatHistorySummaryLines,
    formatRelativeTranscriptLabel: historyClient.formatRelativeTranscriptLabel,
    formatSearchPanel: searchClient.formatSearchPanel,
    formatSyncFeedback: syncClient.formatSyncFeedback,
    formatUsagePanel: usageClient.formatUsagePanel,
    getHistoryRowFromSelection: historyClient.getHistoryRowFromSelection,
    historyBackStep: historyClient.historyBackStep,
    isHistoryConversationsScreen: historyClient.isHistoryConversationsScreen,
    listTranscriptsForDate: historyClient.listTranscriptsForDate,
    loadTranscriptIntoSession: sessionClient.loadTranscript,
    normalizeHistoryDateInput: historyClient.normalizeHistoryDateInput,
    normalizeHistoryInputShortcut: historyClient.normalizeHistoryInputShortcut,
    parseHistoryConversationAlias: historyClient.parseHistoryConversationAlias,
    parsePositiveIndex: historyClient.parsePositiveIndex,
    printSearchPlain: searchClient.printSearchPlain,
    printUsageSummary: usageClient.printUsageSummary,
    pushHistoryFlowDetail: historyClient.pushHistoryFlowDetail,
    readLocalSyncStatusModel: syncClient.readLocalSyncStatusModel,
    resetConversation: sessionClient.resetSession,
    resolveVaultPath: historyClient.resolveVaultPath,
    runNotesAutomationCommand: syncClient.runNotesAutomationCommand,
    setHistoryFlowConversations: historyClient.setHistoryFlowConversations,
    setHistoryFlowDatesRoot: historyClient.setHistoryFlowDatesRoot,
    usageFromTranscriptMetadata: historyClient.usageFromTranscriptMetadata
  };

  return {
    async execute({
      line,
      session,
      limitsByModel,
      mode = "plain",
      io = {},
      onSaveAndSync = syncClient.saveAndSync,
      historySearchRunner = historyClient.searchRunner,
      transcriptReader = historyClient.transcriptReader,
      transcriptMarkdownReader = historyClient.transcriptMarkdownReader,
      historySummaryRunner = historyClient.summaryRunner
    }) {
      const tuiHandlers = {
        panel(title, lines) {
          if (io?.panel) io.panel(title, lines);
        },
        message(text) {
          if (io?.message) io.message(text);
        }
      };
      const typedLine = String(line || "").trim();
      const alias = deps.parseHistoryConversationAlias(typedLine);
      if (alias && !deps.isHistoryConversationsScreen(session)) {
        writeMessage(mode, tuiHandlers, deps.createHistoryConversationsOnlyMessage(alias.alias));
        return { handled: true, exit: false };
      }
      const normalizedLine = deps.normalizeHistoryInputShortcut(typedLine, session);
      const registry = createCommandSpecs(deps);
      const matched = registry.find((entry) => entry.match(normalizedLine));
      if (!matched) {
        if (normalizedLine.startsWith("/sync ")) {
          writeMessage(mode, tuiHandlers, "usage: /sync | /sync status | /sync conflicts");
          return { handled: true, exit: false };
        }
        if (normalizedLine === "/system" || normalizedLine.startsWith("/system ")) {
          if (mode === "plain") {
            console.log("usage: /system show|set <prompt>|clear");
          } else {
            tuiHandlers.panel("system", ["usage: /system show|set <prompt>|clear"]);
          }
          return { handled: true, exit: false };
        }
        if (normalizedLine.startsWith("/")) {
          writeMessage(
            mode,
            tuiHandlers,
            `[chat] unknown command: ${normalizedLine}. Type / to discover commands.`
          );
          return { handled: true, exit: false };
        }
        return { handled: false, exit: false };
      }

      return matched.run({
        line: normalizedLine,
        parsed: matched.parse(normalizedLine),
        state: session,
        limitsByModel,
        mode,
        handlers: tuiHandlers,
        onSaveAndSync,
        historySearchRunner,
        transcriptReader,
        transcriptMarkdownReader,
        historySummaryRunner
      });
    }
  };
}

export async function executeChatCommand(
  {
    line,
    state,
    limitsByModel,
    mode = "plain",
    handlers = {},
    onSaveAndSync,
    historySearchRunner,
    transcriptReader,
    transcriptMarkdownReader,
    historySummaryRunner
  },
  deps
) {
  const runtime = createCommandRuntime({
    config: {
      defaultGatewayModel: deps.DEFAULT_GATEWAY_MODEL,
      defaultRagMaxChars: deps.DEFAULT_RAG_MAX_CHARS,
      historyFlowPreview: deps.HISTORY_FLOW_PREVIEW,
      historyFlowSummary: deps.HISTORY_FLOW_SUMMARY,
      vaultContextModes: deps.VAULT_CONTEXT_MODES,
      isVaultContextEnabled: deps.isVaultContextEnabled
    },
    syncClient: {
      saveAndSync: onSaveAndSync,
      formatSyncFeedback: deps.formatSyncFeedback,
      readLocalSyncStatusModel: deps.readLocalSyncStatusModel,
      runNotesAutomationCommand: deps.runNotesAutomationCommand
    },
    historyClient: {
      buildGatewayOptions: deps.buildGatewayOptions,
      buildHistoryContextText: deps.buildHistoryContextText,
      captureRoutingFromTranscriptMetadata: deps.captureRoutingFromTranscriptMetadata,
      clearHistoryFlowStack: deps.clearHistoryFlowStack,
      createHistoryConversationsOnlyMessage: deps.createHistoryConversationsOnlyMessage,
      createHistoryDateRows: deps.createHistoryDateRows,
      createHistoryPanelState: deps.createHistoryPanelState,
      createHistoryRowsFromDateEntries: deps.createHistoryRowsFromDateEntries,
      createHistoryRowsFromSearchResults: deps.createHistoryRowsFromSearchResults,
      createHistoryScreenAction: deps.createHistoryScreenAction,
      formatHistoryConversationLines: deps.formatHistoryConversationLines,
      formatHistoryDateLines: deps.formatHistoryDateLines,
      formatHistoryPreviewLines: deps.formatHistoryPreviewLines,
      formatHistorySummaryLines: deps.formatHistorySummaryLines,
      formatRelativeTranscriptLabel: deps.formatRelativeTranscriptLabel,
      getHistoryRowFromSelection: deps.getHistoryRowFromSelection,
      historyBackStep: deps.historyBackStep,
      isHistoryConversationsScreen: deps.isHistoryConversationsScreen,
      listTranscriptsForDate: deps.listTranscriptsForDate,
      normalizeHistoryDateInput: deps.normalizeHistoryDateInput,
      normalizeHistoryInputShortcut: deps.normalizeHistoryInputShortcut,
      parseHistoryConversationAlias: deps.parseHistoryConversationAlias,
      parsePositiveIndex: deps.parsePositiveIndex,
      pushHistoryFlowDetail: deps.pushHistoryFlowDetail,
      resolveVaultPath: deps.resolveVaultPath,
      searchRunner: historySearchRunner,
      setHistoryFlowConversations: deps.setHistoryFlowConversations,
      setHistoryFlowDatesRoot: deps.setHistoryFlowDatesRoot,
      summaryRunner: historySummaryRunner,
      transcriptMarkdownReader,
      transcriptReader,
      usageFromTranscriptMetadata: deps.usageFromTranscriptMetadata
    },
    usageClient: {
      addUsageToLedger: deps.addUsageToLedger,
      accumulateSessionUsage: deps.accumulateSessionUsage,
      asUsage: deps.asUsage,
      createUsageSummary: deps.createUsageSummary,
      formatUsagePanel: deps.formatUsagePanel,
      printUsageSummary: deps.printUsageSummary
    },
    searchClient: {
      formatSearchPanel: deps.formatSearchPanel,
      printSearchPlain: deps.printSearchPlain
    },
    sessionClient: {
      loadTranscript: deps.loadTranscriptIntoSession,
      resetSession: deps.resetConversation
    }
  });

  return runtime.execute({
    line,
    session: state,
    limitsByModel,
    mode,
    io: handlers,
    onSaveAndSync,
    historySearchRunner,
    transcriptReader,
    transcriptMarkdownReader,
    historySummaryRunner
  });
}
