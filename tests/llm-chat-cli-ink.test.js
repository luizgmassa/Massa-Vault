import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeCommand } from "../tools/llm-chat-cli/src/cli.js";

process.env.MASSA_VAULT_CHAT_RAG = "off";

async function loadInkStack(t) {
  try {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const inkRepl = await import("../tools/llm-chat-cli/src/cli/ink-repl.js");
    return {
      React,
      render,
      InkChatApp: inkRepl.InkChatApp,
      CHAT_THEME: inkRepl.CHAT_THEME,
      colorForRole: inkRepl.colorForRole,
      getSlashCommandSuggestions: inkRepl.getSlashCommandSuggestions,
      moveSlashSuggestionSelection: inkRepl.moveSlashSuggestionSelection,
      resolveSlashEnterAction: inkRepl.resolveSlashEnterAction,
      tabCompleteSlashCommandInput: inkRepl.tabCompleteSlashCommandInput,
      navigatePromptHistory: inkRepl.navigatePromptHistory
    };
  } catch {
    t.skip("Ink dependencies are not installed in this environment");
    return null;
  }
}

async function withTempDir(run) {
  const previousCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-ink-"));
  process.chdir(tempDir);
  try {
    await run(tempDir);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeState(tempDir, state) {
  const stateDir = path.join(tempDir, ".automation", "notes-automation");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

function extractTokenCount(frame) {
  const match = String(frame || "").match(/\[\s*(\d+)\s+tokens\s*\]/);
  return match ? Number(match[1]) : null;
}

function extractMarkdownTableLine(frame, startsWithCell) {
  const lines = String(frame || "").split("\n");
  return (
    lines.find((line) => line.trimStart().startsWith(startsWithCell)) || ""
  ).trimStart();
}

function pipePositions(line) {
  const positions = [];
  const text = String(line || "");
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|") positions.push(index);
  }
  return positions;
}

test("Ink chat renders compact header/footer format", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    writeState(tempDir, {
      running: false,
      pid: null,
      paused: false,
      sync: { status: "idle", conflictCount: 0 }
    });

    const { React, render, InkChatApp } = stack;
    const app = render(
      React.createElement(InkChatApp, {
        systemPrompt: "",
        chatCompletion: async () => ({
          assistantText: "",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          routing: null
        })
      })
    );

    await delay(20);
    const frame = app.lastFrame();
    assert.match(frame, /Massa Vault AI Assistant/);
    assert.match(frame, /Gateway: .* \| Model: pending @ unknown \| Auth: (On|Off)/);
    assert.doesNotMatch(frame, /smart-router/);
    assert.match(frame, /you>/);
    assert.match(frame, /\[ 0 tokens \] \[ model: pending @ unknown \] \[ sync status: git ok \/ drive ok \]/);
    app.unmount();
  });
});

test("Ink chat exports role theme colors", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { CHAT_THEME, colorForRole } = stack;
  assert.equal(CHAT_THEME.header, "#d97706");
  assert.equal(CHAT_THEME.assistant, "#ffb86b");
  assert.equal(CHAT_THEME.system, CHAT_THEME.assistant);
  assert.equal(CHAT_THEME.user, "#2f9e44");
  assert.equal(colorForRole("system"), colorForRole("assistant"));
});

test("slash suggestions filter commands and tab completes only single match", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { getSlashCommandSuggestions, tabCompleteSlashCommandInput } = stack;
  const root = getSlashCommandSuggestions("/");
  const syncPrefix = getSlashCommandSuggestions("/sy");
  const syncStatusPrefix = getSlashCommandSuggestions("/sync s");

  assert.equal(root.length > 6, true);
  assert.equal(root.some((entry) => entry.command === "/sync"), true);
  assert.equal(root.some((entry) => entry.command === "/routing"), true);
  assert.equal(root.some((entry) => entry.command === "/search"), true);
  assert.equal(root.some((entry) => entry.command === "/history"), true);
  assert.equal(root.some((entry) => entry.command === "/back"), true);
  assert.equal(root.some((entry) => entry.command === "/history date"), true);
  assert.equal(root.some((entry) => entry.command === "/history summary"), true);
  assert.equal(root.some((entry) => entry.command === "/history preview"), true);
  assert.equal(root.some((entry) => entry.command === "/save"), false);
  assert.equal(root.some((entry) => entry.command === "/help"), false);
  assert.equal(syncPrefix.length > 1, true);
  assert.deepEqual(syncStatusPrefix.map((entry) => entry.command), ["/sync status"]);
  assert.equal(tabCompleteSlashCommandInput("/sy"), "/sy");
  assert.equal(tabCompleteSlashCommandInput("/sync s"), "/sync status");
  assert.equal(tabCompleteSlashCommandInput("/search"), "/search ");
  assert.equal(tabCompleteSlashCommandInput("/system set"), "/system set ");
});

