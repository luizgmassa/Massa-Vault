import React, { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { buildGatewayOptions } from "../infrastructure/chat-config.js";
import { createChatSession } from "../services/chat-session.js";
import { executeCommand } from "../services/command-executor.js";
import { saveAndSyncSession } from "../services/transcript-store.js";
import { readLocalSyncStatusModel } from "../infrastructure/sync-client.js";
import { createStartupWarmup } from "./startup-warmup.js";
import {
  getSlashCommandSuggestions as getSlashCommandSuggestionsImpl,
  modelStatusFromRouting as modelStatusFromRoutingImpl,
  moveSlashSuggestionSelection,
  resolveSlashEnterAction as resolveSlashEnterActionImpl,
  tabCompleteSlashCommandInput as tabCompleteSlashCommandInputImpl
} from "./ink-controller.js";
import { handleInkSubmit } from "./ink-submit-controller.js";
import { readLiteLLMLimits } from "../infrastructure/litellm-limits.js";

export { moveSlashSuggestionSelection };

export const CHAT_THEME = {
  assistant: "#ffb86b",
  system: "#ffb86b",
  header: "#d97706",
  user: "#2f9e44",
  muted: "gray",
  code: "yellow"
};

export function colorForRole(role) {
  if (role === "system") return CHAT_THEME.system;
  if (role === "user") return CHAT_THEME.user;
  if (role === "assistant") return CHAT_THEME.assistant;
  return CHAT_THEME.muted;
}

const ASSISTANT_PENDING_TOKEN = "__assistant_pending__";
const HISTORY_PREVIEW_VIEWPORT_LINES = 24;
const SYNC_STATUS_POLL_MS = 2000;

function useAnimatedEllipsis(active, intervalMs = 250) {
  const frames = [".", "..", "..."];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setIndex((value) => (value + 1) % frames.length);
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);

  return active ? frames[index] : "";
}

function useElapsedSeconds(active) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }

    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return seconds;
}

function formatElapsed(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function compactSyncLabel(syncStatus, backendName) {
  if (String(syncStatus?.status || "").toLowerCase() === "syncing") {
    return "running";
  }
  return syncStatus?.backends?.[backendName]?.hasError ? "error" : "ok";
}

function compactSyncColor(label) {
  if (label === "error") return "red";
  if (label === "running") return "yellow";
  return "gray";
}

function backendStatusLabel(backend) {
  if (backend?.hasError) return "ERROR";
  if (backend?.enabled === false) return "DISABLED";
  return "OK";
}

function formatTimestamp(value) {
  const text = String(value || "").trim();
  return text || "-";
}

function splitSnippet(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  return text.split(/\r?\n/).slice(-10);
}

function modelStatusFromRouting(routing) {
  return modelStatusFromRoutingImpl(routing);
}

export function getSlashCommandSuggestions(inputValue) {
  return getSlashCommandSuggestionsImpl(inputValue);
}

export function tabCompleteSlashCommandInput(inputValue) {
  return tabCompleteSlashCommandInputImpl(inputValue);
}

export function resolveSlashEnterAction({ inputValue, suggestions, selectedIndex }) {
  return resolveSlashEnterActionImpl({ inputValue, suggestions, selectedIndex });
}

export function navigatePromptHistory({
  history,
  cursor,
  draft,
  currentInput,
  direction
}) {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) {
    return { cursor, draft, nextInput: currentInput };
  }

  if (direction === "up") {
    const nextCursor = cursor === null ? 0 : Math.min(cursor + 1, entries.length - 1);
    const nextDraft = cursor === null ? currentInput : draft;
    return {
      cursor: nextCursor,
      draft: nextDraft,
      nextInput: entries[entries.length - 1 - nextCursor]
    };
  }

  if (direction === "down") {
    if (cursor === null) {
      return { cursor, draft, nextInput: currentInput };
    }
    if (cursor === 0) {
      return { cursor: null, draft, nextInput: draft };
    }
    const nextCursor = cursor - 1;
    return {
      cursor: nextCursor,
      draft,
      nextInput: entries[entries.length - 1 - nextCursor]
    };
  }

  return { cursor, draft, nextInput: currentInput };
}

