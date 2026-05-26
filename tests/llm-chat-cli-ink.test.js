import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

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

test("Ink chat renders header, input prompt, and fixed footer", async (t) => {
  const stack = await loadInkStack(t);
  if (!stack) return;

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
  app.unmount();
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
