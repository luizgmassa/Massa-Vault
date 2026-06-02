#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../notes-automation/src/config.js";
import {
  completeCommandInput as completeCommandInputImpl,
  createCommandRuntime,
  getCommandDefinitions as getCommandDefinitionsImpl,
  getCommandPanelLines as getCommandPanelLinesImpl,
  getCommandSuggestions as getCommandSuggestionsImpl,
  resolveCommandSubmission as resolveCommandSubmissionImpl
} from "./commands.js";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_GATEWAY_MODEL,
  DEFAULT_HISTORY_SUMMARY_MAX_CHARS,
  DEFAULT_IDLE_SYNC_MS,
  buildGatewayOptions,
  formatSyncFeedback,
  isVaultContextEnabled,
  readLocalSyncStatusModel,
  resolveVaultPath,
  runNotesAutomationCommand
} from "./chat-config.js";
import {
  createStatusLine,
  createStatusRenderer,
  createStatusState,
  createUsageSummary,
  formatUsagePanel,
  printUsageSummary
} from "./chat-status.js";
import {
  createChatSession,
  loadTranscriptIntoSession,
  resetChatSession
} from "./chat-session.js";
import { runPrompt } from "./chat-runtime.js";
import { streamChatCompletion } from "./gateway.js";
import { readLiteLLMLimits } from "./litellm-limits.js";
import { ensureSearchIndex, getSearchDefaults, searchIndex } from "./search.js";
import {
  listTranscriptDates,
  listTranscriptsForDate,
  readTranscript,
  writeTranscript
} from "./transcripts.js";
import { routingFromTranscriptMetadata } from "../../shared/routing-metadata.js";
import {
  accumulateSessionUsage,
  addUsageToLedger
} from "./usage.js";
import {
  buildVaultAccessContract as buildVaultAccessContractImpl,
  buildVaultContext as buildVaultContextImpl,
  buildVaultContextPayload as buildVaultContextPayloadImpl,
  buildVaultManifestPayload as buildVaultManifestPayloadImpl,
  classifyVaultContextIntent as classifyVaultContextIntentImpl,
  DEFAULT_RAG_CHUNK_LIMIT,
  DEFAULT_RAG_MAX_CHARS,
  normalizeSourcePath as normalizeSourcePathImpl,
  VAULT_CONTEXT_MODES
} from "./vault-context.js";
const HISTORY_FLOW_DATES = "dates";
const HISTORY_FLOW_CONVERSATIONS = "conversations";
const HISTORY_FLOW_SUMMARY = "summary";
const HISTORY_FLOW_PREVIEW = "preview";

function parseArguments(argv) {
  const args = [...argv];
  let systemPrompt = process.env.MASSA_VAULT_CHAT_SYSTEM_PROMPT || "";

  if (args[0] === "--system" && args[1]) {
    systemPrompt = args[1];
    args.splice(0, 2);
  }

  return {
    args,
    systemPrompt
  };
}

function warnIfAuthMissing(apiKey) {
  if (apiKey) return;
  console.error(
    "[chat] warning: LITELLM_MASTER_KEY is empty. Requests may fail with 401 if gateway auth is enabled."
  );
}

function asUsage(usage) {
  return {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0)
  };
}

function normalizeSourcePath(filePath) {
  return normalizeSourcePathImpl(filePath);
}

function buildVaultAccessContract() {
  return buildVaultAccessContractImpl();
}

function classifyVaultContextIntent(prompt) {
  return classifyVaultContextIntentImpl(prompt);
}

function buildVaultManifestPayload(filePaths, options) {
  return buildVaultManifestPayloadImpl(filePaths, options);
}

function buildVaultContextPayload(
  results,
  { maxChars = DEFAULT_RAG_MAX_CHARS, mode = "semantic" } = {}
) {
  return buildVaultContextPayloadImpl(results, { maxChars, mode });
}

async function buildVaultContext({
  prompt,
  limit = DEFAULT_RAG_CHUNK_LIMIT,
  maxChars = DEFAULT_RAG_MAX_CHARS
}) {
  return buildVaultContextImpl({ prompt, limit, maxChars });
}