test("slash selection cycles and enter action respects requiresInput", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { moveSlashSuggestionSelection, resolveSlashEnterAction } = stack;
  assert.equal(moveSlashSuggestionSelection({ currentIndex: null, suggestionCount: 3, direction: "down" }), 0);
  assert.equal(moveSlashSuggestionSelection({ currentIndex: 0, suggestionCount: 3, direction: "down" }), 1);
  assert.equal(moveSlashSuggestionSelection({ currentIndex: 2, suggestionCount: 3, direction: "down" }), 0);
  assert.equal(moveSlashSuggestionSelection({ currentIndex: null, suggestionCount: 3, direction: "up" }), 2);
  assert.equal(moveSlashSuggestionSelection({ currentIndex: 0, suggestionCount: 3, direction: "up" }), 2);
  assert.equal(moveSlashSuggestionSelection({ currentIndex: null, suggestionCount: 0, direction: "up" }), null);

  const submitAction = resolveSlashEnterAction({
    inputValue: "/",
    suggestions: [{ command: "/sync", description: "sync now" }],
    selectedIndex: 0
  });
  assert.deepEqual(submitAction, { mode: "submit", line: "/sync" });

  const fillAction = resolveSlashEnterAction({
    inputValue: "/",
    suggestions: [{ command: "/search", description: "search", requiresInput: true }],
    selectedIndex: 0
  });
  assert.deepEqual(fillAction, { mode: "fill", line: "/search " });

  const noAction = resolveSlashEnterAction({
    inputValue: "hello",
    suggestions: [{ command: "/sync", description: "sync now" }],
    selectedIndex: 0
  });
  assert.equal(noAction, null);
});

test("prompt history navigation restores draft when returning past newest entry", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { navigatePromptHistory } = stack;
  const history = ["first prompt", "second prompt", "third prompt"];

  const up1 = navigatePromptHistory({
    history,
    cursor: null,
    draft: "",
    currentInput: "draft value",
    direction: "up"
  });
  assert.equal(up1.cursor, 0);
  assert.equal(up1.draft, "draft value");
  assert.equal(up1.nextInput, "third prompt");

  const up2 = navigatePromptHistory({
    history,
    cursor: up1.cursor,
    draft: up1.draft,
    currentInput: up1.nextInput,
    direction: "up"
  });
  assert.equal(up2.cursor, 1);
  assert.equal(up2.nextInput, "second prompt");

  const down1 = navigatePromptHistory({
    history,
    cursor: up2.cursor,
    draft: up2.draft,
    currentInput: up2.nextInput,
    direction: "down"
  });
  assert.equal(down1.cursor, 0);
  assert.equal(down1.nextInput, "third prompt");

  const down2 = navigatePromptHistory({
    history,
    cursor: down1.cursor,
    draft: down1.draft,
    currentInput: down1.nextInput,
    direction: "down"
  });
  assert.equal(down2.cursor, null);
  assert.equal(down2.nextInput, "draft value");
});

test("Ink footer shows running labels while daemon sync is syncing", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    writeState(tempDir, {
      running: true,
      pid: 1234,
      paused: false,
      sync: { status: "syncing", conflictCount: 0 }
    });

    const { React, render, InkChatApp } = stack;
    const app = render(
      React.createElement(InkChatApp, {
        systemPrompt: "",
        chatCompletion: async () => ({
          assistantText: "",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          routing: null
        })
      })
    );

    await delay(20);
    const frame = app.lastFrame();
    assert.match(
      frame,
      /\[ 0 tokens \] \[ model: pending @ unknown \] \[ sync status: git running \/ drive running \]/
    );
    app.unmount();
  });
});

