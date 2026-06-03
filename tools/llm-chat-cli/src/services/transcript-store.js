import {
  DEFAULT_GATEWAY_MODEL,
  buildGatewayOptions,
  resolveVaultPath
} from "../infrastructure/chat-config.js";
import { createSyncClient } from "../infrastructure/sync-client.js";
import { writeTranscript } from "../infrastructure/transcripts.js";

export function buildTranscriptPayload({
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

export function createTranscriptSessionStore({
  resolveVaultPathFn = resolveVaultPath,
  buildGatewayOptionsFn = buildGatewayOptions,
  defaultGatewayModel = DEFAULT_GATEWAY_MODEL,
  writeTranscriptImpl = writeTranscript,
  syncClient = createSyncClient()
} = {}) {
  const saveTranscript = async ({
    sessionId,
    sessionStartedAt,
    history,
    latestRouting,
    sessionUsage,
    activeTranscript
  }) => {
    if (!history.length) return null;
    const vaultPath = resolveVaultPathFn();
    const gateway = buildGatewayOptionsFn();
    const metadata =
      activeTranscript && typeof activeTranscript === "object" ? activeTranscript : null;
    return writeTranscriptImpl({
      filePath: metadata?.path || null,
      vaultPath,
      ...buildTranscriptPayload({
        id: metadata?.id || sessionId,
        createdAt: metadata?.createdAt || sessionStartedAt,
        gatewayUrl: metadata?.gatewayUrl || gateway.gatewayUrl,
        history,
        model: metadata?.model || defaultGatewayModel,
        routing: latestRouting || metadata?.routing || null,
        usage: sessionUsage
      })
    });
  };

  const persistSession = async (state) => {
    if (state.transcriptSavedPath && state.lastSavedHistoryLength === state.history.length) {
      return { path: state.transcriptSavedPath, saved: false };
    }

    const filePath = await saveTranscript({
      sessionId: state.sessionId,
      sessionStartedAt: state.sessionStartedAt,
      history: state.history,
      latestRouting: state.latestRouting,
      sessionUsage: state.sessionUsage,
      activeTranscript: state.activeTranscript
    });
    if (!filePath) {
      return { path: null, saved: false };
    }

    state.transcriptSavedPath = filePath;
    state.lastSavedHistoryLength = state.history.length;
    return { path: filePath, saved: true };
  };

  const saveAndSyncSession = async (
    state,
    { reason = "chat-manual-sync", skipSave = false } = {}
  ) => {
    const saveResult = skipSave ? { path: null, saved: false } : await persistSession(state);
    const syncResult = syncClient.runNotesAutomationCommand(["sync"]);
    return {
      saveResult,
      syncResult,
      reason,
      summary: syncClient.formatSyncFeedback(syncResult)
    };
  };

  return {
    buildTranscriptPayload,
    persistSession,
    saveAndSyncSession,
    saveTranscript
  };
}

const defaultTranscriptStore = createTranscriptSessionStore();

export const persistTranscriptForSession = defaultTranscriptStore.persistSession;
export const saveAndSyncSession = defaultTranscriptStore.saveAndSyncSession;
export const saveTranscript = defaultTranscriptStore.saveTranscript;
