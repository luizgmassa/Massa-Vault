#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../notes-automation/src/config.js";
import { streamChatCompletion } from "./gateway.js";
import { readLiteLLMLimits } from "./litellm-limits.js";
import { ensureSearchIndex, getSearchDefaults, searchIndex } from "./search.js";
import { estimateTokensFromText } from "./token-estimator.js";
import { writeTranscript } from "./transcripts.js";
import { loadLocalEnv } from "../../shared/env.js";
import {
  accumulateSessionUsage,
  addUsageToLedger,
  calculateRemainingFromLimits,
  createSessionUsage,
  getUsageLedger
} from "./usage.js";

loadLocalEnv();

const DEFAULT_GATEWAY_URL = `http://127.0.0.1:${process.env.ROUTER_GATEWAY_PORT || 4100}`;
const DEFAULT_GATEWAY_MODEL = "smart-router";
const DEFAULT_CONFIG_PATH = path.resolve("config/notes-automation.config.json");
const NOTES_AUTOMATION_CLI_PATH = path.resolve("tools/notes-automation/src/cli.js");
const DEFAULT_RAG_CHUNK_LIMIT = 5;
const DEFAULT_RAG_MAX_CHARS = 6000;
const DEFAULT_IDLE_SYNC_MS = Number(process.env.MASSA_VAULT_CHAT_IDLE_SYNC_MS || 30_000);
const RAG_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const VAULT_CONTEXT_MODES = ["semantic", "manifest"];

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

function buildGatewayOptions() {
  return {
    gatewayUrl: process.env.MASSA_VAULT_CHAT_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    apiKey: process.env.LITELLM_MASTER_KEY || ""
  };
}

function warnIfAuthMissing(apiKey) {
  if (apiKey) return;
  console.error(
    "[chat] warning: LITELLM_MASTER_KEY is empty. Requests may fail with 401 if gateway auth is enabled."
  );
}

function isVaultContextEnabled(env = process.env) {
  const raw = String(env.MASSA_VAULT_CHAT_RAG || "")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  return !RAG_DISABLED_VALUES.has(raw);
}

function asUsage(usage) {
  return {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0)
  };
}

function buildMessages(history, systemPrompt) {
  if (!systemPrompt) return [...history];
  return [{ role: "system", content: systemPrompt }, ...history];
}

function createStatusState({
  sessionUsage,
  estimatedTokens,
  routing,
  ledgerTotals,
  authEnabled
}) {
  return {
    sessionUsage,
    estimatedTokens,
    routing,
    ledgerTotals,
    authEnabled
  };
}

function createStatusLine(state) {
  const lane = state.routing?.lane || "unknown";
  const model = state.routing?.targetModel || DEFAULT_GATEWAY_MODEL;
  return (
    `[tokens session=${state.sessionUsage.total_tokens}` +
    ` all_time=${state.ledgerTotals.total_tokens}` +
    ` est=${state.estimatedTokens}` +
    ` lane=${lane}` +
    ` model=${model}` +
    ` auth=${state.authEnabled ? "on" : "off"}]`
  );
}

function createStatusRenderer({ stream = stderr } = {}) {
  const canRender = Boolean(stream?.isTTY);

  return {
    render(text) {
      if (!canRender) return;
      const line = String(text || "");
      if (!line) return;
      stream.write(`${line}\n`);
    },
    clear() {},
    isEnabled() {
      return canRender;
    }
  };
}

function createUsageSummary({
  sessionUsage,
  estimatedTokens,
  routing,
  limitsByModel
}) {
  const ledger = getUsageLedger();
  const modelName = routing?.targetModel || DEFAULT_GATEWAY_MODEL;
  const remaining = calculateRemainingFromLimits({
    limitsByModel,
    modelName,
    usedPromptTokens: sessionUsage.prompt_tokens,
    usedCompletionTokens: sessionUsage.completion_tokens
  });

  return {
    allTimeTotalTokens: ledger.totals.total_tokens,
    sessionTotalTokens: sessionUsage.total_tokens,
    sessionEstimatedTokens: estimatedTokens,
    model: remaining.model,
    remainingTpm: remaining.tpmRemaining,
    remainingRpm: remaining.rpmRemaining,
    quotaRefresh: remaining.resetsIn
  };
}