test("Ink chat shows thinking state and updates compact footer after streaming", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    writeState(tempDir, {
      running: false,
      pid: null,
      paused: false,
      sync: { status: "idle", conflictCount: 0 }
    });

    const { React, render, InkChatApp } = stack;
    const driver = {};
    const app = render(
      React.createElement(InkChatApp, {
        systemPrompt: "",
        driver,
        chatCompletion: async ({ onRouting, onDelta, onUsage }) => {
          onRouting({
            lane: "general",
            confidence: "1.0000",
            targetModel: "smart-router-general",
            routedModel: "general_local",
            providerModel: "ollama_chat/qwen3.5:9b",
            displayModel: "qwen3.5:9b",
            modelLocation: "local"
          });
          await delay(120);
          onDelta("Hel");
          await delay(10);
          onDelta("lo");
          onUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
          return {
            assistantText: "Hello",
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            routing: {
              lane: "general",
              confidence: "1.0000",
              targetModel: "smart-router-general",
              routedModel: "general_local",
              providerModel: "ollama_chat/qwen3.5:9b",
              displayModel: "qwen3.5:9b",
              modelLocation: "local"
            }
          };
        }
      })
    );

    await delay(10);
    assert.equal(typeof driver.submit, "function");
    const pending = driver.submit("ping");
    await delay(30);
    assert.match(app.lastFrame(), /Model: qwen3\.5:9b @ local/);
    assert.match(app.lastFrame(), /assistant> thinking\.\.\. 00:00/);

    await pending;
    await delay(20);
    const frame = app.lastFrame();
    assert.match(frame, /assistant> Hello/);
    assert.match(frame, /\[ 3 tokens \] \[ model: qwen3\.5:9b @ local \] \[ sync status: git ok \/ drive ok \]/);
    assert.equal((frame.match(/\[\s*\d+\s+tokens\s*\]/g) || []).length, 1);
    app.unmount();
  });
});

test("Ink chat hides smart-router aliases when concrete model metadata is missing", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async ({ onRouting, onDelta, onUsage }) => {
        onRouting({
          lane: "general",
          confidence: "1.0000",
          targetModel: "smart-router-general",
          responseModel: "smart-router-general",
          displayModel: "smart-router-general",
          modelLocation: null
        });
        onDelta("ok");
        onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        return {
          assistantText: "ok",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          routing: {
            lane: "general",
            confidence: "1.0000",
            targetModel: "smart-router-general",
            responseModel: "smart-router-general",
            displayModel: "smart-router-general",
            modelLocation: null
          }
        };
      }
    })
  );

  await delay(10);
  await driver.submit("old gateway");
  await delay(30);

  const frame = app.lastFrame();
  assert.match(frame, /Model: pending @ unknown/);
  assert.match(frame, /\[ 2 tokens \] \[ model: pending @ unknown \]/);
  assert.doesNotMatch(frame, /smart-router/);
  app.unmount();
});

test("Ink token counter updates during stream then reconciles on usage", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async ({ onDelta, onUsage }) => {
        await delay(15);
        onDelta("alpha alpha alpha alpha ");
        await delay(120);
        onDelta("beta beta beta beta ");
        await delay(120);
        onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        return {
          assistantText: "alpha beta",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          routing: null
        };
      }
    })
  );

  await delay(10);
  const pending = driver.submit("stream me");
  await delay(70);
  const duringFirstChunk = extractTokenCount(app.lastFrame());
  await delay(120);
  const duringSecondChunk = extractTokenCount(app.lastFrame());
  await pending;
  await delay(30);
  const finalTokens = extractTokenCount(app.lastFrame());

  assert.equal(typeof duringFirstChunk, "number");
  assert.equal(typeof duringSecondChunk, "number");
  assert.equal(duringSecondChunk > duringFirstChunk, true);
  assert.equal(finalTokens, 2);
  app.unmount();
});

test("Ink renders assistant Markdown with aligned tables", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async ({ onUsage }) => {
        onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        return {
          assistantText: "# Title\n\n**Bold** text with `code`\n\n| A | Longer |\n| --- | --- |\n| x | y |",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          routing: null
        };
      }
    })
  );

  await delay(10);
  await driver.submit("markdown please");
  await delay(30);

  const frame = app.lastFrame();
  assert.match(frame, /assistant> Title/);
  assert.match(frame, /Bold text with code/);
  assert.doesNotMatch(frame, /\*\*Bold\*\*/);
  assert.match(frame, /\| A \| Longer \|/);
  assert.match(frame, /\| x \| y\s+\|/);
  app.unmount();
});

