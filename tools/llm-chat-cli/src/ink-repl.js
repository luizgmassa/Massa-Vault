import React, { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  DEFAULT_GATEWAY_MODEL,
  buildGatewayOptions,
  createReplState,
  createStatusLine,
  createStatusState,
  executeCommand,
  processPrompt,
  readLocalSyncStatusModel,
  saveAndSyncSession
} from "./cli.js";
import { readLiteLLMLimits } from "./litellm-limits.js";
import { getUsageLedger } from "./usage.js";

function colorForRole(role) {
  if (role === "user") return "cyan";
  if (role === "assistant") return "green";
  return "magenta";
}

function backendFooterColor(backend) {
  return backend?.hasError ? "red" : "gray";
}

function backendFooterLabel(backend) {
  if (backend?.hasError) return "error";
  if (backend?.enabled === false) return "off";
  return "ok";
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

export function InkChatApp({ systemPrompt, chatCompletion, driver }) {
  const { exit } = useApp();
  const sessionRef = useRef(createReplState({ systemPrompt }));
  const limitsByModelRef = useRef(readLiteLLMLimits());
  const gatewayRef = useRef(buildGatewayOptions());
  const nextIdRef = useRef(0);
  const exitingRef = useRef(false);

  const [items, setItems] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [screen, setScreen] = useState("conversation");
  const [syncStatus, setSyncStatus] = useState(() => readLocalSyncStatusModel());
  const [syncNotice, setSyncNotice] = useState("");
  const [footer, setFooter] = useState(() =>
    createStatusLine(
      createStatusState({
        sessionUsage: sessionRef.current.sessionUsage,
        estimatedTokens: sessionRef.current.estimatedTokensRef.value,
        routing: sessionRef.current.latestRouting,
        ledgerTotals: getUsageLedger().totals,
        authEnabled: Boolean(gatewayRef.current.apiKey)
      })
    )
  );

  const refreshFooter = useCallback((routingOverride) => {
    const state = sessionRef.current;
    setFooter(
      createStatusLine(
        createStatusState({
          sessionUsage: state.sessionUsage,
          estimatedTokens: state.estimatedTokensRef.value,
          routing: routingOverride ?? state.latestRouting,
          ledgerTotals: getUsageLedger().totals,
          authEnabled: Boolean(gatewayRef.current.apiKey)
        })
      )
    );
  }, []);

  const refreshSyncStatus = useCallback((override) => {
    if (override && typeof override === "object") {
      setSyncStatus(override);
      return;
    }
    setSyncStatus(readLocalSyncStatusModel());
  }, []);

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
    appendItem({
      id,
      kind: "message",
      role: "assistant",
      content: "thinking..."
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
        const current = item.content === "thinking..." ? "" : item.content;
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
      const line = String(value || "").trim();
      setInputValue("");
      if (!line || isBusy) return;

      const state = sessionRef.current;
      setIsBusy(true);
      try {
        const command = await executeCommand({
          line,
          state,
          limitsByModel: limitsByModelRef.current,
          mode: "tui",
          handlers: {
            message: (text) => appendMessage("system", text),
            panel: (title, lines) => appendPanel(title, lines)
          }
        });
        const action = command?.action && typeof command.action === "object" ? command.action : null;
        if (action?.type === "switch-screen") {
          if (action.screen === "sync") {
            setScreen("sync");
            setSyncNotice("");
            refreshSyncStatus(action.syncStatus);
          } else if (action.screen === "conversation") {
            setScreen("conversation");
            setSyncNotice("");
          }
        }
        if (line === "/sync" || line.startsWith("/sync ")) {
          if (!action?.syncStatus) {
            refreshSyncStatus();
          }
        }
        refreshFooter();

        if (command.handled) {
          if (command.exit) {
            await finalizeExit();
          }
          return;
        }

        if (screen === "sync") {
          setSyncNotice("sync screen active; run /conv before sending prompts");
          refreshSyncStatus();
          return;
        }

        appendMessage("user", line);
        const assistantMessageId = createAssistantMessage();
        let streamedAny = false;
        state.transcriptSavedPath = null;

        const result = await processPrompt({
          prompt: line,
          history: state.history,
          systemPrompt: state.activeSystemPrompt,
          sessionUsage: state.sessionUsage,
          estimatedTokensRef: state.estimatedTokensRef,
          renderMode: "silent",
          chatCompletion,
          onThinkingChange: (thinking) => {
            if (thinking) {
              replaceAssistantText(assistantMessageId, "thinking...");
            }
          },
          onAssistantDelta: (chunk) => {
            streamedAny = true;
            appendAssistantChunk(assistantMessageId, chunk);
          },
          onRouting: (routing) => {
            state.latestRouting = routing;
            refreshFooter(routing);
          },
          onWarning: (message) => {
            appendMessage("system", message);
          }
        });

        state.latestRouting = result.routing;
        if (!streamedAny) {
          replaceAssistantText(assistantMessageId, result.assistantText || "[no content]");
        }
        refreshFooter(result.routing);
        refreshSyncStatus();
      } catch (error) {
        appendMessage("system", `[chat] ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsBusy(false);
      }
    },
    [
      appendAssistantChunk,
      appendMessage,
      appendPanel,
      chatCompletion,
      createAssistantMessage,
      finalizeExit,
      isBusy,
      screen,
      refreshSyncStatus,
      refreshFooter,
      replaceAssistantText
    ]
  );

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      void finalizeExit();
    }
  });

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
    appendMessage("system", "massa-vault chat started. type /help for commands.");
  }, [appendMessage]);

  useEffect(() => {
    if (screen !== "sync") return;
    refreshSyncStatus();
    const timer = setInterval(() => {
      refreshSyncStatus();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [refreshSyncStatus, screen]);

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

    return createElement(
      Box,
      { key: item.id, marginBottom: 1 },
      createElement(Text, { color: colorForRole(item.role) }, `${item.role}> ${item.content}`)
    );
  };

  const headerMeta =
    `gateway=${gatewayRef.current.gatewayUrl} ` +
    `model=${DEFAULT_GATEWAY_MODEL} ` +
    `auth=${gatewayRef.current.apiKey ? "on" : "off"}`;
  const syncScreenActive = screen === "sync";
  const inputPlaceholder = syncScreenActive
    ? "Sync screen active. Type /conv to return"
    : isBusy
      ? "waiting for assistant..."
      : "Type message or /help";

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(
      Box,
      {
        borderStyle: "round",
        borderColor: "cyan",
        paddingX: 1,
        flexDirection: "column"
      },
      createElement(Text, { color: "cyan", bold: true }, "massa-vault chat"),
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
            syncNotice ? createElement(Text, { color: "yellow" }, syncNotice) : null,
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
      createElement(Text, { color: "green" }, "you> "),
      createElement(TextInput, {
        value: inputValue,
        onChange: setInputValue,
        onSubmit: handleSubmit,
        placeholder: inputPlaceholder,
        focus: !isBusy
      })
    ),
    createElement(
      Box,
      {
        marginTop: 1,
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1
      },
      createElement(Text, { color: "gray" }, `${footer} `),
      createElement(Text, { color: backendFooterColor(backendGit) }, `Git=${backendFooterLabel(backendGit)} `),
      createElement(Text, { color: backendFooterColor(backendDrive) }, `Drive=${backendFooterLabel(backendDrive)}`)
    )
  );
}

export async function runInkRepl({ systemPrompt }) {
  const instance = render(createElement(InkChatApp, { systemPrompt }), {
    exitOnCtrlC: false
  });
  await instance.waitUntilExit();
}
