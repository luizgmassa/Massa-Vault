import { runPrompt } from "../services/chat-runtime.js";
import { applyInkScreenAction, noticeForBlockedScreen } from "./ink-screen-controller.js";

export async function handleInkSubmit({
  value,
  isBusy,
  screen,
  session,
  commandExecutor,
  limitsByModel,
  chatCompletion,
  finalizeExit,
  refreshLiveTokenCount,
  refreshModelStatus,
  refreshSyncStatus,
  appendAssistantChunk,
  appendMessage,
  appendPanel,
  clearAssistantPending,
  createAssistantMessage,
  replaceAssistantText,
  promptHistory,
  slashState,
  ui,
  nextIdRef
}) {
  if (isBusy) return;

  const slashEnterAction = slashState.resolveEnterAction({
    inputValue: value,
    suggestions: slashState.showSuggestions ? slashState.suggestions : [],
    selectedIndex: slashState.selectedIndex
  });
  if (slashEnterAction?.mode === "fill") {
    ui.setInputValue(slashEnterAction.line);
    return;
  }

  const line = String(slashEnterAction?.line ?? value ?? "").trim();
  ui.setInputValue("");
  if (!line) return;

  ui.setBusyLabel(line.startsWith("/") ? `running ${line}` : "processing prompt");
  ui.setIsBusy(true);

  try {
    const command = await commandExecutor({
      line,
      state: session,
      limitsByModel,
      mode: "tui",
      handlers: {
        message: (text) => appendMessage("system", text),
        panel: (title, lines) => appendPanel(title, lines)
      }
    });
    const action = command?.action && typeof command.action === "object" ? command.action : null;
    if (action?.type === "edit-conversation-prompt") {
      ui.setPromptEditorValue?.(String(action.prompt || ""));
      ui.setScreen("conversation");
    }
    applyInkScreenAction({
      action,
      setPanelNotice: ui.setPanelNotice,
      setPanelScreen: ui.setPanelScreen,
      setPanelScrollOffset: ui.setPanelScrollOffset,
      refreshSyncStatus,
      setHistoryNotice: ui.setHistoryNotice,
      setHistoryPanel: ui.setHistoryPanel,
      setHistoryScrollOffset: ui.setHistoryScrollOffset,
      setItems: ui.setItems,
      setScreen: ui.setScreen,
      setSyncNotice: ui.setSyncNotice,
      nextIdRef
    });

    if (line === "/sync" || line.startsWith("/sync ")) {
      if (!action?.syncStatus) {
        refreshSyncStatus();
      }
    }
    refreshLiveTokenCount();
    refreshModelStatus(session.latestRouting);

    if (command.handled) {
      if (command.exit) {
        ui.setBusyLabel("running /exit");
        await finalizeExit();
      }
      return;
    }

    const blockedScreenNotice = noticeForBlockedScreen(screen, ui.panelScreen);
    if (blockedScreenNotice) {
      if (screen === "sync") {
        ui.setSyncNotice(blockedScreenNotice);
        refreshSyncStatus();
      } else if (screen === "history") {
        ui.setHistoryNotice(blockedScreenNotice);
      } else if (screen === "panel") {
        ui.setPanelNotice(blockedScreenNotice);
      }
      return;
    }

    appendMessage("user", line);
    if (promptHistory.entries.current.length >= 200) {
      promptHistory.entries.current.shift();
    }
    promptHistory.entries.current.push(line);
    promptHistory.cursor.current = null;
    promptHistory.draft.current = "";
    const assistantMessageId = createAssistantMessage();
    let streamedAny = false;
    session.transcriptSavedPath = null;
    ui.setBusyLabel("processing prompt");

    const result = await runPrompt(session, {
      prompt: line,
      renderMode: "silent",
      chatCompletion,
      callbacks: {
        onThinkingChange: (thinking) => {
          if (thinking) {
            replaceAssistantText(assistantMessageId, ui.assistantPendingToken);
            ui.setBusyLabel("waiting for model");
            refreshLiveTokenCount();
          }
        },
        onAssistantDelta: (chunk) => {
          streamedAny = true;
          clearAssistantPending();
          ui.setBusyLabel("assistant responding");
          appendAssistantChunk(assistantMessageId, chunk);
          refreshLiveTokenCount();
        },
        onUsage: (usage) => {
          const nextTotal =
            Number(session.sessionUsage.total_tokens || 0) + Number(usage?.total_tokens || 0);
          refreshLiveTokenCount(nextTotal);
          ui.setBusyLabel("finalizing response");
        },
        onRouting: (routing) => {
          session.latestRouting = routing;
          refreshModelStatus(routing);
        },
        onWarning: (message) => {
          appendMessage("system", message);
        }
      }
    });

    session.latestRouting = result.routing;
    refreshModelStatus(result.routing);
    clearAssistantPending();
    if (!streamedAny) {
      replaceAssistantText(assistantMessageId, result.assistantText || "[no content]");
    }
    refreshLiveTokenCount(session.sessionUsage.total_tokens);
    refreshSyncStatus();
  } catch (error) {
    clearAssistantPending();
    const errorText = `[chat] ${error instanceof Error ? error.message : String(error)}`;
    if (screen === "sync") {
      ui.setSyncNotice(errorText);
      refreshSyncStatus();
    } else if (screen === "history") {
      ui.setHistoryNotice(errorText);
    } else if (screen === "panel") {
      ui.setPanelNotice(errorText);
    } else {
      appendMessage("system", errorText);
    }
  } finally {
    ui.setBusyLabel("");
    ui.setIsBusy(false);
  }
}