test("Ink shows thinking timer during delayed chat and animated delayed /sync command", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;

  const chatDriver = {};
  const chatApp = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver: chatDriver,
      chatCompletion: async ({ onDelta, onUsage }) => {
        await delay(420);
        onDelta("done");
        onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        return {
          assistantText: "done",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          routing: null
        };
      }
    })
  );

  await delay(10);
  const pendingChat = chatDriver.submit("slow prompt");
  await delay(40);
  const thinkingFrameA = chatApp.lastFrame();
  await delay(280);
  const thinkingFrameB = chatApp.lastFrame();
  assert.match(thinkingFrameA, /assistant> thinking\.\.\. 00:00/);
  assert.match(thinkingFrameB, /assistant> thinking\.\.\. 00:00/);
  assert.notEqual(thinkingFrameA, thinkingFrameB);
  await pendingChat;
  chatApp.unmount();

  const syncDriver = {};
  const syncApp = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver: syncDriver,
      chatCompletion: async () => ({
        assistantText: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        routing: null
      }),
      commandExecutor: async ({ line }) => {
        if (line === "/sync") {
          await delay(420);
        }
        return { handled: true, exit: false };
      }
    })
  );

  await delay(10);
  const pendingSync = syncDriver.submit("/sync");
  await delay(40);
  const syncFrameA = syncApp.lastFrame();
  await delay(280);
  const syncFrameB = syncApp.lastFrame();
  assert.match(syncFrameA, /running \/sync\.{1,3}/);
  assert.match(syncFrameB, /running \/sync\.{1,3}/);
  assert.notEqual(syncFrameA, syncFrameB);
  await pendingSync;
  syncApp.unmount();
});

test("Ink startup warmup starts once and first prompt does not wait", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    writeState(tempDir, {
      running: false,
      pid: null,
      paused: false,
      sync: { status: "idle", conflictCount: 0 }
    });

    const { React, render, InkChatApp } = stack;
    const driver = {};
    let chatCalls = 0;
    let startCalls = 0;
    let waitCalls = 0;
    let releaseWarmup;
    const warmupGate = new Promise((resolve) => {
      releaseWarmup = resolve;
    });
    const startupWarmup = {
      start() {
        startCalls += 1;
        return warmupGate;
      },
      async wait() {
        waitCalls += 1;
        await warmupGate;
        return { ok: true };
      }
    };

    const app = render(
      React.createElement(InkChatApp, {
        systemPrompt: "",
        driver,
        startupWarmup,
        chatCompletion: async ({ onDelta, onUsage }) => {
          chatCalls += 1;
          onDelta("ready");
          onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
          return {
            assistantText: "ready",
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            routing: null
          };
        }
      })
    );

    await delay(20);
    assert.equal(startCalls, 1);

    const firstPrompt = driver.submit("hello");
    await delay(30);
    assert.equal(chatCalls, 1);
    releaseWarmup();
    await firstPrompt;
    await delay(20);
    assert.equal(chatCalls, 1);
    assert.equal(waitCalls, 0);

    await driver.submit("second");
    await delay(20);
    assert.equal(chatCalls, 2);
    assert.equal(waitCalls, 0);
    app.unmount();
  });
});

test("Ink /usage command renders compact usage panel", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async () => ({
        assistantText: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        routing: null
      })
    })
  );

  await delay(10);
  assert.equal(typeof driver.submit, "function");
  await driver.submit("/usage");
  await delay(20);

  const frame = app.lastFrame();
  assert.match(frame, /usage:/i);
  assert.match(frame, /session_total_tokens:/);
  assert.match(frame, /remaining_tpm:/);
  app.unmount();
});

