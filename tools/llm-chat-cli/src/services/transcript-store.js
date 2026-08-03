import {
  resolveDefaultGatewayModel,
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
  conversationPrompt,
  routing,
  usage
}) {
  return {
    id,
    createdAt,
    gatewayUrl,
    model: model || resolveDefaultGatewayModel(),
    conversationPrompt: String(conversationPrompt || "").trim(),
    routing,
    usage,
    messages: history
  };
}

export function createTranscriptSessionStore({
  resolveVaultPathFn = resolveVaultPath,
  buildGatewayOptionsFn = buildGatewayOptions,
  defaultGatewayModel = resolveDefaultGatewayModel(),
  writeTranscriptImpl = writeTranscript,
  syncClient = createSyncClient()
} = {}) {
  const saveTranscript = async ({
    sessionId,
    sessionStartedAt,
    history,
    latestRouting,
    sessionUsage,
    activeTranscript,
    activeConversationPrompt
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
        conversationPrompt: activeConversationPrompt ?? metadata?.conversationPrompt ?? "",
        routing: latestRouting || metadata?.routing || null,
        usage: sessionUsage
      })
    });
  };

  const persistSession = async (state) => {
    const activeConversationPrompt = String(state.activeConversationPrompt || "").trim();
    const lastSavedConversationPrompt = String(state.lastSavedConversationPrompt || "").trim();
    if (
      state.transcriptSavedPath &&
      state.lastSavedHistoryLength === state.history.length &&
      lastSavedConversationPrompt === activeConversationPrompt
    ) {
      return { path: state.transcriptSavedPath, saved: false };
    }

    const filePath = await saveTranscript({
      sessionId: state.sessionId,
      sessionStartedAt: state.sessionStartedAt,
      history: state.history,
      latestRouting: state.latestRouting,
      sessionUsage: state.sessionUsage,
      activeTranscript: state.activeTranscript,
      activeConversationPrompt
    });
    if (!filePath) {
      return { path: null, saved: false };
    }

    state.transcriptSavedPath = filePath;
    state.lastSavedHistoryLength = state.history.length;
    state.lastSavedConversationPrompt = activeConversationPrompt;
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

// Default-store convenience exports construct the store per call: a
// module-level createTranscriptSessionStore() would evaluate the default
// parameters -- resolveDefaultGatewayModel() and createSyncClient() -- at
// import time, re-freezing config at module scope (ARCH-3). The store is
// stateless, so per-call construction only costs the config re-read.
export const persistTranscriptForSession = (...args) =>
  createTranscriptSessionStore().persistSession(...args);
export const saveAndSyncSession = (...args) =>
  createTranscriptSessionStore().saveAndSyncSession(...args);
export const saveTranscript = (...args) =>
  createTranscriptSessionStore().saveTranscript(...args);