function inlineSegments(text) {
  const segments = [];
  const source = String(text || "");
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      segments.push({ text: source.slice(cursor, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      segments.push({ text: token.slice(1, -1), code: true });
    } else {
      segments.push({ text: token.slice(2, -2), bold: true });
    }
    cursor = match.index + token.length;
  }

  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor) });
  }
  return segments.length ? segments : [{ text: source }];
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseTableRow(line) {
  const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function formatTable(lines, startIndex) {
  const header = parseTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && String(lines[index] || "").includes("|") && lines[index].trim()) {
    rows.push(parseTableRow(lines[index]));
    index += 1;
  }

  const widthCount = Math.max(header.length, ...rows.map((row) => row.length), 0);
  const widths = Array.from({ length: widthCount }, (_, column) =>
    Math.max(
      header[column]?.length || 0,
      ...rows.map((row) => row[column]?.length || 0)
    )
  );
  const renderRow = (row) => `| ${widths.map((width, column) => String(row[column] || "").padEnd(width)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(Math.max(1, width))).join(" | ")} |`;

  return {
    lines: [renderRow(header), separator, ...rows.map((row) => renderRow(row))],
    nextIndex: index
  };
}

function markdownLines(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const rendered = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      rendered.push({ text: `  ${line}`, code: true });
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1])
    ) {
      const table = formatTable(lines, index);
      rendered.push(...table.lines.map((text) => ({ text, code: true })));
      index = table.nextIndex - 1;
      continue;
    }

    if (!trimmed) {
      rendered.push({ text: "" });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      rendered.push({ text: heading[2], bold: true });
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      rendered.push({ text: "────────────────" });
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      rendered.push({ text: `│ ${quote[1]}` });
      continue;
    }

    rendered.push({ text: line });
  }

  return rendered.length ? rendered : [{ text: "" }];
}

function renderInlineLine({
  id,
  text,
  color,
  bold = false,
  code = false,
  prefix = "",
  forceColor = false
}) {
  const baseColor = code && !forceColor ? CHAT_THEME.code : color;
  const segments = inlineSegments(text);
  return createElement(
    Text,
    { key: id, color: baseColor, bold },
    prefix,
    ...segments.map((segment, index) =>
      createElement(
        Text,
        {
          key: `${id}-${index}`,
          color: segment.code && !forceColor ? CHAT_THEME.code : baseColor,
          bold: bold || segment.bold
        },
        segment.text
      )
    )
  );
}