function formatUsagePanel(summary) {
  return [
    `all_time_total_tokens: ${summary.allTimeTotalTokens}`,
    `session_total_tokens: ${summary.sessionTotalTokens}`,
    `session_estimated_tokens: ${summary.sessionEstimatedTokens}`,
    `model: ${summary.model}`,
    `remaining_tpm: ${summary.remainingTpm}`,
    `remaining_rpm: ${summary.remainingRpm}`,
    `quota_refresh: ${summary.quotaRefresh}`
  ];
}

function printUsageSummary({
  sessionUsage,
  estimatedTokens,
  routing,
  limitsByModel
}) {
  const summary = createUsageSummary({
    sessionUsage,
    estimatedTokens,
    routing,
    limitsByModel
  });
  console.log("Usage:");
  for (const line of formatUsagePanel(summary)) {
    console.log(`  ${line}`);
  }
}

function resolveVaultPath() {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  return config.vaultPath;
}

function normalizeSourcePath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  if (path.isAbsolute(raw) || /^[A-Za-z]:\//.test(normalized)) {
    return path.basename(normalized);
  }
  return normalized.replace(/^\.\//, "");
}

function emptyVaultMetadata(mode) {
  return {
    source: "obsidian",
    mode,
    retrieved_chunks: 0,
    retrieved_files: 0,
    context_length: 0,
    truncated: false,
    sources: []
  };
}

function classifyVaultContextIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  const hasManifestIntent =
    /\b(what|which|show|list|display)\b[^?!.]*(files|notes|folders|directories)\b/.test(text) ||
    /\b(files|notes|folders|directories)\b[^?!.]*\b(in|inside|under)\b[^?!.]*\bvault\b/.test(text) ||
    /\b(vault structure|folder structure|file list|note list)\b/.test(text);
  if (!hasManifestIntent) return "semantic";

  const hasSemanticIntent =
    /\b(about|contain|contains|mention|mentions|summarize|summary|explain|related|topic|search|find)\b/.test(
      text
    ) || /\b(files|notes)\b[^?!.]*\babout\b/.test(text);
  return hasSemanticIntent ? "hybrid" : "manifest";
}

function buildVaultAccessContract() {
  return [
    "Vault access contract:",
    "- The massa-vault CLI retrieved the Obsidian vault context below with the user's permission.",
    "- Treat this context as user-provided data for this request.",
    "- When vault context or a manifest is present, do not claim you cannot access the user's files.",
    "- You can answer only from the injected vault context and manifest, not arbitrary filesystem state."
  ].join("\n");
}