test("Ink /sync status switches to sync screen, blocks prompts, and /conv restores conversation", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    writeState(tempDir, {
      running: false,
      pid: null,
      paused: true,
      alert: "Sync paused: Google Drive bisync needs manual intervention.",
      sync: {
        status: "paused",
        conflictCount: 0,
        reviewNeeded: true,
        gdriveImport: "dangerous",
        lastError: "dangerous gdrive import held for review"
      },
      lastGDriveError: "bisync failed",
      lastGDriveRequiresResync: true,
      lastGDriveAutoResyncAttempted: true,
      lastGDriveAutoResyncApplied: false
    });

    const { React, render, InkChatApp } = stack;
    const driver = {};
    let chatCalls = 0;
    const app = render(
      React.createElement(InkChatApp, {
        systemPrompt: "",
        driver,
        chatCompletion: async ({ onDelta, onUsage }) => {
          chatCalls += 1;
          onDelta("ok");
          onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
          return {
            assistantText: "ok",
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            routing: null
          };
        }
      })
    );

    await delay(20);
    assert.equal(typeof driver.submit, "function");
    assert.equal(typeof driver.getSessionState, "function");

    await driver.submit("/sync status");
    await delay(30);
    let frame = app.lastFrame();
    assert.match(frame, /sync status \(refresh every 2s\)/i);
    assert.match(frame, /daemon:/i);
    assert.doesNotMatch(frame, /massa-vault chat started/i);

    await driver.submit("this should be blocked");
    await delay(20);
    assert.equal(chatCalls, 0);
    assert.equal(driver.getSessionState().history.length, 0);
    frame = app.lastFrame();
    assert.match(frame, /run \/conv before sending prompts/i);

    await driver.submit("/conv");
    await delay(30);
    frame = app.lastFrame();
    assert.match(frame, /massa-vault chat started/i);

    await driver.submit("hello");
    await delay(40);
    assert.equal(chatCalls, 1);
    const history = driver.getSessionState().history;
    assert.equal(history.length, 2);
    assert.equal(history[0].role, "user");
    assert.equal(history[1].role, "assistant");
    assert.equal(history.some((entry) => /\/sync status|\/conv|daemon:/i.test(entry.content || "")), false);

    app.unmount();
  });
});

test("Ink /history screen blocks prompts, allows /history commands, and /history switch hydrates messages", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  let chatCalls = 0;
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async ({ onDelta, onUsage }) => {
        chatCalls += 1;
        onDelta("ok");
        onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        return {
          assistantText: "ok",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          routing: null
        };
      },
      commandExecutor: async ({ line, state }) => {
        if (line === "/history") {
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "history",
              historyPanel: {
                title: "history",
                lines: ["history dates (newest first)", " 1  2026-05-30  conversations=1"]
              }
            }
          };
        }
        if (line === "/history date 1") {
          state.historyVisibleRows = [
            {
              number: 1,
              fileName: "10-00-00--loaded.md"
            }
          ];
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "history",
              historyPanel: {
                title: "history conversations for 2026-05-30",
                lines: ["#  time      date        transcript", " 1  10:00:00  2026-05-30  10-00-00--loaded.md"]
              }
            }
          };
        }
        if (line === "/history switch 1") {
          state.history = [
            { role: "user", content: "loaded user" },
            { role: "assistant", content: "loaded assistant" }
          ];
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "conversation",
              historyLoaded: {
                history: [...state.history]
              }
            }
          };
        }
        if (line === "/conv") {
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "conversation"
            }
          };
        }
        return { handled: false, exit: false };
      }
    })
  );

  await delay(20);
  await driver.submit("/history");
  await delay(20);
  let frame = app.lastFrame();
  assert.match(frame, /history dates/i);

  await driver.submit("blocked prompt");
  await delay(20);
  assert.equal(chatCalls, 0);
  frame = app.lastFrame();
  assert.match(frame, /history screen active\. run \/back or \/conv or use \/history commands\./i);
  assert.equal(driver.getSessionState().history.length, 0);

  await driver.submit("/history date 1");
  await delay(20);
  frame = app.lastFrame();
  assert.match(frame, /history conversations for 2026-05-30/i);
  assert.equal(driver.getSessionState().history.length, 0);

  await driver.submit("/history switch 1");
  await delay(20);
  frame = app.lastFrame();
  assert.match(frame, /user> loaded user/i);
  assert.match(frame, /assistant> loaded assistant/i);
  assert.equal(driver.getSessionState().history.length, 2);
  assert.equal(
    driver.getSessionState().history.some((entry) => /history dates|history conversations/i.test(entry.content || "")),
    false
  );

  await driver.submit("resume chat");
  await delay(30);
  assert.equal(chatCalls, 1);
  app.unmount();
});

