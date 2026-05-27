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
  saveTranscript
} from "./cli.js";
import { readLiteLLMLimits } from "./litellm-limits.js";
import { getUsageLedger } from "./usage.js";

function colorForRole(role) {
  if (role === "user") return "cyan";
  if (role === "assistant") return "green";
  return "magenta";
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

  const persistTranscriptIfNeeded = useCallback(async () => {
    const state = sessionRef.current;
    if (state.transcriptSavedPath || !state.history.length) {
      return state.transcriptSavedPath;
    }

    state.transcriptSavedPath = await saveTranscript({
      sessionId: state.sessionId,
      sessionStartedAt: state.sessionStartedAt,
      history: state.history,
      latestRouting: state.latestRouting,
      sessionUsage: state.sessionUsage
    });
    if (state.transcriptSavedPath) {
      appendMessage("system", `[chat] transcript saved: ${state.transcriptSavedPath}`);
    }
    return state.transcriptSavedPath;
  }, [appendMessage]);

  const finalizeExit = useCallback(async () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    try {
      await persistTranscriptIfNeeded();
    } finally {
      exit();
    }
  }, [exit, persistTranscriptIfNeeded]);

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
        refreshFooter();

        if (command.handled) {
          if (command.exit) {
            await finalizeExit();
          }
          return;
        }

        appendMessage("user", line);
        const assistantMessageId = createAssistantMessage();
        let streamedAny = false;

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
    appendMessage("system", "massa-vault chat started. type /help for commands.");
  }, [appendMessage]);

  useEffect(() => {
    if (!driver || typeof driver !== "object") return;
    driver.submit = (line) => handleSubmit(String(line || ""));
    driver.exit = () => finalizeExit();
    return () => {
      delete driver.submit;
      delete driver.exit;
    };
  }, [driver, finalizeExit, handleSubmit]);

  const visibleItems = items.slice(-20);

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
      visibleItems.length
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
        placeholder: isBusy ? "waiting for assistant..." : "Type message or /help",
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
      createElement(Text, { color: "gray" }, footer)
    )
  );
}

export async function runInkRepl({ systemPrompt }) {
  const instance = render(createElement(InkChatApp, { systemPrompt }), {
    exitOnCtrlC: false
  });
  await instance.waitUntilExit();
}
