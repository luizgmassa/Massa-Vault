import {
  resolveDefaultGatewayModel,
  buildGatewayOptions,
  isVaultContextEnabled
} from "../infrastructure/chat-config.js";
import {
  createUsageSummary,
  formatUsagePanel,
  formatUsageScreenLines,
  printUsageSummary
} from "./chat-status.js";
import {
  loadTranscriptIntoSession,
  resetChatSession
} from "./chat-session.js";
import {
  HISTORY_FLOW_PREVIEW,
  HISTORY_FLOW_SUMMARY,
  createHistoryClient
} from "./history.js";
import { runSearch } from "./search-runner.js";
import {
  formatSearchPanel,
  formatSearchScreenLines,
  printSearchPlain
} from "../commands/search-ui.js";
import { createSyncClient } from "../infrastructure/sync-client.js";
import { readTranscript } from "../infrastructure/transcripts.js";
import { saveAndSyncSession } from "./transcript-store.js";
import { accumulateSessionUsage } from "../domain/usage.js";
import {
  addUsageToLedger
} from "./usage.js";
import {
  DEFAULT_RAG_MAX_CHARS,
  VAULT_CONTEXT_MODES
} from "../domain/vault-context.js";
import { createModelManagerClient } from "./model-manager.js";

const { createCommandRuntime } = await import("../commands/runtime.js");

function asUsage(usage) {
  return {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0)
  };
}

export function createDefaultCommandRuntime({
  historySearchRunner = runSearch,
  transcriptReader = readTranscript,
  transcriptMarkdownReader,
  historySummaryRunner,
  saveAndSync = saveAndSyncSession,
  syncClient = createSyncClient(),
  modelManagerClient = createModelManagerClient()
} = {}) {
  const historyClient = createHistoryClient({
    searchRunner: historySearchRunner,
    transcriptReader,
    transcriptMarkdownReader,
    summaryRunner: historySummaryRunner
  });

  return createCommandRuntime({
    config: {
      defaultGatewayModel: resolveDefaultGatewayModel(),
      defaultRagMaxChars: DEFAULT_RAG_MAX_CHARS,
      historyFlowPreview: HISTORY_FLOW_PREVIEW,
      historyFlowSummary: HISTORY_FLOW_SUMMARY,
      vaultContextModes: VAULT_CONTEXT_MODES,
      isVaultContextEnabled
    },
    syncClient: {
      saveAndSync,
      formatSyncFeedback: syncClient.formatSyncFeedback,
      readLocalSyncStatusModel: syncClient.readLocalSyncStatusModel,
      syncStatusModelFromResult: syncClient.syncStatusModelFromResult,
      runNotesAutomationCommand: syncClient.runNotesAutomationCommand
    },
    historyClient,
    usageClient: {
      addUsageToLedger,
      accumulateSessionUsage,
      asUsage,
      createUsageSummary,
      formatUsagePanel,
      formatUsageScreenLines,
      printUsageSummary
    },
    searchClient: {
      formatSearchPanel,
      formatSearchScreenLines,
      printSearchPlain
    },
    modelManagerClient,
    sessionClient: {
      loadTranscript: (session, payload) =>
        loadTranscriptIntoSession(session, {
          ...payload,
          fallbackSessionId: session.sessionId,
          fallbackSessionStartedAt: session.sessionStartedAt,
          fallbackGatewayUrl: buildGatewayOptions().gatewayUrl,
          fallbackModel: resolveDefaultGatewayModel()
        }),
      resetSession: resetChatSession
    }
  });
}

export async function executeCommand({
  line,
  state,
  limitsByModel,
  mode = "plain",
  handlers = {},
  onSaveAndSync,
  historySearchRunner = runSearch,
  transcriptReader = readTranscript,
  transcriptMarkdownReader,
  historySummaryRunner
}) {
  const runtime = createDefaultCommandRuntime({
    historySearchRunner,
    transcriptReader,
    transcriptMarkdownReader,
    historySummaryRunner
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