test("Ink history flow supports /back stack navigation end-to-end", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    const vaultPath = path.join(tempDir, "vault");
    const day = "2026-05-30";
    const chatDir = path.join(vaultPath, "AI Chats", day);
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, "10-00-00--flow.md"),
      "---\nid: \"flow\"\n---\n\n## USER\nhello\n\n## ASSISTANT\nworld\n",
      "utf8"
    );

    const previousVaultPath = process.env.VAULT_PATH;
    process.env.VAULT_PATH = vaultPath;
    try {
      const { React, render, InkChatApp } = stack;
      const driver = {};
      let chatCalls = 0;
      const app = render(
        React.createElement(InkChatApp, {
          systemPrompt: "",
          driver,
          chatCompletion: async ({ onDelta, onUsage }) => {
            chatCalls += 1;
            onDelta("ok");
            onUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
            return {
              assistantText: "ok",
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              routing: null
            };
          },
          commandExecutor: (params) =>
            executeCommand({
              ...params,
              onSaveAndSync: async () => ({
                saveResult: { path: null, saved: false },
                summary: "[chat] sync status=idle conflicts=0"
              }),
              historySummaryRunner: async () => ({
                summary: "Flow summary line.",
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                routing: null
              })
            })
        })
      );

      await delay(20);
      await driver.submit("/history");
      await delay(20);
      let frame = app.lastFrame();
      assert.match(frame, /History dates/i);

      await driver.submit("blocked prompt");
      await delay(20);
      frame = app.lastFrame();
      assert.equal(chatCalls, 0);
      assert.match(frame, /history screen active\. run \/back or \/conv or use \/history commands\./i);

      await driver.submit("1");
      await delay(20);
      frame = app.lastFrame();
      assert.match(frame, /History conversations for 2026-05-30/i);

      await driver.submit("/summary 1");
      await delay(20);
      frame = app.lastFrame();
      assert.match(frame, /History summary/i);
      assert.match(frame, /Flow summary line\./);

      await driver.submit("/back");
      await delay(20);
      frame = app.lastFrame();
      assert.match(frame, /History conversations for 2026-05-30/i);

      await driver.submit("/back");
      await delay(20);
      frame = app.lastFrame();
      assert.match(frame, /History dates/i);

      await driver.submit("/back");
      await delay(20);
      frame = app.lastFrame();
      assert.match(frame, /massa-vault chat started/i);

      await driver.submit("resume chat");
      await delay(30);
      assert.equal(chatCalls, 1);
      app.unmount();
    } finally {
      if (previousVaultPath === undefined) {
        delete process.env.VAULT_PATH;
      } else {
        process.env.VAULT_PATH = previousVaultPath;
      }
    }
  });
});

test("Ink history conversations support alias dispatch for /summary and /switch", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    const vaultPath = path.join(tempDir, "vault");
    const day = "2026-05-30";
    const chatDir = path.join(vaultPath, "AI Chats", day);
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, "10-00-00--alias.md"),
      "---\nid: \"alias\"\n---\n\n## USER\nloaded user\n\n## ASSISTANT\nloaded assistant\n",
      "utf8"
    );

    const previousVaultPath = process.env.VAULT_PATH;
    process.env.VAULT_PATH = vaultPath;
    try {
      const { React, render, InkChatApp } = stack;
      const driver = {};
      const app = render(
        React.createElement(InkChatApp, {
          systemPrompt: "",
          driver,
          chatCompletion: async () => ({
            assistantText: "",
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            routing: null
          }),
          commandExecutor: (params) =>
            executeCommand({
              ...params,
              onSaveAndSync: async () => ({
                saveResult: { path: null, saved: false },
                summary: "[chat] sync status=idle conflicts=0"
              }),
              historySummaryRunner: async () => ({
                summary: "Alias summary line.",
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                routing: null
              })
            })
        })
      );

      await delay(20);
      await driver.submit("/history");
      await delay(20);
      await driver.submit("1");
      await delay(20);

      await driver.submit("/summary 1");
      await delay(20);
      let frame = app.lastFrame();
      assert.match(frame, /History summary/i);
      assert.match(frame, /Alias summary line\./);

      await driver.submit("/back");
      await delay(20);
      await driver.submit("/switch 1");
      await delay(30);
      frame = app.lastFrame();
      assert.match(frame, /user> loaded user/i);
      assert.match(frame, /assistant> loaded assistant/i);
      app.unmount();
    } finally {
      if (previousVaultPath === undefined) {
        delete process.env.VAULT_PATH;
      } else {
        process.env.VAULT_PATH = previousVaultPath;
      }
    }
  });
});