export function InkChatApp({
  systemPrompt,
  chatCompletion,
  driver,
  commandExecutor = executeCommand,
  startupWarmup
}) {
  const { exit } = useApp();
  const sessionRef = useRef(createChatSession({ systemPrompt }));
  const limitsByModelRef = useRef(readLiteLLMLimits());
  const gatewayRef = useRef(buildGatewayOptions());
  const nextIdRef = useRef(0);
  const exitingRef = useRef(false);
  const promptHistoryRef = useRef([]);
  const promptHistoryCursorRef = useRef(null);
  const promptHistoryDraftRef = useRef("");
  const warmupWarningsRef = useRef([]);
  const warmupMessageSinkRef = useRef(null);
  const warmupRoutingSinkRef = useRef(null);
  const shouldAutoWarmup = Boolean(startupWarmup || !chatCompletion);
  const warmupRef = useRef(
    shouldAutoWarmup
      ? startupWarmup ||
          createStartupWarmup({
            onPrimaryRouting: (routing) => {
              warmupRoutingSinkRef.current?.(routing);
            },
            onWarning: (message) => {
              const sink = warmupMessageSinkRef.current;
              if (sink) {
                sink(message);
              } else {
                warmupWarningsRef.current.push(message);
              }
            }
          })
      : null
  );
  const [items, setItems] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [screen, setScreen] = useState("conversation");
  const [syncStatus, setSyncStatus] = useState(() => readLocalSyncStatusModel());
  const [syncNotice, setSyncNotice] = useState("");
  const [historyPanel, setHistoryPanel] = useState(() => ({
    title: "History",
    lines: ["Run /history to load transcript dates."],
    renderMarkdown: true,
    scrollable: false,
    previewMode: false
  }));
  const [historyNotice, setHistoryNotice] = useState("");
  const [historyScrollOffset, setHistoryScrollOffset] = useState(0);
  const [modelStatus, setModelStatus] = useState(() => modelStatusFromRouting(null));
  const [liveTokenCount, setLiveTokenCount] = useState(() =>
    Number(sessionRef.current.estimatedTokensRef.value || 0)
  );
  const [assistantPendingId, setAssistantPendingId] = useState(null);
  const inputBusyEllipsis = useAnimatedEllipsis(isBusy);
  const thinkingSeconds = useElapsedSeconds(Boolean(assistantPendingId) && isBusy);
  const slashSuggestions = getSlashCommandSuggestions(inputValue);
  const showSlashSuggestions =
    !isBusy && screen === "conversation" && String(inputValue || "").startsWith("/");
  const effectiveSlashSelectionIndex = showSlashSuggestions
    ? moveSlashSuggestionSelection({
        currentIndex: slashSelectionIndex,
        suggestionCount: slashSuggestions.length,
        direction: null
      })
    : null;
  const selectedSlashSuggestion = showSlashSuggestions
    ? slashSuggestions[effectiveSlashSelectionIndex] || null
    : null;

  const refreshLiveTokenCount = useCallback((overrideValue) => {
    if (typeof overrideValue === "number" && Number.isFinite(overrideValue)) {
      setLiveTokenCount(Math.max(0, Math.round(overrideValue)));
      return;
    }
    const next = Number(sessionRef.current.estimatedTokensRef.value || 0);
    setLiveTokenCount(Math.max(0, Math.round(next)));
  }, []);

  const refreshSyncStatus = useCallback((override) => {
    if (override && typeof override === "object") {
      setSyncStatus(override);
      return;
    }
    setSyncStatus(readLocalSyncStatusModel());
  }, []);

  const refreshModelStatus = useCallback((routing) => {
    setModelStatus(modelStatusFromRouting(routing));
  }, []);

  useEffect(() => {
    warmupRoutingSinkRef.current = (routing) => {
      sessionRef.current.latestRouting = routing;
      refreshModelStatus(routing);
    };
    return () => {
      warmupRoutingSinkRef.current = null;
    };
  }, [refreshModelStatus]);

  const appendItem = useCallback((item) => {
    setItems((previous) => [...previous, item].slice(-120));
  }, []);

  const appendMessage = useCallback(
    (role, content) => {
      nextIdRef.current += 1;
      appendItem({
        id: `m-${nextIdRef.current}`,
        kind: "message",
        role,
        content
      });
    },
    [appendItem]
  );

  const handleInputChange = useCallback((nextValue) => {
    setInputValue(nextValue);
    if (promptHistoryCursorRef.current !== null) {
      promptHistoryCursorRef.current = null;
      promptHistoryDraftRef.current = "";
    }
  }, []);

  useEffect(() => {
    if (!showSlashSuggestions || !slashSuggestions.length) {
      setSlashSelectionIndex(null);
      return;
    }
    setSlashSelectionIndex((currentIndex) =>
      moveSlashSuggestionSelection({
        currentIndex,
        suggestionCount: slashSuggestions.length,
        direction: null
      })
    );
  }, [showSlashSuggestions, slashSuggestions]);

  const appendPanel = useCallback(
    (title, lines) => {
      nextIdRef.current += 1;
      appendItem({
        id: `p-${nextIdRef.current}`,
        kind: "panel",
        title,
        lines
      });
    },
    [appendItem]
  );

  const createAssistantMessage = useCallback(() => {
    nextIdRef.current += 1;
    const id = `m-${nextIdRef.current}`;
    setAssistantPendingId(id);
    appendItem({
      id,
      kind: "message",
      role: "assistant",
      content: ASSISTANT_PENDING_TOKEN
    });
    return id;
  }, [appendItem]);

  const replaceAssistantText = useCallback((id, content) => {
    setItems((previous) =>
      previous.map((item) => {
        if (item.id !== id || item.kind !== "message") return item;
        return { ...item, content };
      })
    );
  }, []);

  const appendAssistantChunk = useCallback((id, chunk) => {
    setItems((previous) =>
      previous.map((item) => {
        if (item.id !== id || item.kind !== "message") return item;
        const current = item.content === ASSISTANT_PENDING_TOKEN ? "" : item.content;
        return { ...item, content: `${current}${chunk}` };
      })
    );
  }, []);

  const finalizeExit = useCallback(async () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    try {
      const result = await saveAndSyncSession(sessionRef.current, { reason: "chat-exit" });
      if (result.saveResult.path && result.saveResult.saved) {
        appendMessage("system", `[chat] transcript saved: ${result.saveResult.path}`);
      }
      appendMessage("system", result.summary);
    } finally {
      exit();
    }
  }, [appendMessage, exit]);

  const handleSubmit = useCallback(
    async (value) => {
      await handleInkSubmit({
        value,
        isBusy,
        screen,
        session: sessionRef.current,
        commandExecutor,
        limitsByModel: limitsByModelRef.current,
        chatCompletion,
        finalizeExit,
        refreshLiveTokenCount,
        refreshModelStatus,
        refreshSyncStatus,
        appendAssistantChunk,
        appendMessage,
        appendPanel,
        clearAssistantPending: () => setAssistantPendingId(null),
        createAssistantMessage,
        replaceAssistantText,
        promptHistory: {
          entries: promptHistoryRef,
          cursor: promptHistoryCursorRef,
          draft: promptHistoryDraftRef
        },
        slashState: {
          resolveEnterAction: resolveSlashEnterAction,
          selectedIndex: slashSelectionIndex,
          showSuggestions: showSlashSuggestions,
          suggestions: slashSuggestions
        },
        ui: {
          assistantPendingToken: ASSISTANT_PENDING_TOKEN,
          setBusyLabel,
          setHistoryNotice,
          setHistoryPanel,
          setHistoryScrollOffset,
          setInputValue,
          setIsBusy,
          setItems,
          setScreen,
          setSyncNotice
        },
        nextIdRef
      });
    },
    [
      appendAssistantChunk,
      appendMessage,
      appendPanel,
      chatCompletion,
      commandExecutor,
      createAssistantMessage,
      finalizeExit,
      isBusy,
      slashSelectionIndex,
      slashSuggestions,
      showSlashSuggestions,
      screen,
      refreshLiveTokenCount,
      refreshModelStatus,
      refreshSyncStatus,
      replaceAssistantText
    ]
  );

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      void finalizeExit();
      return;
    }
    if (isBusy) {
      return;
    }
    if (screen === "history" && historyPanel.scrollable && (key.upArrow || key.downArrow)) {
      const panelLines = Array.isArray(historyPanel.lines) ? historyPanel.lines : [];
      const renderedCount = historyPanel.renderMarkdown
        ? markdownLines(panelLines.join("\n")).length
        : panelLines.length;
      const maxOffset = Math.max(0, renderedCount - HISTORY_PREVIEW_VIEWPORT_LINES);
      const delta = key.downArrow ? 1 : -1;
      setHistoryScrollOffset((current) => clamp(current + delta, 0, maxOffset));
      return;
    }
    if (screen !== "conversation") {
      return;
    }
    if (key.tab) {
      const completed = tabCompleteSlashCommandInput(inputValue);
      if (completed !== inputValue) {
        setInputValue(completed);
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? "up" : "down";
      if (showSlashSuggestions) {
        setSlashSelectionIndex((currentIndex) =>
          moveSlashSuggestionSelection({
            currentIndex,
            suggestionCount: slashSuggestions.length,
            direction
          })
        );
        return;
      }
      const next = navigatePromptHistory({
        history: promptHistoryRef.current,
        cursor: promptHistoryCursorRef.current,
        draft: promptHistoryDraftRef.current,
        currentInput: inputValue,
        direction
      });
      promptHistoryCursorRef.current = next.cursor;
      promptHistoryDraftRef.current = next.draft;
      if (next.nextInput !== inputValue) {
        setInputValue(next.nextInput);
      }
    }
  }, [
    finalizeExit,
    historyPanel.lines,
    historyPanel.renderMarkdown,
    historyPanel.scrollable,
    inputValue,
    isBusy,
    screen,
    showSlashSuggestions,
    slashSuggestions
  ]);

  useEffect(() => {
    if (!historyPanel.scrollable) {
      if (historyScrollOffset !== 0) {
        setHistoryScrollOffset(0);
      }
      return;
    }
    const panelLines = Array.isArray(historyPanel.lines) ? historyPanel.lines : [];
    const renderedCount = historyPanel.renderMarkdown
      ? markdownLines(panelLines.join("\n")).length
      : panelLines.length;
    const maxOffset = Math.max(0, renderedCount - HISTORY_PREVIEW_VIEWPORT_LINES);
    if (historyScrollOffset > maxOffset) {
      setHistoryScrollOffset(maxOffset);
    }
  }, [historyPanel.lines, historyPanel.renderMarkdown, historyPanel.scrollable, historyScrollOffset]);

  useEffect(() => {
    const handleSignal = () => {
      void finalizeExit();
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    process.on("SIGHUP", handleSignal);
    return () => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      process.off("SIGHUP", handleSignal);
    };
  }, [finalizeExit]);

  useEffect(() => {
    appendMessage("system", "massa-vault chat started. type / to discover commands.");
  }, [appendMessage]);

  useEffect(() => {
    warmupMessageSinkRef.current = (message) => appendMessage("system", message);
    const pendingWarnings = warmupWarningsRef.current.splice(0);
    for (const warning of pendingWarnings) {
      appendMessage("system", warning);
    }
    return () => {
      warmupMessageSinkRef.current = null;
    };
  }, [appendMessage]);

  useEffect(() => {
    warmupRef.current?.start();
  }, []);

  useEffect(() => {
    refreshSyncStatus();
    const timer = setInterval(() => {
      refreshSyncStatus();
    }, SYNC_STATUS_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refreshSyncStatus]);

  useEffect(() => {
    if (!driver || typeof driver !== "object") return;
    driver.submit = (line) => handleSubmit(String(line || ""));
    driver.exit = () => finalizeExit();
    driver.getSessionState = () => ({
      history: [...sessionRef.current.history],
      screen
    });
    return () => {
      delete driver.submit;
      delete driver.exit;
      delete driver.getSessionState;
    };
  }, [driver, finalizeExit, handleSubmit, screen]);

  const visibleItems = items.slice(-20);
  const backendGit = syncStatus?.backends?.git || { enabled: null, hasError: false };
  const backendDrive = syncStatus?.backends?.drive || { enabled: null, hasError: false };
  const gitFooterLabel = compactSyncLabel(syncStatus, "git");
  const driveFooterLabel = compactSyncLabel(syncStatus, "drive");
  const syncSections = [
    {
      id: "daemon",
      title: "daemon",
      color: "cyan",
      lines: [
        `running: ${syncStatus?.running ? "yes" : "no"} pid: ${syncStatus?.pid ?? "-"}`,
        `paused: ${syncStatus?.paused ? "yes" : "no"}`,
        `status: ${syncStatus?.status || "idle"} reason: ${syncStatus?.reason || "-"}`,
        `queued_reason: ${syncStatus?.queuedReason || "-"}`,
        `conflicts: ${Number(syncStatus?.conflictCount || 0)}`
      ]
    },
    {
      id: "git",
      title: "github (git)",
      color: "yellow",
      lines: [
        `state: ${backendStatusLabel(backendGit)}`,
        `enabled: ${backendGit?.enabled === false ? "no" : backendGit?.enabled === true ? "yes" : "unknown"}`,
        `reasons: ${(backendGit?.reasons || []).length ? backendGit.reasons.join(", ") : "-"}`,
        `last_pull_at: ${formatTimestamp(syncStatus?.lastPullAt)}`,
        `last_push_at: ${formatTimestamp(syncStatus?.lastPushAt)}`
      ]
    },
    {
      id: "drive",
      title: "google drive",
      color: "green",
      lines: [
        `state: ${backendStatusLabel(backendDrive)}`,
        `enabled: ${backendDrive?.enabled === false ? "no" : backendDrive?.enabled === true ? "yes" : "unknown"}`,
        `reasons: ${(backendDrive?.reasons || []).length ? backendDrive.reasons.join(", ") : "-"}`,
        `import: ${backendDrive?.gdriveImport || "-"}`,
        `review_needed: ${backendDrive?.reviewNeeded ? "yes" : "no"}`,
        `requires_resync: ${backendDrive?.requiresResync ? "yes" : "no"}`,
        `auto_resync: ${backendDrive?.autoResyncAttempted ? (backendDrive?.autoResyncApplied ? "applied" : "attempted") : "none"}`
      ]
    },
    {
      id: "timestamps",
      title: "timestamps",
      color: "magenta",
      lines: [
        `started_at: ${formatTimestamp(syncStatus?.startedAt)}`,
        `finished_at: ${formatTimestamp(syncStatus?.finishedAt)}`,
        `last_success_at: ${formatTimestamp(syncStatus?.lastSuccessAt)}`,
        `updated_at: ${formatTimestamp(syncStatus?.updatedAt)}`,
        `last_gdrive_attempt_at: ${formatTimestamp(syncStatus?.lastGDriveAttemptAt)}`,
        `last_gdrive_sync_at: ${formatTimestamp(syncStatus?.lastGDriveSyncAt)}`,
        `last_auto_resync_at: ${formatTimestamp(syncStatus?.lastGDriveAutoResyncAt)}`
      ]
    }
  ];
  const syncSnippets = [
    { id: "alert", title: "alert", color: "yellow", lines: splitSnippet(syncStatus?.alert) },
    { id: "sync-error", title: "sync error", color: "red", lines: splitSnippet(syncStatus?.lastError) },
    { id: "git-pull", title: "git pull error", color: "red", lines: splitSnippet(backendGit?.lastPullError) },
    { id: "git-push", title: "git push error", color: "red", lines: splitSnippet(backendGit?.lastPushError) },
    {
      id: "drive-error",
      title: "drive error",
      color: "red",
      lines: splitSnippet(backendDrive?.lastGDriveError)
    },
    {
      id: "drive-init-error",
      title: "drive initial error",
      color: "red",
      lines: splitSnippet(backendDrive?.lastGDriveInitialError)
    },
    {
      id: "drive-output",
      title: "drive output",
      color: "red",
      lines: splitSnippet(backendDrive?.lastGDriveOutput)
    }
  ].filter((entry) => entry.lines.length);

  const renderItem = (item) => {
    if (item.kind === "panel") {
      return createElement(
        Box,
        {
          key: item.id,
          flexDirection: "column",
          marginBottom: 1,
          borderStyle: "round",
          borderColor: "yellow",
          paddingX: 1
        },
        createElement(Text, { color: "yellowBright" }, `${item.title}:`),
        ...item.lines.map((line, index) =>
          createElement(Text, { key: `${item.id}-${index}`, color: "yellow" }, line)
        )
      );
    }

    const color = colorForRole(item.role);
    const prefix = `${item.role}> `;
    if (item.role === "assistant" && item.content === ASSISTANT_PENDING_TOKEN) {
      return createElement(
        Box,
        { key: item.id, marginBottom: 1 },
        createElement(Text, { color }, `${prefix}thinking... ${formatElapsed(thinkingSeconds)}`)
      );
    }

    const lines = markdownLines(item.content);
    const indent = " ".repeat(prefix.length);
    return createElement(
      Box,
      { key: item.id, marginBottom: 1, flexDirection: "column" },
      ...lines.map((line, index) =>
        renderInlineLine({
          id: `${item.id}-${index}`,
          text: line.text,
          color,
          bold: line.bold,
          code: line.code,
          prefix: index === 0 ? prefix : indent
        })
      )
    );
  };

  const headerMeta =
    `Gateway: ${gatewayRef.current.gatewayUrl} | ` +
    `Model: ${modelStatus.displayModel} @ ${modelStatus.modelLocation} | ` +
    `Auth: ${gatewayRef.current.apiKey ? "On" : "Off"}`;
  const syncScreenActive = screen === "sync";
  const historyScreenActive = screen === "history";
  const historyPanelLines = Array.isArray(historyPanel.lines) ? historyPanel.lines : [];
  const historyRenderedLines = historyPanel.renderMarkdown
    ? markdownLines(historyPanelLines.join("\n"))
    : historyPanelLines.map((line) => ({ text: String(line || "") }));
  const historyViewportSize = historyPanel.scrollable
    ? HISTORY_PREVIEW_VIEWPORT_LINES
    : historyRenderedLines.length;
  const maxHistoryScrollOffset = Math.max(0, historyRenderedLines.length - historyViewportSize);
  const safeHistoryScrollOffset = historyPanel.scrollable
    ? clamp(historyScrollOffset, 0, maxHistoryScrollOffset)
    : 0;
  const visibleHistoryRenderedLines = historyPanel.scrollable
    ? historyRenderedLines.slice(safeHistoryScrollOffset, safeHistoryScrollOffset + historyViewportSize)
    : historyRenderedLines;
  const historyScrollStart = historyRenderedLines.length ? safeHistoryScrollOffset + 1 : 0;
  const historyScrollEnd = historyRenderedLines.length
    ? Math.min(safeHistoryScrollOffset + historyViewportSize, historyRenderedLines.length)
    : 0;
  const screenBusyNotice = isBusy ? `${busyLabel || "working"}${inputBusyEllipsis || "."}` : "";
  const syncPanelNotice = screenBusyNotice || syncNotice;
  const historyPanelNotice = screenBusyNotice || historyNotice;
  const inputPlaceholder = isBusy
    ? screenBusyNotice
    : syncScreenActive
      ? "Sync screen active. Type /conv to return"
      : historyScreenActive
        ? "History screen active. Type /back or /conv to return"
        : "Type message or /";

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(
      Box,
      {
        borderStyle: "round",
        borderColor: CHAT_THEME.header,
        paddingX: 1,
        flexDirection: "column"
      },
      createElement(Text, { color: CHAT_THEME.header, bold: true }, "Massa Vault AI Assistant"),
      createElement(Text, { color: "gray" }, headerMeta)
    ),
    createElement(
      Box,
      {
        flexDirection: "column",
        marginTop: 1,
        marginBottom: 1,
        paddingX: 1
      },
      syncScreenActive
        ? createElement(
            Box,
            { flexDirection: "column" },
            createElement(Text, { color: "yellowBright", bold: true }, "sync status (refresh every 2s)"),
            syncPanelNotice ? createElement(Text, { color: "yellow" }, syncPanelNotice) : null,
            ...syncSections.map((section) =>
              createElement(
                Box,
                {
                  key: section.id,
                  flexDirection: "column",
                  marginTop: 1,
                  borderStyle: "round",
                  borderColor: section.color,
                  paddingX: 1
                },
                createElement(Text, { color: section.color, bold: true }, `${section.title}:`),
                ...section.lines.map((line, index) =>
                  createElement(Text, { key: `${section.id}-${index}`, color: section.color }, line)
                )
              )
            ),
            ...syncSnippets.map((section) =>
              createElement(
                Box,
                {
                  key: section.id,
                  flexDirection: "column",
                  marginTop: 1,
                  borderStyle: "round",
                  borderColor: section.color,
                  paddingX: 1
                },
                createElement(Text, { color: section.color, bold: true }, `${section.title}:`),
                ...section.lines.map((line, index) =>
                  createElement(Text, { key: `${section.id}-${index}`, color: section.color }, line)
                )
              )
            )
          )
        : historyScreenActive
          ? createElement(
              Box,
              { flexDirection: "column" },
              createElement(Text, { color: CHAT_THEME.assistant, bold: true }, `${historyPanel.title || "History"}`),
              historyPanelNotice
                ? createElement(Text, { color: CHAT_THEME.assistant }, historyPanelNotice)
                : null,
              historyPanel.scrollable
                ? createElement(
                    Text,
                    { color: CHAT_THEME.assistant },
                    `Preview scroll : ${historyScrollStart}-${historyScrollEnd} / ${historyRenderedLines.length} (Up/Down)`
                  )
                : null,
              ...(visibleHistoryRenderedLines.length
                ? visibleHistoryRenderedLines.map((line, index) =>
                    renderInlineLine({
                      id: `history-${index}`,
                      text: line.text === "" ? " " : line.text,
                      color: CHAT_THEME.assistant,
                      bold: line.bold,
                      code: line.code,
                      forceColor: true
                    })
                  )
                : [createElement(Text, { key: "history-empty", color: CHAT_THEME.assistant }, "No history output.")])
            )
        : visibleItems.length
          ? visibleItems.map((item) => renderItem(item))
          : createElement(Text, { dimColor: true }, "No messages yet.")
    ),
    createElement(
      Box,
      {
        borderStyle: "single",
        borderColor: isBusy ? "yellow" : "green",
        paddingX: 1
      },
      createElement(Text, { color: CHAT_THEME.user }, "you> "),
      createElement(TextInput, {
        value: inputValue,
        onChange: handleInputChange,
        onSubmit: handleSubmit,
        placeholder: inputPlaceholder,
        focus: !isBusy
      })
    ),
    showSlashSuggestions
      ? createElement(
          Box,
          {
            marginTop: 1,
            borderStyle: "single",
            borderColor: "gray",
            paddingX: 1,
            flexDirection: "column"
          },
          slashSuggestions.length
            ? slashSuggestions.map((suggestion, index) => {
                const isSelected = selectedSlashSuggestion?.command === suggestion.command && effectiveSlashSelectionIndex === index;
                const commandLabel = suggestion.requiresInput ? `${suggestion.command} ...` : suggestion.command;
                return createElement(
                  Text,
                  {
                    key: suggestion.command,
                    color: isSelected ? "green" : "gray"
                  },
                  `${isSelected ? "> " : "  "}${commandLabel}  ${suggestion.description}`
                );
              })
            : createElement(Text, { color: "gray" }, "No command matches")
        )
      : null,
    createElement(
      Box,
      {
        marginTop: 1,
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1
      },
      createElement(
        Text,
        { color: "gray" },
        `[ ${liveTokenCount} tokens ] [ model: ${modelStatus.displayModel} @ ${modelStatus.modelLocation} ] [ sync status: git `
      ),
      createElement(Text, { color: compactSyncColor(gitFooterLabel) }, gitFooterLabel),
      createElement(Text, { color: "gray" }, " / drive "),
      createElement(Text, { color: compactSyncColor(driveFooterLabel) }, driveFooterLabel),
      createElement(Text, { color: "gray" }, " ]")
    )
  );
}

export async function runInkRepl({ systemPrompt, startupWarmup } = {}) {
  const instance = render(createElement(InkChatApp, { systemPrompt, startupWarmup }), {
    exitOnCtrlC: false
  });
  await instance.waitUntilExit();
}
