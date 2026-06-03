import {
  DEFAULT_GATEWAY_MODEL,
  DEFAULT_HISTORY_SUMMARY_MAX_CHARS,
  buildGatewayOptions,
  resolveVaultPath
} from "../infrastructure/chat-config.js";
import { streamChatCompletion } from "../infrastructure/gateway.js";
import {
  listTranscriptDates,
  listTranscriptsForDate,
  readTranscript,
  readTranscriptMarkdown
} from "../infrastructure/transcripts.js";
import {
  buildHistoryContextText,
  captureRoutingFromTranscriptMetadata,
  clearHistoryFlowStack,
  createHistoryConversationsOnlyMessage,
  createHistoryPanelState,
  createHistoryRowsFromDateEntries,
  createHistoryRowsFromSearchResults,
  createHistoryScreenAction,
  formatHistoryConversationLines,
  formatHistoryDateLines,
  formatHistoryPreviewLines,
  formatHistorySummaryLines,
  formatRelativeTranscriptLabel,
  getHistoryRowFromSelection,
  historyBackStep,
  isHistoryConversationsScreen,
  normalizeHistoryDateInput,
  normalizeHistoryInputShortcut,
  parseHistoryConversationAlias,
  parsePositiveIndex,
  pushHistoryFlowDetail,
  setHistoryFlowConversations,
  setHistoryFlowDatesRoot,
  usageFromTranscriptMetadata
} from "../domain/history.js";

export * from "../domain/history.js";

export function createHistoryDateRows(
  vaultPath,
  {
    listDates = listTranscriptDates,
    listEntriesForDate = listTranscriptsForDate
  } = {}
) {
  return listDates(vaultPath).map((date, index) => ({
    number: index + 1,
    date,
    count: listEntriesForDate(vaultPath, date).length
  }));
}

export async function summarizeHistoryTranscript({
  row,
  transcriptMarkdown,
  chatCompletion = streamChatCompletion
}) {
  const gateway = buildGatewayOptions();
  const source = formatRelativeTranscriptLabel(row?.relativePath) || row?.fileName || "unknown";
  const transcriptText = String(transcriptMarkdown || "").trim();
  const cappedTranscript =
    transcriptText.length > DEFAULT_HISTORY_SUMMARY_MAX_CHARS
      ? `${transcriptText.slice(0, DEFAULT_HISTORY_SUMMARY_MAX_CHARS)}\n\n[truncated for summary]`
      : transcriptText;
  const response = await chatCompletion({
    baseUrl: gateway.gatewayUrl,
    apiKey: gateway.apiKey,
    body: {
      model: DEFAULT_GATEWAY_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "You summarize saved AI chat transcripts. Be concise. Return plain Markdown text with short sentences."
        },
        {
          role: "user",
          content: [
            "Summarize this transcript in 3 to 5 short sentences.",
            "Include: user goal, key answer/result, and any follow-up action.",
            "Do not include code fences.",
            `Transcript source: ${source}`,
            "",
            cappedTranscript || "[empty transcript]"
          ].join("\n")
        }
      ]
    }
  });
  return {
    summary: String(response?.assistantText || "").trim(),
    usage: response?.usage || null,
    routing: response?.routing || null
  };
}

export function createHistoryClient({
  searchRunner,
  transcriptReader = readTranscript,
  transcriptMarkdownReader = readTranscriptMarkdown,
  summaryRunner = summarizeHistoryTranscript,
  resolveVaultPathFn = resolveVaultPath,
  listTranscriptDatesFn = listTranscriptDates,
  listTranscriptsForDateFn = listTranscriptsForDate
} = {}) {
  return {
    buildGatewayOptions,
    buildHistoryContextText,
    captureRoutingFromTranscriptMetadata,
    clearHistoryFlowStack,
    createHistoryConversationsOnlyMessage,
    createHistoryDateRows: (vaultPath) =>
      createHistoryDateRows(vaultPath, {
        listDates: listTranscriptDatesFn,
        listEntriesForDate: listTranscriptsForDateFn
      }),
    createHistoryPanelState,
    createHistoryRowsFromDateEntries,
    createHistoryRowsFromSearchResults,
    createHistoryScreenAction,
    formatHistoryConversationLines,
    formatHistoryDateLines,
    formatHistoryPreviewLines,
    formatHistorySummaryLines,
    formatRelativeTranscriptLabel,
    getHistoryRowFromSelection,
    historyBackStep,
    isHistoryConversationsScreen,
    listTranscriptsForDate: (vaultPath, date) => listTranscriptsForDateFn(vaultPath, date),
    normalizeHistoryDateInput,
    normalizeHistoryInputShortcut,
    parseHistoryConversationAlias,
    parsePositiveIndex,
    pushHistoryFlowDetail,
    resolveVaultPath: resolveVaultPathFn,
    searchRunner,
    setHistoryFlowConversations,
    setHistoryFlowDatesRoot,
    summaryRunner,
    transcriptMarkdownReader,
    transcriptReader,
    usageFromTranscriptMetadata
  };
}
