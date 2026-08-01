import path from "node:path";
import { routingFromTranscriptMetadata } from "../../../shared/routing-metadata.js";
import { buildMarkdownTable } from "./info-screen.js";
import {
  DEFAULT_RAG_MAX_CHARS,
  normalizeSourcePath
} from "./vault-context.js";

export const HISTORY_FLOW_DATES = "dates";
export const HISTORY_FLOW_CONVERSATIONS = "conversations";
export const HISTORY_FLOW_SUMMARY = "summary";
export const HISTORY_FLOW_PREVIEW = "preview";

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

export function normalizeHistoryDateInput(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export function parsePositiveIndex(value) {
  const numeric = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

export function formatRelativeTranscriptLabel(relativePath) {
  const normalized = normalizeSourcePath(relativePath);
  if (!normalized) return "";
  return normalized.replace(/^AI Chats\//, "");
}

export function createHistoryRowsFromDateEntries(entries) {
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

export function createHistoryRowsFromSearchResults(results, vaultPath) {
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

export function formatHistoryDateLines({ rows }) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = ["Dates (newest first).", ""];
  if (!list.length) {
    lines.push("No transcript date folders found under `AI Chats/`.");
    lines.push("");
    lines.push("Usage : `/history date <number|YYYY-MM-DD>`");
    lines.push("Tip : type date row number (example: `1`) | `/back`");
    return lines;
  }

  lines.push(
    ...buildMarkdownTable(
      ["#", "Date", "Conversations"],
      list.map((row) => [String(row.number), row.date, String(row.count)])
    )
  );
  lines.push("");
  lines.push("Usage : `/history date <number|YYYY-MM-DD>`");
  lines.push("Tip : `/history search <query>` | type date row number (example: `1`) | `/back`");
  return lines;
}

export function formatHistoryConversationLines({ rows, title, includeScore = false }) {
  const list = Array.isArray(rows) ? rows : [];
  const heading = String(title || "History conversations").trim() || "History conversations";
  const shortHeading = heading.replace(/^History\s+/i, "");
  const lines = [`${shortHeading}.`];
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
    ...buildMarkdownTable(
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

export function formatHistorySummaryLines({ row, summary }) {
  const title = formatRelativeTranscriptLabel(row?.relativePath) || row?.fileName || "unknown";
  const lines = [];
  lines.push(
    ...buildMarkdownTable(
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

export function formatHistoryPreviewLines({ row, transcriptMarkdown }) {
  const title = formatRelativeTranscriptLabel(row?.relativePath) || row?.fileName || "unknown";
  const lines = [];
  lines.push(
    ...buildMarkdownTable(
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

export function buildHistoryContextText({
  row,
  transcript,
  maxChars = DEFAULT_RAG_MAX_CHARS
}) {
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

export function getHistoryRowFromSelection(state, value) {
  const index = parsePositiveIndex(value);
  if (!index) return null;
  const rows = Array.isArray(state?.historyVisibleRows) ? state.historyVisibleRows : [];
  return rows.find((row) => Number(row?.number) === index) || null;
}

export function captureRoutingFromTranscriptMetadata(metadata) {
  return routingFromTranscriptMetadata(metadata);
}

export function usageFromTranscriptMetadata(metadata) {
  const prompt = Number(metadata?.prompt_tokens || 0);
  const completion = Number(metadata?.completion_tokens || 0);
  const total = Number(metadata?.total_tokens || 0);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : 0
  };
}

export function createHistoryScreenAction({
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

export function createHistoryPanelState({
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

export function clearHistoryFlowStack(state) {
  state.historyFlowStack = [];
}

function getHistoryFlowTop(state) {
  const stack = ensureHistoryFlowStack(state);
  return stack.length ? stack[stack.length - 1] : null;
}

function getCurrentHistoryFlowScreen(state) {
  return String(getHistoryFlowTop(state)?.screen || "");
}

export function isHistoryConversationsScreen(state) {
  return getCurrentHistoryFlowScreen(state) === HISTORY_FLOW_CONVERSATIONS;
}

export function setHistoryFlowDatesRoot(state, panel) {
  state.historyFlowStack = [createHistoryFlowEntry({ screen: HISTORY_FLOW_DATES, panel })];
}

export function setHistoryFlowConversations(state, { datePanel, conversationsPanel }) {
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

export function pushHistoryFlowDetail(state, { screen, panel }) {
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

export function historyBackStep(state) {
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

export function parseHistoryConversationAlias(line) {
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

export function normalizeHistoryInputShortcut(line, state) {
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

export function createHistoryConversationsOnlyMessage(command) {
  return `[History] ${command} available only in History conversations screen.`;
}