test("Ink /history summary shows busy state while summary is running", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    const vaultPath = path.join(tempDir, "vault");
    const day = "2026-05-30";
    const chatDir = path.join(vaultPath, "AI Chats", day);
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, "10-00-00--busy.md"),
      "---\nid: \"busy\"\n---\n\n## USER\nNeed summary\n\n## ASSISTANT\nStill loading.\n",
      "utf8"
    );

    const previousVaultPath = process.env.VAULT_PATH;
    process.env.VAULT_PATH = vaultPath;
    try {
      const { React, render, InkChatApp } = stack;
      const driver = {};
      let releaseSummary = () => {};
      const summaryGate = new Promise((resolve) => {
        releaseSummary = resolve;
      });
      const app = render(
        React.createElement(InkChatApp, {
          systemPrompt: "",
          driver,
          chatCompletion: async () => ({
            assistantText: "",
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            routing: null
          }),
          commandExecutor: (params) =>
            executeCommand({
              ...params,
              onSaveAndSync: async () => ({
                saveResult: { path: null, saved: false },
                summary: "[chat] sync status=idle conflicts=0"
              }),
              historySummaryRunner: async () => {
                await summaryGate;
                return {
                  summary: "Busy summary line.",
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                  routing: null
                };
              }
            })
        })
      );

      await delay(20);
      await driver.submit("/history");
      await delay(20);
      await driver.submit("1");
      await delay(20);

      const pendingSummary = driver.submit("/history summary 1");
      await delay(40);
      const frameA = app.lastFrame();
      await delay(280);
      const frameB = app.lastFrame();
      assert.match(frameA, /History conversations for 2026-05-30/i);
      assert.match(frameA, /running \/history summary 1\.{1,3}/);
      assert.match(frameB, /running \/history summary 1\.{1,3}/);
      assert.notEqual(frameA, frameB);

      releaseSummary();
      await pendingSummary;
      await delay(20);
      const finalFrame = app.lastFrame();
      assert.match(finalFrame, /History summary/i);
      assert.match(finalFrame, /Busy summary line\./);
      app.unmount();
    } finally {
      if (previousVaultPath === undefined) {
        delete process.env.VAULT_PATH;
      } else {
        process.env.VAULT_PATH = previousVaultPath;
      }
    }
  });
});

test("Ink /history summary keeps history screen and shows command errors inline", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  await withTempDir(async (tempDir) => {
    const vaultPath = path.join(tempDir, "vault");
    const day = "2026-05-30";
    const chatDir = path.join(vaultPath, "AI Chats", day);
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, "10-00-00--error.md"),
      "---\nid: \"error\"\n---\n\n## USER\nNeed summary\n\n## ASSISTANT\nFail please.\n",
      "utf8"
    );

    const previousVaultPath = process.env.VAULT_PATH;
    process.env.VAULT_PATH = vaultPath;
    try {
      const { React, render, InkChatApp } = stack;
      const driver = {};
      const app = render(
        React.createElement(InkChatApp, {
          systemPrompt: "",
          driver,
          chatCompletion: async () => ({
            assistantText: "",
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            routing: null
          }),
          commandExecutor: (params) =>
            executeCommand({
              ...params,
              onSaveAndSync: async () => ({
                saveResult: { path: null, saved: false },
                summary: "[chat] sync status=idle conflicts=0"
              }),
              historySummaryRunner: async () => {
                throw new Error("history summary exploded");
              }
            })
        })
      );

      await delay(20);
      await driver.submit("/history");
      await delay(20);
      await driver.submit("1");
      await delay(20);

      await driver.submit("/history summary 1");
      await delay(20);
      const frame = app.lastFrame();
      assert.match(frame, /\n History\n \[chat\] history summary exploded/i);
      assert.match(frame, /History conversations for 2026-05-30/i);
      assert.match(frame, /\[chat\] history summary exploded/i);
      app.unmount();
    } finally {
      if (previousVaultPath === undefined) {
        delete process.env.VAULT_PATH;
      } else {
        process.env.VAULT_PATH = previousVaultPath;
      }
    }
  });
});

