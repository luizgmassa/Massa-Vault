import { stdout as output } from "node:process";
import {
  DEFAULT_GATEWAY_MODEL,
  buildGatewayOptions,
  isVaultContextEnabled
} from "../infrastructure/chat-config.js";
import { createStatusLine, createStatusState } from "./chat-status.js";
import { streamChatCompletion } from "../infrastructure/gateway.js";
import { estimateTokensFromText } from "../domain/token-estimator.js";
import { accumulateSessionUsage } from "../domain/usage.js";
import { addUsageToLedger } from "./usage.js";
import { buildVaultContext } from "./vault-context.js";

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

function normalizeContextMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message?.role || "system",
      content: String(message?.content || "").trim()
    }))
    .filter((message) => message.content);
}

function sessionContextMessages(session) {
  return normalizeContextMessages(
    (Array.isArray(session?.addedContextEntries) ? session.addedContextEntries : []).map((entry) => ({
      role: "system",
      content: entry?.content
    }))
  );
}

export async function runPrompt(
  session,
  {
    prompt,
    callbacks,
    chatCompletion = streamChatCompletion,
    vaultContextBuilder = buildVaultContext,
    outputStream = output,
    renderMode = "plain",
    statusRenderer,
    onThinkingChange,
    onAssistantDelta,
    onUsage,
    onRouting,
    onWarning
  } = {}
) {
  const hookBag = callbacks && typeof callbacks === "object" ? callbacks : {};
  const thinkingHook = onThinkingChange || hookBag.onThinkingChange;
  const assistantDeltaHook = onAssistantDelta || hookBag.onAssistantDelta;
  const usageHook = onUsage || hookBag.onUsage;
  const routingHook = onRouting || hookBag.onRouting;
  const warningHook = onWarning || hookBag.onWarning;
  const gateway = buildGatewayOptions();
  const emitWarning = (message) => {
    if (renderMode === "plain") {
      console.error(message);
    }
    warningHook?.(message);
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
  const estimatedStart = session.estimatedTokensRef.value;
  const estimatedPromptTokens = estimateTokensFromText(prompt);
  session.history.push(userMessage);
  session.estimatedTokensRef.value += estimatedPromptTokens;

  const requestMessages = buildMessages(session.history, session.activeSystemPrompt);
  const normalizedVaultMessages = normalizeContextMessages(
    Array.isArray(vaultContext?.messages)
      ? vaultContext.messages
      : vaultContext?.message
        ? [{ role: "system", content: vaultContext.message }]
        : []
  );
  const contextMessages = [...sessionContextMessages(session), ...normalizedVaultMessages];
  if (contextMessages.length && requestMessages.length) {
    requestMessages.splice(requestMessages.length - 1, 0, ...contextMessages);
  }

  let routing = null;
  let usage = null;
  let assistantText = "";
  let renderedAssistantChunk = false;
  let emittedAssistantChunk = false;
  let lastRoutingWarning = null;

  thinkingHook?.(true);

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
      const fallbackWarning = String(metadata?.fallbackWarning || "").trim();
      if (fallbackWarning && fallbackWarning !== lastRoutingWarning) {
        lastRoutingWarning = fallbackWarning;
        emitWarning(`[chat] warning: ${fallbackWarning}`);
      }
      routingHook?.(metadata);
    },
    onDelta: (chunk) => {
      if (!emittedAssistantChunk) {
        thinkingHook?.(false);
      }
      emittedAssistantChunk = true;
      renderedAssistantChunk = true;
      if (renderMode === "plain") {
        outputStream.write(chunk);
      }
      session.estimatedTokensRef.value += estimateTokensFromText(chunk);
      assistantDeltaHook?.(chunk);
    },
    onUsage: (nextUsage) => {
      usage = asUsage(nextUsage);
      usageHook?.(usage);
    }
  });

  thinkingHook?.(false);

  assistantText = response.assistantText;
  if (!renderedAssistantChunk && assistantText) {
    if (renderMode === "plain") {
      outputStream.write(assistantText);
    }
    assistantDeltaHook?.(assistantText);
    emittedAssistantChunk = true;
  }
  if (!usage) {
    const estimatedRequestTokens = Math.max(0, session.estimatedTokensRef.value - estimatedStart);
    usage = {
      prompt_tokens: estimatedPromptTokens,
      completion_tokens: Math.max(0, estimatedRequestTokens - estimatedPromptTokens),
      total_tokens: estimatedRequestTokens
    };
    usageHook?.(usage);
  }

  if (!assistantText.trim()) {
    assistantText = "[no content]";
    if (!emittedAssistantChunk) {
      assistantDeltaHook?.(assistantText);
    }
  }
  session.history.push({ role: "assistant", content: assistantText });

  if (renderMode === "plain") {
    outputStream.write("\n");
  }

  accumulateSessionUsage(session.sessionUsage, usage);
  const ledger = addUsageToLedger({
    usage,
    modelName: routing?.targetModel || DEFAULT_GATEWAY_MODEL
  });

  session.latestRouting = routing;
  session.addedContextEntries = [];

  const statusState = createStatusState({
    sessionUsage: session.sessionUsage,
    estimatedTokens: session.estimatedTokensRef.value,
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
