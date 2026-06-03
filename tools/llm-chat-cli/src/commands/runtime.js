import { createHistoryCommandSpecs } from "./families/history.js";
import { createSearchCommandSpecs } from "./families/search.js";
import { createSessionSystemCommandSpecs } from "./families/session-system.js";
import { createSyncCommandSpecs } from "./families/sync.js";
import { createUsageCommandSpecs } from "./families/usage.js";
import { writeMessage } from "./shared.js";

function createCommandRegistry(deps) {
  return [
    ...createHistoryCommandSpecs(deps),
    ...createSyncCommandSpecs(deps),
    ...createSessionSystemCommandSpecs(deps),
    ...createUsageCommandSpecs(deps),
    ...createSearchCommandSpecs(deps)
  ];
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
      const registry = createCommandRegistry(deps);
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