test("Ink History markdown table keeps header/separator/data pipe alignment", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async () => ({
        assistantText: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        routing: null
      }),
      commandExecutor: async ({ line }) => {
        if (line === "/history") {
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "history",
              historyPanel: {
                title: "History",
                renderMarkdown: true,
                lines: [
                  "## History dates",
                  "",
                  "| # | Date | Conversations |",
                  "| --- | --- | --- |",
                  "| 1 | 2026-05-30 | 9 |"
                ]
              }
            }
          };
        }
        return { handled: false, exit: false };
      }
    })
  );

  await delay(20);
  await driver.submit("/history");
  await delay(30);
  const frame = app.lastFrame();
  const header = extractMarkdownTableLine(frame, "| # |");
  const separator = extractMarkdownTableLine(frame, "| -");
  const row = extractMarkdownTableLine(frame, "| 1 |");
  assert.ok(header);
  assert.ok(separator);
  assert.ok(row);
  assert.deepEqual(pipePositions(separator), pipePositions(header));
  assert.deepEqual(pipePositions(row), pipePositions(header));
  app.unmount();
});

test("Ink History summary preserves blank sentence spacing", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async () => ({
        assistantText: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        routing: null
      }),
      commandExecutor: async ({ line }) => {
        if (line === "/history summary 1") {
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "history",
              historyPanel: {
                title: "History summary",
                renderMarkdown: true,
                lines: ["## History summary", "", "Sentence one.", "", "Sentence two."]
              }
            }
          };
        }
        return { handled: false, exit: false };
      }
    })
  );

  await delay(20);
  await driver.submit("/history summary 1");
  await delay(30);
  const frame = app.lastFrame();
  assert.match(frame, /Sentence one\.\n[^\S\r\n]*\n[^\S\r\n]*Sentence two\./);
  app.unmount();
});

test("Ink /history summary refreshes footer model from updated session routing", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async () => ({
        assistantText: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        routing: null
      }),
      commandExecutor: async ({ line, state }) => {
        if (line === "/history summary 1") {
          state.latestRouting = {
            lane: "general",
            confidence: "1.0000",
            targetModel: "smart-router-general",
            routedModel: "general_local",
            providerModel: "ollama_chat/qwen3.5:9b",
            displayModel: "qwen3.5:9b",
            modelLocation: "local",
            responseModel: "ollama_chat/qwen3.5:9b"
          };
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "history",
              historyPanel: {
                title: "History summary",
                renderMarkdown: true,
                lines: ["## History summary", "", "Updated summary."]
              }
            }
          };
        }
        return { handled: false, exit: false };
      }
    })
  );

  await delay(20);
  await driver.submit("/history summary 1");
  await delay(30);
  const frame = app.lastFrame();
  assert.match(frame, /Model: qwen3\.5:9b @ local/);
  assert.match(frame, /\[ 0 tokens \] \[ model: qwen3\.5:9b @ local \]/);
  app.unmount();
});

test("Ink /history preview screen scrolls with Up/Down arrows", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

  const { React, render, InkChatApp } = stack;
  const driver = {};
  const transcriptLines = Array.from({ length: 40 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`);
  const app = render(
    React.createElement(InkChatApp, {
      systemPrompt: "",
      driver,
      chatCompletion: async () => ({
        assistantText: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        routing: null
      }),
      commandExecutor: async ({ line }) => {
        if (line === "/history preview 1") {
          return {
            handled: true,
            exit: false,
            action: {
              type: "switch-screen",
              screen: "history",
              historyPanel: {
                title: "History preview",
                renderMarkdown: true,
                scrollable: true,
                previewMode: true,
                lines: [
                  "## History preview",
                  "",
                  "### Transcript",
                  "",
                  "```markdown",
                  ...transcriptLines,
                  "```"
                ]
              }
            }
          };
        }
        return { handled: false, exit: false };
      }
    })
  );

  await delay(20);
  await driver.submit("/history preview 1");
  await delay(30);
  let frame = app.lastFrame();
  assert.match(frame, /Preview scroll : 1-24 \/ \d+ \(Up\/Down\)/);
  assert.match(frame, /line-01/);
  assert.doesNotMatch(frame, /line-40/);

  app.stdin.write("\u001b[B");
  await delay(20);
  frame = app.lastFrame();
  assert.match(frame, /Preview scroll : 2-25 \/ \d+ \(Up\/Down\)/);

  for (let i = 0; i < 12; i += 1) {
    app.stdin.write("\u001b[B");
  }
  await delay(30);
  frame = app.lastFrame();
  assert.match(frame, /Preview scroll : 14-37 \/ \d+ \(Up\/Down\)/);
  assert.match(frame, /line-33/);

  app.stdin.write("\u001b[A");
  await delay(20);
  frame = app.lastFrame();
  assert.match(frame, /Preview scroll : 13-36 \/ \d+ \(Up\/Down\)/);
  app.unmount();
});
