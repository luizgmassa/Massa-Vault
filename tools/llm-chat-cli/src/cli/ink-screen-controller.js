import { itemsFromConversationHistory } from "./ink-controller.js";

export function applyInkScreenAction({
  action,
  setPanelNotice,
  setPanelScreen,
  setPanelScrollOffset,
  refreshSyncStatus,
  setHistoryNotice,
  setHistoryPanel,
  setHistoryScrollOffset,
  setItems,
  setScreen,
  setSyncNotice,
  nextIdRef
} = {}) {
  if (!action || typeof action !== "object") {
    return false;
  }

  if (action.type === "refresh-sync-status") {
    refreshSyncStatus(action.syncStatus);
    return true;
  }

  if (action.type !== "switch-screen") {
    return false;
  }

  if (action.screen === "sync") {
    setScreen("sync");
    setSyncNotice("");
    setHistoryNotice("");
    setPanelNotice("");
    refreshSyncStatus(action.syncStatus);
    return true;
  }

  if (action.screen === "history") {
    setScreen("history");
    setSyncNotice("");
    setHistoryNotice("");
    setPanelNotice("");
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

  if (action.screen === "panel") {
    setScreen("panel");
    setSyncNotice("");
    setHistoryNotice("");
    setPanelNotice("");
    if (action.panelScreen && Array.isArray(action.panelScreen.lines)) {
      setPanelScreen({
        id: String(action.panelScreen.id || "panel"),
        title: String(action.panelScreen.title || "Info"),
        lines: action.panelScreen.lines,
        renderMarkdown: action.panelScreen.renderMarkdown !== false,
        scrollable: Boolean(action.panelScreen.scrollable),
        commandHint: String(action.panelScreen.commandHint || "slash commands")
      });
      setPanelScrollOffset(0);
    }
    return true;
  }

  if (action.screen === "conversation") {
    setScreen("conversation");
    setSyncNotice("");
    setHistoryNotice("");
    setPanelNotice("");
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

function blockedScreenMetadata(screen, panelScreen) {
  if (screen === "sync") {
    return {
      label: "Sync status",
      commandHint: "/sync commands"
    };
  }
  if (screen === "history") {
    return {
      label: "History",
      commandHint: "/history commands"
    };
  }
  if (screen === "panel") {
    return {
      label: String(panelScreen?.title || "Info"),
      commandHint: String(panelScreen?.commandHint || "slash commands")
    };
  }
  return null;
}

export function noticeForBlockedScreen(screen, panelScreen) {
  const metadata = blockedScreenMetadata(screen, panelScreen);
  if (!metadata) return "";
  return `${metadata.label} screen active. Run /back or /conv or use ${metadata.commandHint}.`;
}

export function placeholderForBlockedScreen(screen, panelScreen) {
  const metadata = blockedScreenMetadata(screen, panelScreen);
  if (!metadata) return "";
  return `${metadata.label} screen active. Type /back or /conv to return`;
}