async function runSearch({ query, includeGlobs = [] }) {
  const vaultPath = resolveVaultPath();
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const defaults = getSearchDefaults();
  const { index, rebuilt } = await ensureSearchIndex({
    vaultPath,
    ignoreGlobs: config.ignoreGlobs || [],
    includeGlobs,
    baseUrl: defaults.baseUrl,
    model: defaults.model
  });
  const results = await searchIndex({
    indexData: index,
    query,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    limit: 8
  });

  return { rebuilt, results };
}

function normalizeHistoryDateInput(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function parsePositiveIndex(value) {
  const numeric = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function createHistoryDateRows(vaultPath) {
  return listTranscriptDates(vaultPath).map((date, index) => ({
    number: index + 1,
    date,
    count: listTranscriptsForDate(vaultPath, date).length
  }));
}

function truncateText(value, limit = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function extractTimeFromFileName(fileName) {
  const match = String(fileName || "").match(/^(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return "--:--:--";
  return `${match[1]}:${match[2]}:${match[3]}`;
}

function formatRelativeTranscriptLabel(relativePath) {
  const normalized = normalizeSourcePath(relativePath);
  if (!normalized) return "";
  return normalized.replace(/^AI Chats\//, "");
}

function createHistoryRowsFromDateEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.map((entry, index) => ({
    number: index + 1,
    transcriptPath: entry.transcriptPath,
    relativePath: entry.relativePath,
    date: entry.date,
    fileName: entry.fileName,
    time: entry.time || extractTimeFromFileName(entry.fileName),
    title: entry.title || "chat",
    score: null,
    snippet: ""
  }));
}

function createHistoryRowsFromSearchResults(results, vaultPath) {
  const grouped = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const filePath = normalizeSourcePath(result?.filePath);
    if (!filePath) continue;
    if (!filePath.startsWith("AI Chats/")) continue;
    const current = grouped.get(filePath);
    const score = Number(result?.score || 0);
    if (!current || score > current.score) {
      grouped.set(filePath, {
        filePath,
        score,
        snippet: truncateText(result?.snippet || "")
      });
    }
  }

  return [...grouped.values()]
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .map((item, index) => {
      const baseName = path.basename(item.filePath);
      const dateMatch = item.filePath.match(/^AI Chats\/(\d{4}-\d{2}-\d{2})\//);
      return {
        number: index + 1,
        transcriptPath: path.join(vaultPath, item.filePath),
        relativePath: item.filePath,
        date: dateMatch ? dateMatch[1] : "",
        fileName: baseName,
        time: extractTimeFromFileName(baseName),
        title: baseName.replace(/\.md$/i, "").replace(/^\d{2}-\d{2}-\d{2}--/, "").replace(/-/g, " "),
        score: item.score,
        snippet: item.snippet
      };
    });
}

function escapeHistoryTableCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function buildHistoryMarkdownTable(headers, rows) {
  const safeHeaders = (Array.isArray(headers) ? headers : []).map((header) =>
    escapeHistoryTableCell(header)
  );
  const safeRows = (Array.isArray(rows) ? rows : []).map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => escapeHistoryTableCell(cell))
  );

  return [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${safeHeaders.map(() => "---").join(" | ")} |`,
    ...safeRows.map((row) => `| ${row.join(" | ")} |`)
  ];
}

function spacingForHistorySentences(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  const lines = [];
  const sentences = source.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [source];
  for (const sentence of sentences.map((part) => part.trim()).filter(Boolean)) {
    if (lines.length) lines.push("");
    lines.push(sentence);
  }
  return lines.length ? lines : [source];
}

function formatHistoryDateLines({ rows }) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = ["## History dates", "", "History dates (newest first).", ""];
  if (!list.length) {
    lines.push("No transcript date folders found under `AI Chats/`.");
    lines.push("");
    lines.push("Usage : `/history date <number|YYYY-MM-DD>`");
    lines.push("Tip : type date row number (example: `1`) | `/back`");
    return lines;
  }

  lines.push(
    ...buildHistoryMarkdownTable(
      ["#", "Date", "Conversations"],
      list.map((row) => [String(row.number), row.date, String(row.count)])
    )
  );
  lines.push("");
  lines.push("Usage : `/history date <number|YYYY-MM-DD>`");
  lines.push("Tip : `/history search <query>` | type date row number (example: `1`) | `/back`");
  return lines;
}

function formatHistoryConversationLines({ rows, title, includeScore = false }) {
  const list = Array.isArray(rows) ? rows : [];
  const heading = String(title || "History conversations").trim() || "History conversations";
  const lines = [`## ${heading}`];
  if (!list.length) {
    lines.push("");
    lines.push("No conversations found.");
    lines.push("");
    lines.push("Usage : `/history date <number|YYYY-MM-DD>` | `/history search <query>`");
    return lines;
  }

  lines.push("");
  const headers = includeScore
    ? ["#", "Time", "Date", "Score", "Transcript", "Snippet"]
    : ["#", "Time", "Date", "Transcript", "Snippet"];
  lines.push(
    ...buildHistoryMarkdownTable(
      headers,
      list.map((row) => {
        const transcriptLabel = truncateText(`${row.fileName}`, 54);
        const snippet = row.snippet ? truncateText(row.snippet, 90) : "-";
        if (includeScore) {
          const scoreText = Number.isFinite(row.score) ? row.score.toFixed(4) : "0.0000";
          return [
            String(row.number),
            row.time || "--:--:--",
            row.date || "-",
            scoreText,
            transcriptLabel,
            snippet
          ];
        }
        return [String(row.number), row.time || "--:--:--", row.date || "-", transcriptLabel, snippet];
      })
    )
  );
  lines.push("");
  lines.push(
    "Usage : `/history switch <n>` | `/switch <n>` | `/history add_context <n>` | `/add_context <n>`"
  );
  lines.push(
    "More : `/history summary <n>` | `/summary <n>` | `/history preview <n>` | `/preview <n>` | `/back` | `/conv`"
  );
  return lines;
}

function formatHistorySummaryLines({ row, summary }) {
  const title = formatRelativeTranscriptLabel(row?.relativePath) || row?.fileName || "unknown";
  const lines = ["## History summary", ""];
  lines.push(
    ...buildHistoryMarkdownTable(
      ["Field", "Value"],
      [
        ["Conversation", title],
        ["Date", row?.date || "-"],
        ["Time", row?.time || "--:--:--"]
      ]
    )
  );
  lines.push("");
  lines.push("### Summary");
  lines.push("");
  const sentenceLines = spacingForHistorySentences(summary);
  lines.push(...(sentenceLines.length ? sentenceLines : ["No summary generated."]));
  lines.push("");
  lines.push("Usage : `/history preview <n>` | `/preview <n>` | `/back` | `/conv`");
  return lines;
}

function formatHistoryPreviewLines({ row, transcriptMarkdown }) {
  const title = formatRelativeTranscriptLabel(row?.relativePath) || row?.fileName || "unknown";
  const lines = ["## History preview", ""];
  lines.push(
    ...buildHistoryMarkdownTable(
      ["Field", "Value"],
      [
        ["Conversation", title],
        ["Date", row?.date || "-"],
        ["Time", row?.time || "--:--:--"]
      ]
    )
  );
  lines.push("");
  lines.push("### Transcript");
  lines.push("");
  lines.push("```markdown");
  lines.push(...String(transcriptMarkdown || "").split(/\r?\n/));
  lines.push("```");
  lines.push("");
  lines.push("Usage : `Up/Down scroll` | `/back` | `/conv`");
  return lines;
}

function readTranscriptMarkdownFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

async function summarizeHistoryTranscript({
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

function buildHistoryContextText({ row, transcript, maxChars = DEFAULT_RAG_MAX_CHARS }) {
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  if (!messages.length) return "";
  const source = formatRelativeTranscriptLabel(row?.relativePath) || row?.fileName || "unknown transcript";
  let content = `Context from transcript ${source}:`;

  for (const message of messages) {
    const role = String(message?.role || "unknown").toUpperCase();
    const body = String(message?.content || "").trim();
    if (!body) continue;
    const block = `\n\n[${role}]\n${body}`;
    if (content.length + block.length > maxChars) {
      const remaining = maxChars - content.length;
      if (remaining > 16) {
        content += block.slice(0, remaining).trimEnd();
      }
      content += "\n\n[context truncated]";
      break;
    }
    content += block;
  }

  return content.trim();
}

function getHistoryRowFromSelection(state, value) {
  const index = parsePositiveIndex(value);
  if (!index) return null;
  const rows = Array.isArray(state?.historyVisibleRows) ? state.historyVisibleRows : [];
  return rows.find((row) => Number(row?.number) === index) || null;
}

function captureRoutingFromTranscriptMetadata(metadata) {
  return routingFromTranscriptMetadata(metadata);
}

function usageFromTranscriptMetadata(metadata) {
  const prompt = Number(metadata?.prompt_tokens || 0);
  const completion = Number(metadata?.completion_tokens || 0);
  const total = Number(metadata?.total_tokens || 0);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : 0
  };
}

function formatSearchPanel({ rebuilt, results }) {
  const lines = [];
  if (rebuilt) {
    lines.push("index rebuilt");
  }
  if (!results.length) {
    lines.push("no results");
    return lines;
  }

  for (const result of results) {
    lines.push(
      `${result.filePath}#${result.chunkIndex} score=${result.score.toFixed(4)} ${result.snippet}`
    );
  }
  return lines;
}

function printSearchPlain(searchResult) {
  if (searchResult.rebuilt) {
    console.log("[chat-search] index rebuilt");
  }
  if (!searchResult.results.length) {
    console.log("[chat-search] no results");
    return;
  }
  for (const line of formatSearchPanel(searchResult)) {
    if (line === "index rebuilt") continue;
    console.log(`- ${line}`);
  }
}

function getCommandDefinitions() {
  return getCommandDefinitionsImpl();
}

function getCommandSuggestions(inputValue, definitions = getCommandDefinitionsImpl()) {
  return getCommandSuggestionsImpl(inputValue, definitions);
}

function completeCommandInput(inputValue, definitions = getCommandDefinitionsImpl()) {
  return completeCommandInputImpl(inputValue, definitions);
}

function resolveCommandSubmission(definition) {
  return resolveCommandSubmissionImpl(definition);
}

function getCommandPanelLines(definitions = getCommandDefinitionsImpl()) {
  return getCommandPanelLinesImpl(definitions);
}

function buildTranscriptPayload({
  id,
  createdAt,
  gatewayUrl,
  history,
  model,
  routing,
  usage
}) {
  return {
    id,
    createdAt,
    gatewayUrl,
    model: model || DEFAULT_GATEWAY_MODEL,
    routing,
    usage,
    messages: history
  };
}

async function saveTranscript({
  sessionId,
  sessionStartedAt,
  history,
  latestRouting,
  sessionUsage,
  activeTranscript
}) {
  if (!history.length) return null;
  const vaultPath = resolveVaultPath();
  const gateway = buildGatewayOptions();
  const metadata = activeTranscript && typeof activeTranscript === "object" ? activeTranscript : null;
  return writeTranscript({
    filePath: metadata?.path || null,
    vaultPath,
    ...buildTranscriptPayload({
      id: metadata?.id || sessionId,
      createdAt: metadata?.createdAt || sessionStartedAt,
      gatewayUrl: metadata?.gatewayUrl || gateway.gatewayUrl,
      history,
      model: metadata?.model || DEFAULT_GATEWAY_MODEL,
      routing: latestRouting || metadata?.routing || null,
      usage: sessionUsage
    })
  });
}

async function persistTranscriptForSession(state) {
  if (state.transcriptSavedPath && state.lastSavedHistoryLength === state.history.length) {
    return { path: state.transcriptSavedPath, saved: false };
  }

  const path = await saveTranscript({
    sessionId: state.sessionId,
    sessionStartedAt: state.sessionStartedAt,
    history: state.history,
    latestRouting: state.latestRouting,
    sessionUsage: state.sessionUsage,
    activeTranscript: state.activeTranscript
  });
  if (!path) {
    return { path: null, saved: false };
  }

  state.transcriptSavedPath = path;
  state.lastSavedHistoryLength = state.history.length;
  return { path, saved: true };
}

async function saveAndSyncSession(state, { reason = "chat-manual-sync", skipSave = false } = {}) {
  const saveResult = skipSave ? { path: null, saved: false } : await persistTranscriptForSession(state);
  const syncResult = runNotesAutomationCommand(["sync"]);
  return {
    saveResult,
    syncResult,
    reason,
    summary: formatSyncFeedback(syncResult)
  };
}

function createReplState({ systemPrompt }) {
  return createChatSession({ systemPrompt });
}

function resetConversation(state) {
  return resetChatSession(state);
}

function createTuiCommandHandlers(handlers) {
  return {
    panel(title, lines) {
      if (handlers?.panel) handlers.panel(title, lines);
    },
    message(text) {
      if (handlers?.message) handlers.message(text);
    }
  };
}

function createHistoryScreenAction({
  title = "History",
  lines = [],
  scrollable = false,
  previewMode = false
} = {}) {
  return {
    type: "switch-screen",
    screen: "history",
    historyPanel: {
      title,
      lines,
      renderMarkdown: true,
      scrollable,
      previewMode
    }
  };
}

function createHistoryPanelState({
  title = "History",
  lines = [],
  scrollable = false,
  previewMode = false
} = {}) {
  return {
    title: String(title || "History"),
    lines: Array.isArray(lines) ? lines : [],
    scrollable: Boolean(scrollable),
    previewMode: Boolean(previewMode)
  };
}

function createHistoryFlowEntry({ screen, panel } = {}) {
  return {
    screen: String(screen || "").trim(),
    panel: createHistoryPanelState(panel)
  };
}

function ensureHistoryFlowStack(state) {
  if (!Array.isArray(state.historyFlowStack)) {
    state.historyFlowStack = [];
  }
  return state.historyFlowStack;
}

function clearHistoryFlowStack(state) {
  state.historyFlowStack = [];
}

function getHistoryFlowTop(state) {
  const stack = ensureHistoryFlowStack(state);
  return stack.length ? stack[stack.length - 1] : null;
}

function getCurrentHistoryFlowScreen(state) {
  return String(getHistoryFlowTop(state)?.screen || "");
}

function isHistoryConversationsScreen(state) {
  return getCurrentHistoryFlowScreen(state) === HISTORY_FLOW_CONVERSATIONS;
}

function setHistoryFlowDatesRoot(state, panel) {
  state.historyFlowStack = [createHistoryFlowEntry({ screen: HISTORY_FLOW_DATES, panel })];
}

function setHistoryFlowConversations(state, { datePanel, conversationsPanel }) {
  const stack = ensureHistoryFlowStack(state);
  const rootEntry = createHistoryFlowEntry({
    screen: HISTORY_FLOW_DATES,
    panel: datePanel
  });
  if (!stack.length) {
    stack.push(rootEntry);
  } else {
    stack[0] = rootEntry;
    if (stack.length > 1) {
      stack.splice(1);
    }
  }
  stack.push(
    createHistoryFlowEntry({
      screen: HISTORY_FLOW_CONVERSATIONS,
      panel: conversationsPanel
    })
  );
}

function pushHistoryFlowDetail(state, { screen, panel }) {
  const stack = ensureHistoryFlowStack(state);
  if (!stack.length) return;
  const nextEntry = createHistoryFlowEntry({ screen, panel });
  const top = stack[stack.length - 1];
  if (top?.screen === screen) {
    stack[stack.length - 1] = nextEntry;
    return;
  }
  stack.push(nextEntry);
}

function historyBackStep(state) {
  const stack = ensureHistoryFlowStack(state);
  if (!stack.length) {
    return { type: "none" };
  }
  const currentScreen = stack[stack.length - 1]?.screen;
  if (currentScreen === HISTORY_FLOW_DATES) {
    clearHistoryFlowStack(state);
    return { type: "exit-conversation" };
  }
  stack.pop();
  if (!stack.length) {
    clearHistoryFlowStack(state);
    return { type: "exit-conversation" };
  }
  return {
    type: "panel",
    panel: stack[stack.length - 1].panel
  };
}

function parseHistoryConversationAlias(line) {
  const source = String(line || "").trim();
  if (!source.startsWith("/")) return null;
  const patterns = [
    ["/switch", "/history switch"],
    ["/add_context", "/history add_context"],
    ["/summary", "/history summary"],
    ["/preview", "/history preview"]
  ];
  for (const [alias, full] of patterns) {
    if (source === alias || source.startsWith(`${alias} `)) {
      return {
        alias,
        full: `${full}${source.slice(alias.length)}`
      };
    }
  }
  return null;
}

function normalizeHistoryInputShortcut(line, state) {
  const source = String(line || "").trim();
  if (!source) return source;
  const screen = getCurrentHistoryFlowScreen(state);
  if (screen === HISTORY_FLOW_DATES && !source.startsWith("/")) {
    const index = parsePositiveIndex(source);
    if (index) {
      return `/history date ${index}`;
    }
  }
  if (screen === HISTORY_FLOW_CONVERSATIONS) {
    const alias = parseHistoryConversationAlias(source);
    if (alias?.full) return alias.full;
  }
  return source;
}

function createHistoryConversationsOnlyMessage(command) {
  return `[History] ${command} available only in History conversations screen.`;
}

async function executeCommand({
  line,
  state,
  limitsByModel,
  mode = "plain",
  handlers = {},
  onSaveAndSync = saveAndSyncSession,
  historySearchRunner = runSearch,
  transcriptReader = readTranscript,
  transcriptMarkdownReader = readTranscriptMarkdownFile,
  historySummaryRunner = summarizeHistoryTranscript
}) {
  const runtime = createCommandRuntime({
    config: {
      defaultGatewayModel: DEFAULT_GATEWAY_MODEL,
      defaultRagMaxChars: DEFAULT_RAG_MAX_CHARS,
      historyFlowPreview: HISTORY_FLOW_PREVIEW,
      historyFlowSummary: HISTORY_FLOW_SUMMARY,
      vaultContextModes: VAULT_CONTEXT_MODES,
      isVaultContextEnabled
    },
    syncClient: {
      saveAndSync: onSaveAndSync,
      formatSyncFeedback,
      readLocalSyncStatusModel,
      runNotesAutomationCommand
    },
    historyClient: {
      buildGatewayOptions,
      buildHistoryContextText,
      captureRoutingFromTranscriptMetadata,
      clearHistoryFlowStack,
      createHistoryConversationsOnlyMessage,
      createHistoryDateRows,
      createHistoryPanelState,
      createHistoryScreenAction,
      createHistoryRowsFromDateEntries,
      createHistoryRowsFromSearchResults,
      formatHistoryConversationLines,
      formatHistoryDateLines,
      formatHistoryPreviewLines,
      formatHistorySummaryLines,
      formatRelativeTranscriptLabel,
      getHistoryRowFromSelection,
      historyBackStep,
      isHistoryConversationsScreen,
      listTranscriptsForDate,
      normalizeHistoryDateInput,
      normalizeHistoryInputShortcut,
      parseHistoryConversationAlias,
      parsePositiveIndex,
      pushHistoryFlowDetail,
      resolveVaultPath,
      searchRunner: historySearchRunner,
      setHistoryFlowConversations,
      setHistoryFlowDatesRoot,
      summaryRunner: historySummaryRunner,
      transcriptMarkdownReader,
      transcriptReader,
      usageFromTranscriptMetadata
    },
    usageClient: {
      addUsageToLedger,
      accumulateSessionUsage,
      asUsage,
      createUsageSummary,
      formatUsagePanel,
      printUsageSummary
    },
    searchClient: {
      formatSearchPanel,
      printSearchPlain
    },
    sessionClient: {
      loadTranscript: (session, payload) =>
        loadTranscriptIntoSession(session, {
          ...payload,
          fallbackSessionId: session.sessionId,
          fallbackSessionStartedAt: session.sessionStartedAt,
          fallbackGatewayUrl: buildGatewayOptions().gatewayUrl,
          fallbackModel: DEFAULT_GATEWAY_MODEL
        }),
      resetSession: resetConversation
    }
  });

  return runtime.execute({
    line,
    session: state,
    limitsByModel,
    mode,
    io: handlers
  });
}

async function processPrompt({
  prompt,
  history,
  systemPrompt,
  sessionUsage,
  estimatedTokensRef,
  statusRenderer,
  chatCompletion = streamChatCompletion,
  vaultContextBuilder = buildVaultContext,
  outputStream = output,
  renderMode = "plain",
  onThinkingChange,
  onAssistantDelta,
  onUsage,
  onRouting,
  onWarning,
  extraContextMessages = []
}) {
  const session = {
    history,
    sessionUsage,
    estimatedTokensRef,
    latestRouting: null,
    activeSystemPrompt: systemPrompt,
    addedContextEntries: (Array.isArray(extraContextMessages) ? extraContextMessages : [])
      .map((message, index) => ({
        source: `compat-${index + 1}`,
        content: String(message?.content || "").trim()
      }))
      .filter((entry) => entry.content)
  };

  return runPrompt(session, {
    prompt,
    statusRenderer,
    chatCompletion,
    vaultContextBuilder,
    outputStream,
    renderMode,
    onThinkingChange,
    onAssistantDelta,
    onUsage,
    onRouting,
    onWarning
  });
}

function createStartupWarmup({
  chatCompletion = streamChatCompletion,
  onWarning
} = {}) {
  let promise = null;
  const connectErrorCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ]);
  const connectivityPattern =
    /\b(fetch failed|network error|failed to fetch|econnrefused|enotfound|eai_again|etimedout|connect timeout|connection refused)\b/i;
  const isConnectivityFailure = (error) => {
    if (!error) return false;
    const seen = new Set();
    const queue = [error];
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      const message = String(current?.message || current).trim();
      const code = String(current?.code || current?.errno || "").trim().toUpperCase();
      if (message && connectivityPattern.test(message)) return true;
      if (code && connectErrorCodes.has(code)) return true;
      if (current?.cause && typeof current.cause === "object") {
        queue.push(current.cause);
      }
    }
    return false;
  };

  const start = () => {
    if (promise) return promise;

    const gateway = buildGatewayOptions();
    promise = chatCompletion({
      baseUrl: gateway.gatewayUrl,
      apiKey: gateway.apiKey,
      body: {
        model: DEFAULT_GATEWAY_MODEL,
        stream: false,
        messages: [{ role: "user", content: "warmup" }]
      }
    })
      .then(() => ({ ok: true }))
      .catch((error) => {
        if (!isConnectivityFailure(error)) {
          const message = `[chat] warning: startup warmup failed (${error instanceof Error ? error.message : String(error)}). continuing without warmup.`;
          if (onWarning) {
            onWarning(message);
          }
        }
        return { ok: false, error };
      });

    return promise;
  };

  const wait = async () => {
    if (!promise) return { ok: true, skipped: true };
    return promise;
  };

  return { start, wait };
}

async function runPlainRepl({ systemPrompt, startupWarmup } = {}) {
  const rl = readlinePromises.createInterface({ input, output });
  const state = createChatSession({ systemPrompt });
  const statusRenderer = createStatusRenderer();
  const limitsByModel = readLiteLLMLimits();
  const idleSyncMs = Number.isFinite(DEFAULT_IDLE_SYNC_MS) ? Math.max(DEFAULT_IDLE_SYNC_MS, 5000) : 30_000;
  const warmup =
    startupWarmup ||
    createStartupWarmup({
      onWarning: (message) => console.error(message)
    });
  warmup.start();
  let firstPromptAwaitedWarmup = false;
  let nextIdleSyncAt = null;
  let closing = false;

  const summarizeSaveAndSync = (result) => {
    if (result.saveResult.path && result.saveResult.saved) {
      console.log(`[chat] transcript saved: ${result.saveResult.path}`);
    } else if (result.saveResult.path) {
      console.log("[chat] transcript already up to date");
    } else {
      console.log("[chat] nothing to save");
    }
    console.log(result.summary);
  };

  const saveAndSyncFor = async (reason) => {
    const result = await saveAndSyncSession(state, { reason });
    summarizeSaveAndSync(result);
    return result;
  };

  const handleSignal = (signalName) => {
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        await saveAndSyncFor(`chat-signal-${signalName.toLowerCase()}`);
      } catch (error) {
        console.error(`[chat] signal cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        process.exit(0);
      }
    })();
  };

  const signalHandlers = {
    SIGINT: () => handleSignal("SIGINT"),
    SIGTERM: () => handleSignal("SIGTERM"),
    SIGHUP: () => handleSignal("SIGHUP")
  };
  for (const [signal, handler] of Object.entries(signalHandlers)) {
    process.on(signal, handler);
  }

  const questionWithIdleSync = async () => {
    if (!nextIdleSyncAt) {
      const line = await rl.question("you> ");
      return { line, idle: false };
    }

    const timeoutMs = Math.max(nextIdleSyncAt - Date.now(), 1);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const line = await rl.question("you> ", { signal: abortController.signal });
      clearTimeout(timer);
      return { line, idle: false };
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === "AbortError" || /aborted/i.test(String(error?.message || error))) {
        return { line: "", idle: true };
      }
      throw error;
    }
  };

  console.log("massa-vault chat started. type / to discover commands.");

  try {
    while (true) {
      const promptResult = await questionWithIdleSync();
      if (promptResult.idle) {
        nextIdleSyncAt = null;
        await saveAndSyncFor("chat-idle-sync");
        continue;
      }

      const line = promptResult.line.trim();
      nextIdleSyncAt = null;
      if (!line) continue;

      const commandResult = await executeCommand({
        line,
        state,
        limitsByModel,
        mode: "plain"
      });
      if (commandResult.handled) {
        if (commandResult.exit) {
          await saveAndSyncFor("chat-exit");
          closing = true;
          break;
        }
        continue;
      }

      try {
        if (!firstPromptAwaitedWarmup) {
          firstPromptAwaitedWarmup = true;
          await warmup.wait();
        }
        state.transcriptSavedPath = null;
        const result = await runPrompt(state, {
          prompt: line,
          statusRenderer
        });
        state.latestRouting = result.routing;
        nextIdleSyncAt = Date.now() + idleSyncMs;
      } catch (error) {
        output.write("\n");
        console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    for (const [signal, handler] of Object.entries(signalHandlers)) {
      process.off(signal, handler);
    }
    if (!closing && state.history.length) {
      await saveAndSyncFor("chat-finalize");
    }
    statusRenderer.clear();
    rl.close();
  }
}

function isInteractiveTuiSupported({
  stdin = input,
  stdout = output,
  env = process.env
} = {}) {
  if (env.NO_COLOR) return false;
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

async function runRepl({ systemPrompt }) {
  if (isInteractiveTuiSupported()) {
    try {
      const { runInkRepl } = await import("./ink-repl.js");
      await runInkRepl({ systemPrompt });
      return;
    } catch (error) {
      console.error(
        `[chat] tui unavailable (${error instanceof Error ? error.message : String(error)}). falling back to plain mode.`
      );
    }
  }
  await runPlainRepl({ systemPrompt });
}

async function runOneShot({ prompt, systemPrompt }) {
  const session = createChatSession({ systemPrompt });
  const statusRenderer = createStatusRenderer();
  try {
    await runPrompt(session, { prompt, statusRenderer });
  } finally {
    statusRenderer.clear();
  }

  const filePath = await saveTranscript({
    sessionId: session.sessionId,
    sessionStartedAt: session.sessionStartedAt,
    history: session.history,
    latestRouting: session.latestRouting,
    sessionUsage: session.sessionUsage
  });
  if (filePath) {
    console.log(`[chat] transcript saved: ${filePath}`);
  }
}

function extractSearchQuery(args) {
  if (!args.length) return "";
  if (args[0] === "index") return "__index__";
  return args.join(" ").trim();
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const args = parsed.args;

  if (args[0] === "search") {
    const query = extractSearchQuery(args.slice(1));
    if (!query) {
      console.error("usage: chat search <query>");
      process.exit(1);
    }
    if (query === "__index__") {
      const vaultPath = resolveVaultPath();
      const config = loadConfig(DEFAULT_CONFIG_PATH);
      const defaults = getSearchDefaults();
      await ensureSearchIndex({
        vaultPath,
        ignoreGlobs: config.ignoreGlobs || [],
        baseUrl: defaults.baseUrl,
        model: defaults.model
      });
      console.log("[chat-search] index built");
      return;
    }
    printSearchPlain(await runSearch({ query }));
    return;
  }

  const gateway = buildGatewayOptions();
  warnIfAuthMissing(gateway.apiKey);

  if (!args.length) {
    await runRepl({ systemPrompt: parsed.systemPrompt });
    return;
  }

  const prompt = args.join(" ").trim();
  if (!prompt) {
    console.error("usage: chat <prompt>");
    process.exit(1);
  }
  await runOneShot({
    prompt,
    systemPrompt: parsed.systemPrompt
  });
}

export {
  DEFAULT_GATEWAY_MODEL,
  buildVaultAccessContract,
  buildVaultContext,
  buildVaultContextPayload,
  buildVaultManifestPayload,
  buildGatewayOptions,
  classifyVaultContextIntent,
  completeCommandInput,
  createChatSession,
  createStartupWarmup,
  resolveCommandSubmission,
  getCommandDefinitions,
  getCommandSuggestions,
  createReplState,
  createStatusLine,
  createStatusRenderer,
  createStatusState,
  createUsageSummary,
  executeCommand,
  formatSearchPanel,
  formatUsagePanel,
  isInteractiveTuiSupported,
  isVaultContextEnabled,
  main,
  processPrompt,
  readLocalSyncStatusModel,
  resetConversation,
  runPrompt,
  runOneShot,
  runPlainRepl,
  runRepl,
  saveAndSyncSession,
  saveTranscript
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    output.write("\n");
    console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
