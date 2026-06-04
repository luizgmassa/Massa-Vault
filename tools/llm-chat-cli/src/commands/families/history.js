import { createCommandSpec } from "../definitions.js";
import {
  createHistorySelectionUsage,
  renderCommands,
  writeMessage
} from "../shared.js";
import { isConcreteRouting } from "../../../../shared/routing-metadata.js";

export function createHistoryCommandSpecs(deps) {
  const {
    HISTORY_FLOW_PREVIEW,
    HISTORY_FLOW_SUMMARY,
    DEFAULT_GATEWAY_MODEL,
    DEFAULT_RAG_MAX_CHARS
  } = deps;

  return [
    {
      match: (line) => line === "/",
      parse: () => ({}),
      run: ({ mode, handlers }) => renderCommands(mode, handlers)
    },
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
      if (state?.activeScreen === "sync" || state?.activeScreen === "panel") {
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
          state.latestRouting = isConcreteRouting(loadedRouting) ? loadedRouting : state.latestRouting;
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
        if (summaryResult?.routing) {
          state.latestRouting = summaryResult.routing;
        }
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
    )
  ];
}
