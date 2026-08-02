import test from "node:test";
import assert from "node:assert/strict";
import {
  writeMessage,
  writeLines,
  renderCommands,
  createHistorySelectionUsage
} from "../tools/llm-chat-cli/src/commands/shared.js";
import {
  getCommandDefinitions,
  getCommandPanelLines
} from "../tools/llm-chat-cli/src/commands/definitions.js";
import { formatCommandScreenLines } from "../tools/llm-chat-cli/src/domain/info-screen.js";

async function withCapturedConsoleLog(run) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.log = originalLog;
  }
}

test("writeMessage prints to the console in plain mode and never touches handlers", async () => {
  const handlers = {
    message: () => {
      throw new Error("handlers.message must not be called in plain mode");
    }
  };

  const { lines } = await withCapturedConsoleLog(() => {
    writeMessage("plain", handlers, "[chat] plain mode message");
  });

  assert.deepEqual(lines, ["[chat] plain mode message"]);
});

test("writeMessage delegates to handlers.message outside plain mode", () => {
  const messages = [];
  const handlers = { message: (text) => messages.push(text) };

  writeMessage("tui", handlers, "[chat] tui mode message");

  assert.deepEqual(messages, ["[chat] tui mode message"]);
});

test("writeLines prints every line to the console in plain mode and never touches handlers", async () => {
  const handlers = {
    panel: () => {
      throw new Error("handlers.panel must not be called in plain mode");
    }
  };

  const { lines } = await withCapturedConsoleLog(() => {
    writeLines("plain", handlers, "Ignored title", ["line one", "line two", "line three"]);
  });

  assert.deepEqual(lines, ["line one", "line two", "line three"]);
});

test("writeLines delegates title and lines to handlers.panel outside plain mode", () => {
  const panelCalls = [];
  const handlers = {
    panel: (title, lines) => panelCalls.push({ title, lines })
  };

  writeLines("tui", handlers, "Config", ["gateway_url: http://127.0.0.1:4100"]);

  assert.equal(panelCalls.length, 1);
  assert.deepEqual(panelCalls[0], {
    title: "Config",
    lines: ["gateway_url: http://127.0.0.1:4100"]
  });
});

test("renderCommands prints the command list to the console in plain mode", async () => {
  const { result, lines } = await withCapturedConsoleLog(() => renderCommands("plain"));

  assert.deepEqual(result, { handled: true, exit: false });
  assert.equal(lines[0], "Commands:");
  // Every real command panel line should be echoed back indented by two spaces.
  const expectedIndented = getCommandPanelLines().map((commandLine) => `  ${commandLine}`);
  assert.deepEqual(lines.slice(1), expectedIndented);
});

test("renderCommands returns a scrollable info-screen action outside plain mode", () => {
  const result = renderCommands("tui");

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.equal(result.action?.type, "switch-screen");
  assert.equal(result.action?.screen, "panel");
  assert.equal(result.action?.panelScreen?.id, "commands");
  assert.equal(result.action?.panelScreen?.title, "Commands");
  assert.equal(result.action?.panelScreen?.scrollable, true);
  assert.deepEqual(
    result.action?.panelScreen?.lines,
    formatCommandScreenLines(getCommandDefinitions())
  );
});

test("createHistorySelectionUsage formats a row-selection usage hint per command", () => {
  assert.equal(
    createHistorySelectionUsage("/history switch"),
    "Usage : /history switch <number> (pick from current history table)"
  );
  assert.equal(
    createHistorySelectionUsage("/history preview"),
    "Usage : /history preview <number> (pick from current history table)"
  );
});
