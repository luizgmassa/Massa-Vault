import { itemsFromConversationHistory } from "./ink-controller.js";

export function applyInkScreenAction({
  action,
  refreshSyncStatus,
  setHistoryNotice,
  setHistoryPanel,
  setHistoryScrollOffset,
  setItems,
  setScreen,
  setSyncNotice,
  nextIdRef
} = {}) {
  if (!action || typeof action !== "object" || action.type !== "switch-screen") {
    return false;
  }

  if (action.screen === "sync") {
    setScreen("sync");
    setSyncNotice("");
    setHistoryNotice("");
    refreshSyncStatus(action.syncStatus);
    return true;
  }

  if (action.screen === "history") {
    setScreen("history");
    setSyncNotice("");
    setHistoryNotice("");
    if (action.historyPanel && Array.isArray(action.historyPanel.lines)) {
      setHistoryPanel({
        title: String(action.historyPanel.title || "History"),
        lines: action.historyPanel.lines,
        renderMarkdown: action.historyPanel.renderMarkdown !== false,
        scrollable: Boolean(action.historyPanel.scrollable),
        previewMode: Boolean(action.historyPanel.previewMode)
      });
      setHistoryScrollOffset(0);
    }
    return true;
  }

  if (action.screen === "conversation") {
    setScreen("conversation");
    setSyncNotice("");
    setHistoryNotice("");
    if (Array.isArray(action.historyLoaded?.history)) {
      const hydrated = itemsFromConversationHistory(action.historyLoaded.history, {
        startAt: nextIdRef.current
      });
      nextIdRef.current = hydrated.nextId;
      setItems(hydrated.items);
    }
    return true;
  }

  return false;
}

export function noticeForBlockedScreen(screen) {
  if (screen === "sync") {
    return "sync screen active; run /conv before sending prompts";
  }
  if (screen === "history") {
    return "History screen active. Run /back or /conv or use /history commands.";
  }
  return "";
}
