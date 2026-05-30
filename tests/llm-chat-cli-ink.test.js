import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function loadInkStack(t) {
  try {
    const React = await import("react");
    const { render } = await import("ink-testing-library");
    const { InkChatApp } = await import("../tools/llm-chat-cli/src/ink-repl.js");
    return { React, render, InkChatApp };
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

test("Ink chat renders header, input prompt, and footer with Git/Drive labels", async (t) => {
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
    assert.match(frame, /massa-vault chat/);
    assert.match(frame, /you>/);
    assert.match(frame, /\[tokens session=0/);
    assert.match(frame, /Git=/);
    assert.match(frame, /Drive=/);
    app.unmount();
  });
});

test("Ink chat shows thinking state and updates one footer line after streaming", async (t) => {
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
          targetModel: "smart-router-general"
        });
        await delay(25);
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
            targetModel: "smart-router-general"
          }
        };
      }
    })
  );

  await delay(10);
  assert.equal(typeof driver.submit, "function");
  const pending = driver.submit("ping");
  await delay(5);
  assert.match(app.lastFrame(), /thinking\.\.\./);

  await pending;
  await delay(20);
  const frame = app.lastFrame();
  assert.match(frame, /assistant> Hello/);
  assert.match(frame, /\[tokens session=3/);
  assert.equal((frame.match(/\[tokens session=/g) || []).length, 1);
  app.unmount();
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