function getIndexFilePaths(indexData) {
  const paths = new Set();
  if (indexData?.snapshot && typeof indexData.snapshot === "object") {
    for (const filePath of Object.keys(indexData.snapshot)) {
      const normalized = normalizeSourcePath(filePath);
      if (normalized) paths.add(normalized);
    }
  }
  if (Array.isArray(indexData?.items)) {
    for (const item of indexData.items) {
      const normalized = normalizeSourcePath(item?.relativePath);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function asVaultMessages(message) {
  const content = String(message || "").trim();
  if (!content) return [{ role: "system", content: buildVaultAccessContract() }];
  return [
    { role: "system", content: buildVaultAccessContract() },
    { role: "system", content }
  ];
}

function buildVaultManifestPayload(filePaths, { maxChars = DEFAULT_RAG_MAX_CHARS } = {}) {
  const paths = Array.isArray(filePaths) ? filePaths.map(normalizeSourcePath).filter(Boolean) : [];
  const uniquePaths = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const intro = "Obsidian vault manifest (relative paths):";
  let message = intro;
  const sources = [];
  let truncated = false;

  if (!uniquePaths.length) {
    message += "\n[no markdown files found]";
    return {
      message,
      metadata: {
        ...emptyVaultMetadata("manifest"),
        context_length: message.length
      }
    };
  }

  for (const filePath of uniquePaths) {
    const line = `\n- ${filePath}`;
    if (message.length + line.length > maxChars) {
      truncated = true;
      break;
    }
    message += line;
    sources.push({ type: "file", path: filePath });
  }

  if (truncated) {
    const remaining = uniquePaths.length - sources.length;
    const suffix = `\n[manifest truncated: ${remaining} more file(s) omitted]`;
    if (message.length + suffix.length <= maxChars) {
      message += suffix;
    }
  }

  return {
    message,
    metadata: {
      source: "obsidian",
      mode: "manifest",
      retrieved_chunks: 0,
      retrieved_files: sources.length,
      total_files: uniquePaths.length,
      context_length: message.length,
      truncated,
      sources
    }
  };
}

function buildVaultContextPayload(
  results,
  { maxChars = DEFAULT_RAG_MAX_CHARS, mode = "semantic" } = {}
) {
  const items = Array.isArray(results) ? results : [];
  if (!items.length) {
    return {
      message: "No relevant Obsidian vault chunks were retrieved for this prompt.",
      metadata: emptyVaultMetadata(mode)
    };
  }

  const intro = "Relevant Obsidian vault context:";
  let message = intro;
  const sources = [];
  let truncated = false;

  for (const item of items) {
    const sourcePath = normalizeSourcePath(item?.filePath);
    const chunkText = String(item?.text || item?.snippet || "").trim();
    if (!sourcePath || !chunkText) continue;

    const chunkIndex = Number.isFinite(Number(item?.chunkIndex)) ? Number(item.chunkIndex) : 0;
    const score = Number.isFinite(Number(item?.score)) ? Number(item.score.toFixed(4)) : 0;
    const block = `[source ${sources.length + 1}] ${sourcePath}#${chunkIndex}\n${chunkText}`;
    const separator = "\n\n";
    const remainingChars = maxChars - message.length - separator.length;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    if (block.length > remainingChars) {
      if (remainingChars < 32) break;
      message += `${separator}${block.slice(0, remainingChars).trimEnd()}`;
      sources.push({
        type: "chunk",
        path: sourcePath,
        chunk_index: chunkIndex,
        score
      });
      truncated = true;
      break;
    }

    message += `${separator}${block}`;
    sources.push({
      type: "chunk",
      path: sourcePath,
      chunk_index: chunkIndex,
      score
    });
  }

  if (!sources.length) {
    return {
      message: "No relevant Obsidian vault chunks were retrieved for this prompt.",
      metadata: emptyVaultMetadata(mode)
    };
  }

  return {
    message,
    metadata: {
      source: "obsidian",
      mode,
      retrieved_chunks: sources.length,
      retrieved_files: new Set(sources.map((source) => source.path)).size,
      context_length: message.length,
      truncated,
      sources
    }
  };
}

function combineVaultPayloads(manifestPayload, semanticPayload, { maxChars = DEFAULT_RAG_MAX_CHARS } = {}) {
  const parts = [manifestPayload.message, semanticPayload.message].filter(Boolean);
  let message = parts.join("\n\n");
  let truncated = Boolean(manifestPayload.metadata.truncated || semanticPayload.metadata.truncated);

  if (message.length > maxChars) {
    message = message.slice(0, maxChars).trimEnd();
    truncated = true;
  }

  const sources = [
    ...(manifestPayload.metadata.sources || []),
    ...(semanticPayload.metadata.sources || [])
  ];

  return {
    message,
    metadata: {
      source: "obsidian",
      mode: "hybrid",
      retrieved_chunks: semanticPayload.metadata.retrieved_chunks,
      retrieved_files: manifestPayload.metadata.retrieved_files,
      total_files: manifestPayload.metadata.total_files,
      context_length: message.length,
      truncated,
      sources
    }
  };
}

async function buildVaultContext({
  prompt,
  limit = DEFAULT_RAG_CHUNK_LIMIT,
  maxChars = DEFAULT_RAG_MAX_CHARS
}) {
  const query = String(prompt || "").trim();
  if (!query) {
    return {
      message: "",
      messages: asVaultMessages(""),
      metadata: emptyVaultMetadata("semantic")
    };
  }

  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const defaults = getSearchDefaults();
  const { index } = await ensureSearchIndex({
    vaultPath: config.vaultPath,
    ignoreGlobs: config.ignoreGlobs || [],
    baseUrl: defaults.baseUrl,
    model: defaults.model
  });
  const mode = classifyVaultContextIntent(query);
  const filePaths = getIndexFilePaths(index);

  if (mode === "manifest") {
    const payload = buildVaultManifestPayload(filePaths, { maxChars });
    return {
      ...payload,
      messages: asVaultMessages(payload.message)
    };
  }

  const results = await searchIndex({
    indexData: index,
    query,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    limit,
    includeText: true
  });
  const semanticPayload = buildVaultContextPayload(results, { maxChars, mode });

  if (mode === "hybrid") {
    const manifestPayload = buildVaultManifestPayload(filePaths, {
      maxChars: Math.min(Math.floor(maxChars / 2), 2500)
    });
    const payload = combineVaultPayloads(manifestPayload, semanticPayload, { maxChars });
    return {
      ...payload,
      messages: asVaultMessages(payload.message)
    };
  }

  return {
    ...semanticPayload,
    messages: asVaultMessages(semanticPayload.message)
  };
}

async function runSearch({ query }) {
  const vaultPath = resolveVaultPath();
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const defaults = getSearchDefaults();
  const { index, rebuilt } = await ensureSearchIndex({
    vaultPath,
    ignoreGlobs: config.ignoreGlobs || [],
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

function getHelpLines() {
  return [
    "/help                 Show commands",
    "/save                 Save transcript and trigger sync",
    "/sync                 Save transcript (if needed) and trigger sync",
    "/exit                 Save transcript and exit",
    "/clear                Clear conversation memory",
    "/usage                Show token counters and quota estimates",
    "/config               Show active gateway/system settings",
    "/system show|set|clear Manage system prompt",
    "/routing              Show latest router metadata",
    "/search <query>       Semantic search in chats + vault markdown"
  ];
}

function printHelp() {
  console.log("Commands:");
  for (const line of getHelpLines()) {
    console.log(`  ${line}`);
  }
}

function buildTranscriptPayload({
  id,
  createdAt,
  gatewayUrl,
  history,
  routing,
  usage
}) {
  return {
    id,
    createdAt,
    gatewayUrl,
    model: DEFAULT_GATEWAY_MODEL,
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
  sessionUsage
}) {
  if (!history.length) return null;
  const vaultPath = resolveVaultPath();
  const gateway = buildGatewayOptions();
  return writeTranscript({
    vaultPath,
    ...buildTranscriptPayload({
      id: sessionId,
      createdAt: sessionStartedAt,
      gatewayUrl: gateway.gatewayUrl,
      history,
      routing: latestRouting,
      usage: sessionUsage
    })
  });
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runNotesAutomationCommand(args = []) {
  try {
    const output = execFileSync(process.execPath, [NOTES_AUTOMATION_CLI_PATH, ...args], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, output, payload: parseJsonOutput(output) };
  } catch (error) {
    const output = String(error?.stdout || error?.stderr || error?.message || "").trim();
    return { ok: false, output, payload: parseJsonOutput(output) };
  }
}

function formatSyncFeedback(result) {
  const payload = result?.payload && typeof result.payload === "object" ? result.payload : null;
  if (!payload) {
    if (result?.ok) return "[chat] sync completed.";
    return `[chat] sync failed: ${result?.output || "unknown error"}`;
  }

  const sync =
    payload.sync && typeof payload.sync === "object"
      ? payload.sync
      : payload.state && typeof payload.state?.sync === "object"
        ? payload.state.sync
        : {};
  const status = sync.status || (payload.ok ? "idle" : "error");
  const conflictCount = Number(sync.conflictCount || 0);
  const errorText = sync.lastError || payload.message || payload.error || "";
  const base = `[chat] sync status=${status} conflicts=${conflictCount}`;
  if (!payload.ok || errorText) {
    return `${base} error=${errorText || "unknown"}`;
  }
  return base;
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
    sessionUsage: state.sessionUsage
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
  return {
    history: [],
    sessionUsage: createSessionUsage(),
    estimatedTokensRef: { value: 0 },
    latestRouting: null,
    activeSystemPrompt: systemPrompt,
    sessionId: randomUUID(),
    sessionStartedAt: new Date().toISOString(),
    transcriptSavedPath: null,
    lastSavedHistoryLength: 0
  };
}

function resetConversation(state) {
  state.history.length = 0;
  state.estimatedTokensRef.value = 0;
  state.sessionUsage.prompt_tokens = 0;
  state.sessionUsage.completion_tokens = 0;
  state.sessionUsage.total_tokens = 0;
  state.latestRouting = null;
  state.transcriptSavedPath = null;
  state.lastSavedHistoryLength = 0;
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

async function executeCommand({
  line,
  state,
  limitsByModel,
  mode = "plain",
  handlers = {},
  onSaveAndSync = saveAndSyncSession
}) {
  const tuiHandlers = createTuiCommandHandlers(handlers);

  if (line === "/help") {
    if (mode === "plain") {
      printHelp();
    } else {
      tuiHandlers.panel("commands", getHelpLines());
    }
    return { handled: true, exit: false };
  }

  if (line === "/exit") {
    return { handled: true, exit: true };
  }

  if (line === "/save") {
    const result = await onSaveAndSync(state, { reason: "chat-manual-save" });
    const transcriptMessage = result.saveResult.path
      ? `[chat] transcript saved: ${result.saveResult.path}`
      : "[chat] nothing to save";
    if (mode === "plain") {
      console.log(transcriptMessage);
      console.log(result.summary);
    } else {
      tuiHandlers.message(transcriptMessage);
      tuiHandlers.message(result.summary);
    }
    return { handled: true, exit: false };
  }

  if (line === "/sync") {
    const result = await onSaveAndSync(state, { reason: "chat-manual-sync" });
    const transcriptMessage = result.saveResult.path
      ? `[chat] transcript saved: ${result.saveResult.path}`
      : "[chat] transcript already up to date";
    if (mode === "plain") {
      console.log(transcriptMessage);
      console.log(result.summary);
    } else {
      tuiHandlers.message(transcriptMessage);
      tuiHandlers.message(result.summary);
    }
    return { handled: true, exit: false };
  }

  if (line.startsWith("/sync ")) {
    const subcommand = line.slice(6).trim().toLowerCase();
    const notesArgs =
      subcommand === "status"
        ? ["status"]
        : subcommand === "conflicts"
          ? ["sync-conflicts"]
          : null;
    if (!notesArgs) {
      const usage = "usage: /sync | /sync status | /sync conflicts";
      if (mode === "plain") {
        console.log(usage);
      } else {
        tuiHandlers.message(usage);
      }
      return { handled: true, exit: false };
    }

    const result = runNotesAutomationCommand(notesArgs);
    const summary = formatSyncFeedback(result);
    if (mode === "plain") {
      console.log(summary);
      if (result.output) {
        console.log(result.output);
      }
    } else {
      tuiHandlers.message(summary);
      if (result.output) {
        tuiHandlers.panel("sync", result.output.split("\n"));
      }
    }
    return { handled: true, exit: false };
  }

  if (line === "/clear") {
    resetConversation(state);
    if (mode === "plain") {
      console.log("[chat] conversation cleared");
    } else {
      tuiHandlers.message("[chat] conversation cleared");
    }
    return { handled: true, exit: false };
  }

  if (line === "/usage") {
    if (mode === "plain") {
      printUsageSummary({
        sessionUsage: state.sessionUsage,
        estimatedTokens: state.estimatedTokensRef.value,
        routing: state.latestRouting,
        limitsByModel
      });
    } else {
      const summary = createUsageSummary({
        sessionUsage: state.sessionUsage,
        estimatedTokens: state.estimatedTokensRef.value,
        routing: state.latestRouting,
        limitsByModel
      });
      tuiHandlers.panel("usage", formatUsagePanel(summary));
    }
    return { handled: true, exit: false };
  }

  if (line === "/config") {
    const gateway = buildGatewayOptions();
    const lines = [
      `gateway_url: ${gateway.gatewayUrl}`,
      `system_prompt: ${state.activeSystemPrompt ? "configured" : "empty"}`,
      `auth_header: ${gateway.apiKey ? "enabled" : "disabled"}`,
      `vault_context: ${isVaultContextEnabled() ? "auto" : "disabled"}`,
      `vault_context_modes: ${VAULT_CONTEXT_MODES.join(", ")}`
    ];
    if (mode === "plain") {
      for (const nextLine of lines) {
        console.log(nextLine);
      }
    } else {
      tuiHandlers.panel("config", lines);
    }
    return { handled: true, exit: false };
  }

  if (line.startsWith("/system")) {
    const [, action, ...rest] = line.split(" ");
    if (action === "show") {
      if (mode === "plain") {
        console.log(state.activeSystemPrompt || "[empty]");
      } else {
        tuiHandlers.panel("system", [state.activeSystemPrompt || "[empty]"]);
      }
    } else if (action === "set") {
      state.activeSystemPrompt = rest.join(" ").trim();
      if (mode === "plain") {
        console.log("[chat] system prompt updated");
      } else {
        tuiHandlers.message("[chat] system prompt updated");
      }
    } else if (action === "clear") {
      state.activeSystemPrompt = "";
      if (mode === "plain") {
        console.log("[chat] system prompt cleared");
      } else {
        tuiHandlers.message("[chat] system prompt cleared");
      }
    } else if (mode === "plain") {
      console.log("usage: /system show|set <prompt>|clear");
    } else {
      tuiHandlers.panel("system", ["usage: /system show|set <prompt>|clear"]);
    }
    return { handled: true, exit: false };
  }

  if (line === "/routing") {
    if (!state.latestRouting) {
      if (mode === "plain") {
        console.log("[chat] no routing metadata yet");
      } else {
        tuiHandlers.message("[chat] no routing metadata yet");
      }
      return { handled: true, exit: false };
    }

    if (mode === "plain") {
      console.log(JSON.stringify(state.latestRouting, null, 2));
    } else {
      tuiHandlers.panel("routing", JSON.stringify(state.latestRouting, null, 2).split("\n"));
    }
    return { handled: true, exit: false };
  }

  if (line.startsWith("/search ")) {
    const query = line.slice(8).trim();
    const searchResult = await runSearch({ query });
    if (mode === "plain") {
      printSearchPlain(searchResult);
    } else {
      tuiHandlers.panel("search", formatSearchPanel(searchResult));
    }
    return { handled: true, exit: false };
  }

  return { handled: false, exit: false };
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
  onWarning
}) {
  const gateway = buildGatewayOptions();
  const emitWarning = (message) => {
    if (renderMode === "plain") {
      console.error(message);
    }
    onWarning?.(message);
  };

  let vaultContext = null;
  if (isVaultContextEnabled()) {
    try {
      vaultContext = await vaultContextBuilder({ prompt });
    } catch (error) {
      emitWarning(
        `[chat] warning: vault context unavailable (${error instanceof Error ? error.message : String(error)}). continuing without context.`
      );
    }
  }

  const userMessage = { role: "user", content: prompt };
  const estimatedStart = estimatedTokensRef.value;
  const estimatedPromptTokens = estimateTokensFromText(prompt);
  history.push(userMessage);
  estimatedTokensRef.value += estimatedPromptTokens;

  const requestMessages = buildMessages(history, systemPrompt);
  const vaultMessages = Array.isArray(vaultContext?.messages)
    ? vaultContext.messages
    : vaultContext?.message
      ? [{ role: "system", content: vaultContext.message }]
      : [];
  const normalizedVaultMessages = vaultMessages
    .map((message) => ({
      role: message?.role || "system",
      content: String(message?.content || "").trim()
    }))
    .filter((message) => message.content);
  if (normalizedVaultMessages.length && requestMessages.length) {
    requestMessages.splice(requestMessages.length - 1, 0, ...normalizedVaultMessages);
  }

  let routing = null;
  let usage = null;
  let assistantText = "";
  let renderedAssistantChunk = false;
  let emittedAssistantChunk = false;

  onThinkingChange?.(true);

  if (renderMode === "plain") {
    if (!statusRenderer?.isEnabled()) {
      console.log(`\nUser: ${prompt}`);
      outputStream.write("Assistant: ");
    } else {
      outputStream.write("assistant> ");
    }
  }

  const response = await chatCompletion({
    baseUrl: gateway.gatewayUrl,
    apiKey: gateway.apiKey,
    body: {
      model: DEFAULT_GATEWAY_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: requestMessages,
      ...(vaultContext?.metadata ? { context: vaultContext.metadata } : {})
    },
    onRouting: (metadata) => {
      routing = metadata;
      onRouting?.(metadata);
    },
    onDelta: (chunk) => {
      if (!emittedAssistantChunk) {
        onThinkingChange?.(false);
      }
      emittedAssistantChunk = true;
      renderedAssistantChunk = true;
      if (renderMode === "plain") {
        outputStream.write(chunk);
      }
      estimatedTokensRef.value += estimateTokensFromText(chunk);
      onAssistantDelta?.(chunk);
    },
    onUsage: (nextUsage) => {
      usage = asUsage(nextUsage);
      onUsage?.(usage);
    }
  });

  onThinkingChange?.(false);

  assistantText = response.assistantText;
  if (!renderedAssistantChunk && assistantText) {
    if (renderMode === "plain") {
      outputStream.write(assistantText);
    }
    onAssistantDelta?.(assistantText);
    emittedAssistantChunk = true;
  }
  if (!usage) {
    const estimatedRequestTokens = Math.max(0, estimatedTokensRef.value - estimatedStart);
    usage = {
      prompt_tokens: estimatedPromptTokens,
      completion_tokens: Math.max(0, estimatedRequestTokens - estimatedPromptTokens),
      total_tokens: estimatedRequestTokens
    };
    onUsage?.(usage);
  }

  if (!assistantText.trim()) {
    assistantText = "[no content]";
    if (!emittedAssistantChunk) {
      onAssistantDelta?.(assistantText);
    }
  }
  history.push({ role: "assistant", content: assistantText });

  if (renderMode === "plain") {
    outputStream.write("\n");
  }

  accumulateSessionUsage(sessionUsage, usage);
  const ledger = addUsageToLedger({
    usage,
    modelName: routing?.targetModel || DEFAULT_GATEWAY_MODEL
  });

  const statusState = createStatusState({
    sessionUsage,
    estimatedTokens: estimatedTokensRef.value,
    routing,
    ledgerTotals: ledger.totals,
    authEnabled: Boolean(gateway.apiKey)
  });

  if (renderMode === "plain") {
    statusRenderer?.render(createStatusLine(statusState));
  }

  return {
    usage,
    routing,
    assistantText,
    statusState
  };
}

async function runPlainRepl({ systemPrompt }) {
  const rl = readlinePromises.createInterface({ input, output });
  const state = createReplState({ systemPrompt });
  const statusRenderer = createStatusRenderer();
  const limitsByModel = readLiteLLMLimits();
  const idleSyncMs = Number.isFinite(DEFAULT_IDLE_SYNC_MS) ? Math.max(DEFAULT_IDLE_SYNC_MS, 5000) : 30_000;
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

  console.log("massa-vault chat started. type /help for commands.");

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
        state.transcriptSavedPath = null;
        const result = await processPrompt({
          prompt: line,
          history: state.history,
          systemPrompt: state.activeSystemPrompt,
          sessionUsage: state.sessionUsage,
          estimatedTokensRef: state.estimatedTokensRef,
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
  const history = [];
  const sessionUsage = createSessionUsage();
  const estimatedTokensRef = { value: 0 };
  const statusRenderer = createStatusRenderer();

  let latestRouting = null;
  try {
    const result = await processPrompt({
      prompt,
      history,
      systemPrompt,
      sessionUsage,
      estimatedTokensRef,
      statusRenderer
    });
    latestRouting = result.routing;
  } finally {
    statusRenderer.clear();
  }

  const filePath = await saveTranscript({
    sessionId: randomUUID(),
    sessionStartedAt: new Date().toISOString(),
    history,
    latestRouting,
    sessionUsage
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
  createReplState,
  createStatusLine,
  createStatusRenderer,
  createStatusState,
  createUsageSummary,
  executeCommand,
  formatSearchPanel,
  formatUsagePanel,
  getHelpLines,
  isInteractiveTuiSupported,
  isVaultContextEnabled,
  main,
  processPrompt,
  resetConversation,
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
