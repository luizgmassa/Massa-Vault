#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
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

function createReplState({ systemPrompt }) {
  return {
    history: [],
    sessionUsage: createSessionUsage(),
    estimatedTokensRef: { value: 0 },
    latestRouting: null,
    activeSystemPrompt: systemPrompt,
    sessionId: randomUUID(),
    sessionStartedAt: new Date().toISOString(),
    transcriptSavedPath: null
  };
}

function resetConversation(state) {
  state.history.length = 0;
  state.estimatedTokensRef.value = 0;
  state.sessionUsage.prompt_tokens = 0;
  state.sessionUsage.completion_tokens = 0;
  state.sessionUsage.total_tokens = 0;
  state.latestRouting = null;
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
  handlers = {}
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
      `auth_header: ${gateway.apiKey ? "enabled" : "disabled"}`
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
  outputStream = output,
  renderMode = "plain",
  onThinkingChange,
  onAssistantDelta,
  onUsage,
  onRouting
}) {
  const gateway = buildGatewayOptions();
  const userMessage = { role: "user", content: prompt };
  const estimatedStart = estimatedTokensRef.value;
  const estimatedPromptTokens = estimateTokensFromText(prompt);
  history.push(userMessage);
  estimatedTokensRef.value += estimatedPromptTokens;

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
      messages: buildMessages(history, systemPrompt)
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

  console.log("massa-vault chat started. type /help for commands.");

  try {
    while (true) {
      const line = (await rl.question("you> ")).trim();
      if (!line) continue;

      const commandResult = await executeCommand({
        line,
        state,
        limitsByModel,
        mode: "plain"
      });
      if (commandResult.handled) {
        if (commandResult.exit) {
          state.transcriptSavedPath = await saveTranscript({
            sessionId: state.sessionId,
            sessionStartedAt: state.sessionStartedAt,
            history: state.history,
            latestRouting: state.latestRouting,
            sessionUsage: state.sessionUsage
          });
          if (state.transcriptSavedPath) {
            console.log(`[chat] transcript saved: ${state.transcriptSavedPath}`);
          }
          break;
        }
        continue;
      }

      try {
        const result = await processPrompt({
          prompt: line,
          history: state.history,
          systemPrompt: state.activeSystemPrompt,
          sessionUsage: state.sessionUsage,
          estimatedTokensRef: state.estimatedTokensRef,
          statusRenderer
        });
        state.latestRouting = result.routing;
      } catch (error) {
        output.write("\n");
        console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (!state.transcriptSavedPath && state.history.length) {
      state.transcriptSavedPath = await saveTranscript({
        sessionId: state.sessionId,
        sessionStartedAt: state.sessionStartedAt,
        history: state.history,
        latestRouting: state.latestRouting,
        sessionUsage: state.sessionUsage
      });
      if (state.transcriptSavedPath) {
        console.log(`[chat] transcript saved: ${state.transcriptSavedPath}`);
      }
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
  buildGatewayOptions,
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
  main,
  processPrompt,
  resetConversation,
  runOneShot,
  runPlainRepl,
  runRepl,
  saveTranscript
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    output.write("\n");
    console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
