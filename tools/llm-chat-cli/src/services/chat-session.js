import { randomUUID } from "node:crypto";
import { createSessionUsage } from "../domain/usage.js";
import { isConcreteRouting } from "../../../shared/routing-metadata.js";

export function createChatSession({
  systemPrompt = "",
  conversationPrompt = "",
  sessionId = randomUUID(),
  sessionStartedAt = new Date().toISOString()
} = {}) {
  const activeConversationPrompt = String(conversationPrompt || "").trim();
  return {
    history: [],
    sessionUsage: createSessionUsage(),
    estimatedTokensRef: { value: 0 },
    latestRouting: null,
    activeSystemPrompt: systemPrompt,
    activeConversationPrompt,
    sessionId,
    sessionStartedAt,
    transcriptSavedPath: null,
    lastSavedHistoryLength: 0,
    lastSavedConversationPrompt: activeConversationPrompt,
    historySelectedDate: null,
    historyVisibleRows: [],
    historyDateRows: [],
    historyFlowStack: [],
    activeTranscript: null,
    addedContextEntries: [],
    activeScreen: "conversation"
  };
}

export function resetChatSession(session) {
  session.history.length = 0;
  session.estimatedTokensRef.value = 0;
  session.sessionUsage.prompt_tokens = 0;
  session.sessionUsage.completion_tokens = 0;
  session.sessionUsage.total_tokens = 0;
  session.latestRouting = null;
  session.activeConversationPrompt = "";
  session.transcriptSavedPath = null;
  session.lastSavedHistoryLength = 0;
  session.lastSavedConversationPrompt = "";
  session.historySelectedDate = null;
  session.historyVisibleRows = [];
  session.historyDateRows = [];
  session.historyFlowStack = [];
  session.activeTranscript = null;
  session.addedContextEntries = [];
  session.activeScreen = "conversation";
  return session;
}

export function addContextEntry(session, { source = "", content = "" } = {}) {
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) return false;
  session.addedContextEntries = [
    ...(Array.isArray(session.addedContextEntries) ? session.addedContextEntries : []),
    {
      source: String(source || "").trim(),
      content: normalizedContent
    }
  ];
  return true;
}

export function setConversationPrompt(session, prompt = "") {
  const nextPrompt = String(prompt || "").trim();
  session.activeConversationPrompt = nextPrompt;
  return nextPrompt;
}

function resolveLatestRouting(currentRouting, transcriptRouting) {
  if (isConcreteRouting(transcriptRouting)) {
    return transcriptRouting;
  }
  return currentRouting || null;
}

export function loadTranscriptIntoSession(
  session,
  {
    transcriptPath,
    transcript,
    metadata,
    fallbackSessionId,
    fallbackSessionStartedAt,
    fallbackGatewayUrl,
    fallbackModel,
    routing,
    usage
  }
) {
  const conversationPrompt = String(metadata?.conversation_prompt || "").trim();
  session.history = Array.isArray(transcript?.messages) ? [...transcript.messages] : [];
  session.activeTranscript = {
    path: transcriptPath,
    id: String(metadata?.id || "").trim() || fallbackSessionId,
    createdAt: String(metadata?.created_at || "").trim() || fallbackSessionStartedAt,
    gatewayUrl: String(metadata?.gateway_url || "").trim() || fallbackGatewayUrl,
    model: String(metadata?.model || "").trim() || fallbackModel,
    routing: routing || null,
    conversationPrompt
  };
  session.latestRouting = resolveLatestRouting(session.latestRouting, session.activeTranscript.routing);
  session.activeConversationPrompt = conversationPrompt;
  session.transcriptSavedPath = transcriptPath;
  session.lastSavedHistoryLength = session.history.length;
  session.lastSavedConversationPrompt = conversationPrompt;
  session.sessionUsage = {
    prompt_tokens: Number(usage?.prompt_tokens || 0),
    completion_tokens: Number(usage?.completion_tokens || 0),
    total_tokens: Number(usage?.total_tokens || 0)
  };
  session.estimatedTokensRef.value = Number(session.sessionUsage.total_tokens || 0);
  session.historySelectedDate = null;
  session.historyVisibleRows = [];
  session.historyDateRows = Array.isArray(session.historyDateRows) ? session.historyDateRows : [];
  session.historyFlowStack = [];
  session.addedContextEntries = [];
  session.activeScreen = "conversation";
  return session;
}
