#!/usr/bin/env node
import { stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import {
  completeCommandInput,
  getCommandDefinitions,
  getCommandSuggestions,
  resolveCommandSubmission
} from "./commands.js";
import {
  DEFAULT_GATEWAY_MODEL,
  buildGatewayOptions,
  isVaultContextEnabled,
  readLocalSyncStatusModel
} from "./infrastructure/chat-config.js";
import {
  createStatusLine,
  createStatusRenderer,
  createStatusState,
  createUsageSummary,
  formatUsagePanel
} from "./services/chat-status.js";
import {
  createChatSession,
  resetChatSession
} from "./services/chat-session.js";
import { runPrompt } from "./services/chat-runtime.js";
import {
  createChatMain,
  main,
  isInteractiveTuiSupported,
  runOneShot,
  runRepl
} from "./cli/main.js";
import { executeCommand } from "./services/command-executor.js";
import {
  createPlainReplRunner,
  runPlainRepl
} from "./cli/plain-repl.js";
import { formatSearchPanel } from "./commands/search-ui.js";
import { createSyncClient } from "./infrastructure/sync-client.js";
import { createStartupWarmup } from "./cli/startup-warmup.js";
import {
  createTranscriptSessionStore,
  saveAndSyncSession,
  saveTranscript
} from "./services/transcript-store.js";
import {
  buildVaultAccessContract,
  buildVaultContextPayload,
  buildVaultManifestPayload,
  classifyVaultContextIntent
} from "./domain/vault-context.js";
import { buildVaultContext } from "./services/vault-context.js";

function createReplState({ systemPrompt }) {
  return createChatSession({ systemPrompt });
}

function resetConversation(state) {
  return resetChatSession(state);
}

async function processPrompt({
  prompt,
  history,
  systemPrompt,
  sessionUsage,
  estimatedTokensRef,
  statusRenderer,
  chatCompletion,
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

export {
  DEFAULT_GATEWAY_MODEL,
  buildGatewayOptions,
  buildVaultAccessContract,
  buildVaultContext,
  buildVaultContextPayload,
  buildVaultManifestPayload,
  classifyVaultContextIntent,
  createChatMain,
  completeCommandInput,
  createChatSession,
  createPlainReplRunner,
  createStartupWarmup,
  createReplState,
  createSyncClient,
  createStatusLine,
  createStatusRenderer,
  createStatusState,
  createTranscriptSessionStore,
  createUsageSummary,
  executeCommand,
  formatSearchPanel,
  formatUsagePanel,
  getCommandDefinitions,
  getCommandSuggestions,
  isInteractiveTuiSupported,
  isVaultContextEnabled,
  main,
  processPrompt,
  readLocalSyncStatusModel,
  resetConversation,
  resolveCommandSubmission,
  runOneShot,
  runPlainRepl,
  runPrompt,
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
