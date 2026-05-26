#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
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

function createStatusLine(state) {
  const lane = state.routing?.lane || "unknown";
  const model = state.routing?.targetModel || DEFAULT_GATEWAY_MODEL;
  return (
    `[tokens session=${state.sessionUsage.total_tokens}` +
    ` all_time=${state.ledgerTotals.total_tokens}` +
    ` est=${state.estimatedTokens}` +
    ` lane=${lane}` +
    ` model=${model}]`
  );
}

function createStatusRenderer() {
  let previousLength = 0;
  const canRender = Boolean(stderr.isTTY);

  return {
    render(text) {
      if (!canRender) return;
      const line = String(text || "");
      readline.cursorTo(stderr, 0);
      readline.clearLine(stderr, 0);
      stderr.write(line);
      previousLength = line.length;
    },
    clear() {
      if (!canRender) return;
      readline.cursorTo(stderr, 0);
      readline.clearLine(stderr, 0);
      if (previousLength > 0) {
        stderr.write("\n");
      }
      previousLength = 0;
    },
    isEnabled() {
      return canRender;
    }
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

function printUsageSummary({
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

  console.log("Usage:");
  console.log(`  all_time_total_tokens: ${ledger.totals.total_tokens}`);
  console.log(`  session_total_tokens: ${sessionUsage.total_tokens}`);
  console.log(`  session_estimated_tokens: ${estimatedTokens}`);
  console.log(`  model: ${remaining.model}`);
  console.log(`  remaining_tpm: ${remaining.tpmRemaining}`);
  console.log(`  remaining_rpm: ${remaining.rpmRemaining}`);
  console.log(`  quota_refresh: ${remaining.resetsIn}`);
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

  if (rebuilt) {
    console.log("[chat-search] index rebuilt");
  }
  if (!results.length) {
    console.log("[chat-search] no results");
    return;
  }

  for (const result of results) {
    console.log(
      `- ${result.filePath}#${result.chunkIndex} score=${result.score.toFixed(4)} ${result.snippet}`
    );
  }
}

async function processPrompt({
  prompt,
  history,
  systemPrompt,
  sessionUsage,
  estimatedTokensRef,
  statusRenderer,
  limitsByModel
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

  const baseStatus = () =>
    createStatusLine({
      sessionUsage,
      estimatedTokens: estimatedTokensRef.value,
      routing,
      ledgerTotals: getUsageLedger().totals
    });

  if (!statusRenderer.isEnabled()) {
    console.log(`\nUser: ${prompt}`);
    process.stdout.write("Assistant: ");
  } else {
    statusRenderer.render(baseStatus());
    output.write("\n");
    process.stdout.write("assistant> ");
  }

  const response = await streamChatCompletion({
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
      statusRenderer.render(baseStatus());
    },
    onDelta: (chunk) => {
      renderedAssistantChunk = true;
      process.stdout.write(chunk);
      estimatedTokensRef.value += estimateTokensFromText(chunk);
      statusRenderer.render(baseStatus());
    },
    onUsage: (nextUsage) => {
      usage = asUsage(nextUsage);
      statusRenderer.render(baseStatus());
    }
  });

  assistantText = response.assistantText;
  if (!renderedAssistantChunk && assistantText) {
    process.stdout.write(assistantText);
  }
  if (!usage) {
    const estimatedRequestTokens = Math.max(0, estimatedTokensRef.value - estimatedStart);
    usage = {
      prompt_tokens: estimatedPromptTokens,
      completion_tokens: Math.max(0, estimatedRequestTokens - estimatedPromptTokens),
      total_tokens: estimatedRequestTokens
    };
  }

  if (!assistantText.trim()) {
    assistantText = "[no content]";
  }
  history.push({ role: "assistant", content: assistantText });

  output.write("\n");
  accumulateSessionUsage(sessionUsage, usage);
  const ledger = addUsageToLedger({
    usage,
    modelName: routing?.targetModel || DEFAULT_GATEWAY_MODEL
  });
  statusRenderer.render(
    createStatusLine({
      sessionUsage,
      estimatedTokens: estimatedTokensRef.value,
      routing,
      ledgerTotals: ledger.totals
    })
  );

  return {
    usage,
    routing
  };
}

function printHelp() {
  console.log("Commands:");
  console.log("  /help                 Show commands");
  console.log("  /exit                 Save transcript and exit");
  console.log("  /clear                Clear conversation memory");
  console.log("  /usage                Show token counters and quota estimates");
  console.log("  /config               Show active gateway/system settings");
  console.log("  /system show|set|clear Manage system prompt");
  console.log("  /routing              Show latest router metadata");
  console.log("  /search <query>       Semantic search in chats + vault markdown");
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

async function runRepl({ systemPrompt }) {
  const rl = readlinePromises.createInterface({ input, output });
  const history = [];
  const sessionUsage = createSessionUsage();
  const estimatedTokensRef = { value: 0 };
  const statusRenderer = createStatusRenderer();
  const limitsByModel = readLiteLLMLimits();
  const sessionId = randomUUID();
  const sessionStartedAt = new Date().toISOString();

  let latestRouting = null;
  let activeSystemPrompt = systemPrompt;
  let transcriptSavedPath = null;
  console.log("massa-vault chat started. type /help for commands.");

  try {
    while (true) {
      const line = (await rl.question("you> ")).trim();
      if (!line) continue;

      if (line === "/help") {
        printHelp();
        continue;
      }

      if (line === "/exit") {
        transcriptSavedPath = await saveTranscript({
          sessionId,
          sessionStartedAt,
          history,
          latestRouting,
          sessionUsage
        });
        if (transcriptSavedPath) {
          console.log(`[chat] transcript saved: ${transcriptSavedPath}`);
        }
        break;
      }

      if (line === "/clear") {
        history.length = 0;
        estimatedTokensRef.value = 0;
        sessionUsage.prompt_tokens = 0;
        sessionUsage.completion_tokens = 0;
        sessionUsage.total_tokens = 0;
        latestRouting = null;
        console.log("[chat] conversation cleared");
        continue;
      }

      if (line === "/usage") {
        printUsageSummary({
          sessionUsage,
          estimatedTokens: estimatedTokensRef.value,
          routing: latestRouting,
          limitsByModel
        });
        continue;
      }

      if (line === "/config") {
        const gateway = buildGatewayOptions();
        console.log(`gateway_url: ${gateway.gatewayUrl}`);
        console.log(`system_prompt: ${activeSystemPrompt ? "configured" : "empty"}`);
        console.log(`auth_header: ${gateway.apiKey ? "enabled" : "disabled"}`);
        continue;
      }

      if (line.startsWith("/system")) {
        const [, action, ...rest] = line.split(" ");
        if (action === "show") {
          console.log(activeSystemPrompt || "[empty]");
        } else if (action === "set") {
          activeSystemPrompt = rest.join(" ").trim();
          console.log("[chat] system prompt updated");
        } else if (action === "clear") {
          activeSystemPrompt = "";
          console.log("[chat] system prompt cleared");
        } else {
          console.log("usage: /system show|set <prompt>|clear");
        }
        continue;
      }

      if (line === "/routing") {
        if (!latestRouting) {
          console.log("[chat] no routing metadata yet");
        } else {
          console.log(JSON.stringify(latestRouting, null, 2));
        }
        continue;
      }

      if (line.startsWith("/search ")) {
        await runSearch({ query: line.slice(8).trim() });
        continue;
      }

      try {
        const result = await processPrompt({
          prompt: line,
          history,
          systemPrompt: activeSystemPrompt,
          sessionUsage,
          estimatedTokensRef,
          statusRenderer,
          limitsByModel
        });
        latestRouting = result.routing;
      } catch (error) {
        output.write("\n");
        console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (!transcriptSavedPath && history.length) {
      transcriptSavedPath = await saveTranscript({
        sessionId,
        sessionStartedAt,
        history,
        latestRouting,
        sessionUsage
      });
      if (transcriptSavedPath) {
        console.log(`[chat] transcript saved: ${transcriptSavedPath}`);
      }
    }
    statusRenderer.clear();
    rl.close();
  }
}

async function runOneShot({ prompt, systemPrompt }) {
  const history = [];
  const sessionUsage = createSessionUsage();
  const estimatedTokensRef = { value: 0 };
  const statusRenderer = createStatusRenderer();
  const limitsByModel = readLiteLLMLimits();

  let latestRouting = null;
  try {
    const result = await processPrompt({
      prompt,
      history,
      systemPrompt,
      sessionUsage,
      estimatedTokensRef,
      statusRenderer,
      limitsByModel
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
    await runSearch({ query });
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

main().catch((error) => {
  output.write("\n");
  console.error(`[chat] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
