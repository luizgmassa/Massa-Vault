import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createStartupWarmup,
  createReplState,
  createStatusRenderer,
  executeCommand,
  processPrompt,
  saveTranscript
} from "../tools/llm-chat-cli/src/cli.js";
import { createSessionUsage } from "../tools/llm-chat-cli/src/usage.js";

async function withTempDir(run) {
  const previousCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-chat-rag-"));
  process.chdir(tempDir);
  try {
    await run(tempDir);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeMinimalConfig(tempDir) {
  const vaultPath = path.join(tempDir, "vault");
  fs.mkdirSync(path.join(tempDir, "config"), { recursive: true });
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "config/notes-automation.config.json"),
    JSON.stringify(
      {
        enabled: true,
        vault_path: vaultPath,
        sync_strategy: "git"
      },
      null,
      2
    ),
    "utf8"
  );
  return vaultPath;
}

async function withEnvValue(key, value, run) {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

function vectorForText(text) {
  const value = String(text || "").toLowerCase();
  return [
    value.includes("alpha") ? 1 : 0,
    value.includes("beta") ? 1 : 0,
    value.includes("security") ? 1 : 0,
    value.includes("files") || value.includes("vault") ? 1 : 0
  ];
}

async function withMockEmbeddings(run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const embeddings = inputs.map(vectorForText);
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function captureProcessPromptBody({ prompt, tempDir }) {
  writeMinimalConfig(tempDir);
  const vaultPath = path.join(tempDir, "vault");
  fs.mkdirSync(path.join(vaultPath, "Projects"), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\nalpha vault intro", "utf8");
  fs.writeFileSync(
    path.join(vaultPath, "Projects", "Security.md"),
    "# Security\nsecurity best practices for alpha systems",
    "utf8"
  );
  fs.writeFileSync(path.join(vaultPath, "Beta.md"), "# Beta\nbeta reference note", "utf8");

  let capturedBody = null;
  await withEnvValue("MASSA_VAULT_CHAT_RAG", undefined, async () => {
    await withEnvValue("VAULT_PATH", vaultPath, async () => {
      await withMockEmbeddings(async () => {
        await processPrompt({
          prompt,
          history: [],
          systemPrompt: "",
          sessionUsage: createSessionUsage(),
          estimatedTokensRef: { value: 0 },
          renderMode: "silent",
          statusRenderer: createStatusRenderer({ stream: { isTTY: false, write() {} } }),
          chatCompletion: async ({ body, onUsage }) => {
            capturedBody = body;
            onUsage?.({ prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 });
            return {
              assistantText: "ok",
              usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
              routing: null
            };
          }
        });
      });
    });
  });
  return capturedBody;
}

test("processPrompt injects vault context message before latest user message", async () => {
  await withTempDir(async () => {
    writeMinimalConfig(process.cwd());
    const history = [{ role: "user", content: "previous question" }];
    const sessionUsage = createSessionUsage();
    const estimatedTokensRef = { value: 0 };
    let capturedBody = null;

    await processPrompt({
      prompt: "where is alpha?",
      history,
      systemPrompt: "global system prompt",
      sessionUsage,
      estimatedTokensRef,
      renderMode: "silent",
      statusRenderer: createStatusRenderer({ stream: { isTTY: false, write() {} } }),
      vaultContextBuilder: async () => ({
        message: "Relevant Obsidian vault context:\n[source 1] notes/alpha.md#0\nalpha details",
        metadata: {
          source: "obsidian",
          retrieved_chunks: 1,
          context_length: 74,
          sources: [{ path: "notes/alpha.md", chunk_index: 0, score: 0.91 }]
        }
      }),
      chatCompletion: async ({ body, onRouting, onUsage }) => {
        capturedBody = body;
        onRouting?.({
          lane: "general",
          confidence: "1.0000",
          targetModel: "smart-router-general"
        });
        onUsage?.({ prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
        return {
          assistantText: "answer",
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
          routing: {
            lane: "general",
            confidence: "1.0000",
            targetModel: "smart-router-general"
          }
        };
      }
    });

    assert.ok(capturedBody);
    assert.equal(capturedBody.context.source, "obsidian");
    assert.equal(capturedBody.context.retrieved_chunks, 1);
    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(capturedBody.messages[0].content, "global system prompt");
    assert.equal(capturedBody.messages.at(-2).role, "system");
    assert.match(capturedBody.messages.at(-2).content, /Relevant Obsidian vault context/);
    assert.equal(capturedBody.messages.at(-1).role, "user");
    assert.equal(capturedBody.messages.at(-1).content, "where is alpha?");

    assert.deepEqual(history.map((entry) => entry.role), ["user", "user", "assistant"]);
    assert.equal(
      history.some((entry) => String(entry.content || "").includes("Relevant Obsidian vault context")),
      false
    );
  });
});

test("default builder injects manifest mode for vault file list prompts", async () => {
  await withTempDir(async (tempDir) => {
    const body = await captureProcessPromptBody({
      prompt: "What files are in my vault?",
      tempDir
    });

    assert.equal(body.context.source, "obsidian");
    assert.equal(body.context.mode, "manifest");
    assert.equal(body.context.retrieved_files, 3);
    assert.equal(body.context.retrieved_chunks, 0);
    assert.equal(body.context.truncated, false);
    assert.match(body.messages.at(-3).content, /Vault access contract/);
    assert.match(body.messages.at(-2).content, /Obsidian vault manifest/);
    assert.match(body.messages.at(-2).content, /Welcome\.md/);
    assert.match(body.messages.at(-2).content, /Projects\/Security\.md/);
    assert.doesNotMatch(
      body.messages.at(-2).content,
      new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.equal(body.messages.at(-1).content, "What files are in my vault?");
  });
});

test("default builder injects semantic mode for content prompts", async () => {
  await withTempDir(async (tempDir) => {
    const body = await captureProcessPromptBody({
      prompt: "Summarize alpha security notes",
      tempDir
    });

    assert.equal(body.context.mode, "semantic");
    assert.equal(body.context.retrieved_chunks > 0, true);
    assert.equal(body.context.retrieved_files > 0, true);
    assert.match(body.messages.at(-3).content, /Vault access contract/);
    assert.match(body.messages.at(-2).content, /Relevant Obsidian vault context/);
    assert.equal(body.messages.at(-1).content, "Summarize alpha security notes");
  });
});

test("default builder injects hybrid mode for manifest plus content prompts", async () => {
  await withTempDir(async (tempDir) => {
    const body = await captureProcessPromptBody({
      prompt: "List notes about alpha security",
      tempDir
    });

    assert.equal(body.context.mode, "hybrid");
    assert.equal(body.context.retrieved_files > 0, true);
    assert.equal(body.context.retrieved_chunks > 0, true);
    assert.match(body.messages.at(-3).content, /Vault access contract/);
    assert.match(body.messages.at(-2).content, /Obsidian vault manifest/);
    assert.match(body.messages.at(-2).content, /Relevant Obsidian vault context/);
    assert.equal(body.messages.at(-1).content, "List notes about alpha security");
  });
});

test("vault access regression prompt includes access contract and metadata", async () => {
  await withTempDir(async (tempDir) => {
    const body = await captureProcessPromptBody({
      prompt: "Why cant you access my files? I allow you to",
      tempDir
    });

    assert.equal(body.context.source, "obsidian");
    assert.equal(body.context.mode, "semantic");
    assert.match(body.messages.at(-3).content, /Vault access contract/);
    assert.match(body.messages.at(-3).content, /do not claim you cannot access/);
    assert.equal(body.messages.at(-1).content, "Why cant you access my files? I allow you to");
  });
});

test("vault context is not persisted to transcript history", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    await withEnvValue("VAULT_PATH", vaultPath, async () => {
      const history = [];
      const sessionUsage = createSessionUsage();
      const estimatedTokensRef = { value: 0 };

      await processPrompt({
        prompt: "summarize beta",
        history,
        systemPrompt: "",
        sessionUsage,
        estimatedTokensRef,
        renderMode: "silent",
        statusRenderer: createStatusRenderer({ stream: { isTTY: false, write() {} } }),
        vaultContextBuilder: async () => ({
          message: "Relevant Obsidian vault context:\n[source 1] docs/beta.md#0\nbeta details",
          metadata: {
            source: "obsidian",
            retrieved_chunks: 1,
            context_length: 72,
            sources: [{ path: "docs/beta.md", chunk_index: 0, score: 0.88 }]
          }
        }),
        chatCompletion: async ({ onUsage }) => {
          onUsage?.({ prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 });
          return {
            assistantText: "beta answer",
            usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
            routing: null
          };
        }
      });

      assert.deepEqual(history.map((entry) => entry.role), ["user", "assistant"]);

      const transcriptPath = await saveTranscript({
        sessionId: "session-test",
        sessionStartedAt: new Date().toISOString(),
        history,
        latestRouting: null,
        sessionUsage
      });
      const transcriptContent = fs.readFileSync(transcriptPath, "utf8");
      assert.match(transcriptContent, /## USER/);
      assert.match(transcriptContent, /## ASSISTANT/);
      assert.doesNotMatch(transcriptContent, /Relevant Obsidian vault context/);
      assert.doesNotMatch(transcriptContent, /docs\/beta\.md#0/);
    });
  });
});

test("processPrompt warns and continues when vault retrieval fails", async () => {
  await withTempDir(async (tempDir) => {
    writeMinimalConfig(tempDir);
    const warnings = [];
    let capturedBody = null;

    await processPrompt({
      prompt: "ping",
      history: [],
      systemPrompt: "",
      sessionUsage: createSessionUsage(),
      estimatedTokensRef: { value: 0 },
      renderMode: "silent",
      statusRenderer: createStatusRenderer({ stream: { isTTY: false, write() {} } }),
      vaultContextBuilder: async () => {
        throw new Error("embedding backend unavailable");
      },
      onWarning: (message) => warnings.push(message),
      chatCompletion: async ({ body, onUsage }) => {
        capturedBody = body;
        onUsage?.({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        return {
          assistantText: "pong",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          routing: null
        };
      }
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /vault context unavailable/);
    assert.ok(capturedBody);
    assert.equal("context" in capturedBody, false);
    assert.equal(capturedBody.messages.at(-1).role, "user");
    assert.equal(capturedBody.messages.at(-1).content, "ping");
  });
});

test("MASSA_VAULT_CHAT_RAG=off disables automatic retrieval and /config reports disabled", async () => {
  const previousRag = process.env.MASSA_VAULT_CHAT_RAG;
  process.env.MASSA_VAULT_CHAT_RAG = "off";
  try {
    await withTempDir(async () => {
      writeMinimalConfig(process.cwd());
      let builderCalled = false;
      let capturedBody = null;

      await processPrompt({
        prompt: "hello",
        history: [],
        systemPrompt: "",
        sessionUsage: createSessionUsage(),
        estimatedTokensRef: { value: 0 },
        renderMode: "silent",
        statusRenderer: createStatusRenderer({ stream: { isTTY: false, write() {} } }),
        vaultContextBuilder: async () => {
          builderCalled = true;
          return {
            message: "should not be used",
            metadata: {
              source: "obsidian",
              retrieved_chunks: 1,
              context_length: 10,
              sources: []
            }
          };
        },
        chatCompletion: async ({ body, onUsage }) => {
          capturedBody = body;
          onUsage?.({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
          return {
            assistantText: "ok",
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            routing: null
          };
        }
      });

      assert.equal(builderCalled, false);
      assert.ok(capturedBody);
      assert.equal("context" in capturedBody, false);

      const state = createReplState({ systemPrompt: "" });
      const panels = [];
      const command = await executeCommand({
        line: "/config",
        state,
        limitsByModel: {},
        mode: "tui",
        handlers: {
          panel: (title, lines) => panels.push({ title, lines })
        }
      });
      assert.equal(command.handled, true);
      assert.equal(command.exit, false);
      assert.equal(panels.length, 1);
      assert.match(panels[0].lines.join("\n"), /vault_context: disabled/);
      assert.match(panels[0].lines.join("\n"), /vault_context_modes: semantic, manifest/);
    });
  } finally {
    if (previousRag === undefined) {
      delete process.env.MASSA_VAULT_CHAT_RAG;
    } else {
      process.env.MASSA_VAULT_CHAT_RAG = previousRag;
    }
  }
});

test("executeCommand /sync delegates to save+sync hook", async () => {
  const state = createReplState({ systemPrompt: "" });
  const messages = [];
  let calls = 0;

  const hook = async () => {
    calls += 1;
    return {
      saveResult: {
        path: "/tmp/transcript.md",
        saved: true
      },
      summary: "[chat] sync status=idle conflicts=0"
    };
  };

  const syncResult = await executeCommand({
    line: "/sync",
    state,
    limitsByModel: {},
    mode: "tui",
    handlers: {
      message: (text) => messages.push(text)
    },
    onSaveAndSync: hook
  });
  assert.equal(syncResult.handled, true);
  assert.equal(syncResult.exit, false);
  assert.equal(calls, 1);
  assert.match(messages.join("\n"), /transcript saved/i);
  assert.match(messages.join("\n"), /sync status=idle/i);
});

test("executeCommand treats /save and /help as unknown commands", async () => {
  const state = createReplState({ systemPrompt: "" });
  const messages = [];
  let calls = 0;

  const hook = async () => {
    calls += 1;
    return {
      saveResult: {
        path: "/tmp/transcript.md",
        saved: true
      },
      summary: "[chat] sync status=idle conflicts=0"
    };
  };

  const saveResult = await executeCommand({
    line: "/save",
    state,
    limitsByModel: {},
    mode: "tui",
    handlers: {
      message: (text) => messages.push(text)
    },
    onSaveAndSync: hook
  });
  const helpResult = await executeCommand({
    line: "/help",
    state,
    limitsByModel: {},
    mode: "tui",
    handlers: {
      message: (text) => messages.push(text)
    },
    onSaveAndSync: hook
  });

  assert.equal(saveResult.handled, true);
  assert.equal(helpResult.handled, true);
  assert.equal(calls, 0);
  assert.match(messages.join("\n"), /unknown command: \/save/i);
  assert.match(messages.join("\n"), /unknown command: \/help/i);
});

test("createStartupWarmup starts once, reuses promise, and sends hidden non-stream request", async () => {
  let calls = 0;
  let capturedBody = null;
  let resolveWarmup;
  const gate = new Promise((resolve) => {
    resolveWarmup = resolve;
  });
  const warmup = createStartupWarmup({
    chatCompletion: async ({ body }) => {
      calls += 1;
      capturedBody = body;
      await gate;
      return { assistantText: "", usage: null, routing: null };
    }
  });

  const first = warmup.start();
  const second = warmup.start();
  assert.equal(first, second);

  let settled = false;
  const waitPromise = warmup.wait().then(() => {
    settled = true;
  });
  await delay(10);
  assert.equal(settled, false);
  resolveWarmup();
  await waitPromise;

  assert.equal(calls, 1);
  assert.equal(capturedBody.model, "smart-router");
  assert.equal(capturedBody.stream, false);
  assert.deepEqual(capturedBody.messages, [{ role: "user", content: "warmup" }]);
});

test("createStartupWarmup connection failures are non-fatal and silent", async () => {
  const warnings = [];
  const error = new TypeError("fetch failed");
  const warmup = createStartupWarmup({
    chatCompletion: async () => {
      throw error;
    },
    onWarning: (message) => warnings.push(message)
  });

  warmup.start();
  const result = await warmup.wait();
  assert.equal(result.ok, false);
  assert.equal(result.error, error);
  assert.equal(warnings.length, 0);
});

test("createStartupWarmup non-connectivity failures still emit warning", async () => {
  const warnings = [];
  const warmup = createStartupWarmup({
    chatCompletion: async () => {
      throw new Error("invalid warmup request");
    },
    onWarning: (message) => warnings.push(message)
  });

  warmup.start();
  const result = await warmup.wait();
  assert.equal(result.ok, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /startup warmup failed/i);
  assert.match(warnings[0], /continuing without warmup/i);
});

test("first prompt still works after silent warmup fallback", async () => {
  await withTempDir(async (tempDir) => {
    writeMinimalConfig(tempDir);
    const warnings = [];
    const warmup = createStartupWarmup({
      chatCompletion: async () => {
        throw new TypeError("fetch failed");
      },
      onWarning: (message) => warnings.push(message)
    });

    warmup.start();
    const warmupResult = await warmup.wait();
    assert.equal(warmupResult.ok, false);
    assert.equal(warnings.length, 0);

    const history = [];
    const sessionUsage = createSessionUsage();
    const estimatedTokensRef = { value: 0 };
    const result = await processPrompt({
      prompt: "hello after warmup",
      history,
      systemPrompt: "",
      sessionUsage,
      estimatedTokensRef,
      renderMode: "silent",
      statusRenderer: createStatusRenderer({ stream: { isTTY: false, write() {} } }),
      vaultContextBuilder: async () => null,
      chatCompletion: async ({ onUsage }) => {
        onUsage?.({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
        return {
          assistantText: "ok",
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          routing: null
        };
      }
    });

    assert.equal(result.assistantText, "ok");
    assert.equal(history.at(-2)?.content, "hello after warmup");
    assert.equal(history.at(-1)?.role, "assistant");
  });
});

test("executeCommand /sync status in TUI returns sync-screen action without emitting panel/message", async () => {
  await withTempDir(async (tempDir) => {
    writeMinimalConfig(tempDir);
    const stateDir = path.join(tempDir, ".automation", "notes-automation");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify(
        {
          running: false,
          pid: null,
          paused: true,
          sync: {
            status: "paused",
            conflictCount: 0,
            lastError: "gdrive still failing",
            lastGDriveImportClassification: "suspicious",
            lastGDriveImportSummary: {
              changedCount: 21,
              addedCount: 5,
              modifiedCount: 11,
              deletedCount: 5
            },
            reviewNeeded: true
          },
          lastGDriveAutoResyncAttempted: true,
          lastGDriveAutoResyncApplied: false,
          lastGDriveResyncMode: "newer"
        },
        null,
        2
      ),
      "utf8"
    );

    const messages = [];
    const panels = [];
    const result = await executeCommand({
      line: "/sync status",
      state: createReplState({ systemPrompt: "" }),
      limitsByModel: {},
      mode: "tui",
      handlers: {
        message: (text) => messages.push(text),
        panel: (title, lines) => panels.push({ title, lines })
      }
    });

    assert.equal(result.handled, true);
    assert.equal(result.exit, false);
    assert.equal(messages.length, 0);
    assert.equal(panels.length, 0);
    assert.equal(result.action?.type, "switch-screen");
    assert.equal(result.action?.screen, "sync");
    assert.equal(Boolean(result.action?.syncStatus), true);
    assert.equal(result.action?.syncStatus?.status, "paused");
    assert.equal(result.action?.syncStatus?.backends?.drive?.hasError, true);
    assert.equal(result.action?.syncStatus?.backends?.drive?.autoResyncAttempted, true);
    assert.equal(result.action?.syncStatus?.backends?.drive?.autoResyncApplied, false);
  });
});

test("executeCommand /conv returns conversation-screen action in TUI", async () => {
  const result = await executeCommand({
    line: "/conv",
    state: createReplState({ systemPrompt: "" }),
    limitsByModel: {},
    mode: "tui",
    handlers: {}
  });

  assert.equal(result.handled, true);
  assert.equal(result.exit, false);
  assert.equal(result.action?.type, "switch-screen");
  assert.equal(result.action?.screen, "conversation");
});

test("executeCommand /sync status in plain mode preserves summary + JSON output", async () => {
  await withTempDir(async (tempDir) => {
    writeMinimalConfig(tempDir);
    const stateDir = path.join(tempDir, ".automation", "notes-automation");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify(
        {
          running: false,
          pid: null,
          paused: true,
          sync: {
            status: "paused",
            conflictCount: 0,
            lastError: "gdrive still failing"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map((value) => String(value)).join(" "));
    };
    try {
      const result = await executeCommand({
        line: "/sync status",
        state: createReplState({ systemPrompt: "" }),
        limitsByModel: {},
        mode: "plain"
      });
      assert.equal(result.handled, true);
      assert.equal(result.exit, false);
    } finally {
      console.log = originalLog;
    }

    assert.match(logs.join("\n"), /\[chat\] sync status=paused/i);
    assert.match(logs.join("\n"), /"sync"\s*:/i);
    assert.match(logs.join("\n"), /"status"\s*:\s*"paused"/i);
  });
});

test("processPrompt injects extra history context messages before latest user prompt", async () => {
  await withTempDir(async () => {
    writeMinimalConfig(process.cwd());
    const history = [{ role: "user", content: "previous" }];
    let capturedBody = null;

    await processPrompt({
      prompt: "current question",
      history,
      systemPrompt: "",
      sessionUsage: createSessionUsage(),
      estimatedTokensRef: { value: 0 },
      renderMode: "silent",
      statusRenderer: createStatusRenderer({ stream: { isTTY: false, write() {} } }),
      vaultContextBuilder: async () => null,
      extraContextMessages: [
        {
          role: "system",
          content: "Context from transcript AI Chats/2026-05-30/10-00-00--alpha.md:\n[USER]\nhello"
        }
      ],
      chatCompletion: async ({ body, onUsage }) => {
        capturedBody = body;
        onUsage?.({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
        return {
          assistantText: "done",
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          routing: null
        };
      }
    });

    assert.ok(capturedBody);
    const secondToLast = capturedBody.messages.at(-2);
    assert.equal(secondToLast.role, "system");
    assert.match(secondToLast.content, /Context from transcript/);
    assert.equal(capturedBody.messages.at(-1).role, "user");
    assert.equal(capturedBody.messages.at(-1).content, "current question");
    assert.equal(history.some((entry) => /Context from transcript/i.test(entry.content || "")), false);
  });
});

test("executeCommand /history and /history date build visible rows and keep transcript history clean", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const day = "2026-05-30";
    const chatsDir = path.join(vaultPath, "AI Chats", day);
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatsDir, "11-00-00--alpha.md"),
      "---\nid: \"alpha\"\n---\n\n## USER\nhello\n\n## ASSISTANT\nhi\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(chatsDir, "12-00-00--beta.md"),
      "---\nid: \"beta\"\n---\n\n## USER\nyo\n\n## ASSISTANT\nhey\n",
      "utf8"
    );

    await withEnvValue("VAULT_PATH", vaultPath, async () => {
      const state = createReplState({ systemPrompt: "" });
      const openResult = await executeCommand({
        line: "/history",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      assert.equal(openResult.handled, true);
      assert.equal(openResult.action?.screen, "history");
      assert.match(openResult.action?.historyPanel?.lines?.join("\n") || "", /history dates/i);
      assert.equal(state.history.length, 0);

      const dateResult = await executeCommand({
        line: "/history date 1",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      assert.equal(dateResult.handled, true);
      assert.equal(dateResult.action?.screen, "history");
      assert.equal(state.historySelectedDate, day);
      assert.equal(state.historyVisibleRows.length, 2);
      assert.equal(state.historyVisibleRows[0].fileName, "12-00-00--beta.md");
      assert.equal(state.history.length, 0);
    });
  });
});

test("executeCommand /history search scopes results to AI Chats files only", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    fs.writeFileSync(path.join(vaultPath, "General.md"), "# General\nalpha appears in regular vault note", "utf8");
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, "13-00-00--alpha-chat.md"),
      "# Chat\n\n## USER\nalpha from chat transcript",
      "utf8"
    );

    await withEnvValue("VAULT_PATH", vaultPath, async () => {
      const state = createReplState({ systemPrompt: "" });
      await withMockEmbeddings(async () => {
        const result = await executeCommand({
          line: "/history search alpha",
          state,
          limitsByModel: {},
          mode: "tui"
        });
        assert.equal(result.handled, true);
        assert.equal(result.action?.screen, "history");
        assert.equal(state.historyVisibleRows.length > 0, true);
        assert.equal(state.historyVisibleRows.every((row) => row.relativePath.startsWith("AI Chats/")), true);
        assert.equal(state.historyVisibleRows.some((row) => /General\.md/.test(row.relativePath)), false);
      });
    });
  });
});

test("executeCommand /history switch saves current session, loads selected transcript, and sets active path", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    const transcriptPath = path.join(chatDir, "14-00-00--switch-target.md");
    fs.writeFileSync(
      transcriptPath,
      [
        "---",
        "id: \"switch-session\"",
        "created_at: \"2026-05-30T14:00:00-03:00\"",
        "gateway_url: \"http://127.0.0.1:4100\"",
        "model: \"smart-router\"",
        "router_lane: \"general\"",
        "router_target_model: \"smart-router-general\"",
        "router_confidence: \"1.0000\"",
        "prompt_tokens: 7",
        "completion_tokens: 3",
        "total_tokens: 10",
        "---",
        "",
        "## USER",
        "",
        "loaded user",
        "",
        "## ASSISTANT",
        "",
        "loaded assistant",
        ""
      ].join("\n"),
      "utf8"
    );

    const state = createReplState({ systemPrompt: "" });
    state.history.push({ role: "user", content: "current" }, { role: "assistant", content: "chat" });
    state.historyVisibleRows = [
      {
        number: 1,
        transcriptPath,
        relativePath: "AI Chats/2026-05-30/14-00-00--switch-target.md",
        fileName: "14-00-00--switch-target.md",
        date: "2026-05-30",
        time: "14:00:00",
        title: "switch target",
        score: null,
        snippet: ""
      }
    ];

    let saveCalls = 0;
    const result = await executeCommand({
      line: "/history switch 1",
      state,
      limitsByModel: {},
      mode: "tui",
      onSaveAndSync: async () => {
        saveCalls += 1;
        return {
          saveResult: { path: "/tmp/current.md", saved: true },
          summary: "[chat] sync status=idle conflicts=0"
        };
      }
    });

    assert.equal(result.handled, true);
    assert.equal(result.action?.screen, "conversation");
    assert.equal(saveCalls, 1);
    assert.equal(state.history.length, 2);
    assert.equal(state.history[0].content, "loaded user");
    assert.equal(state.history[1].content, "loaded assistant");
    assert.equal(state.activeTranscript?.path, transcriptPath);
    assert.equal(state.transcriptSavedPath, transcriptPath);
    assert.equal(state.lastSavedHistoryLength, 2);
    assert.equal(state.sessionUsage.total_tokens, 10);
  });
});

test("executeCommand /history add_context queues transcript context without mutating state.history", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    const transcriptPath = path.join(chatDir, "15-00-00--context.md");
    fs.writeFileSync(
      transcriptPath,
      "---\nid: \"ctx\"\n---\n\n## USER\nhello\n\n## ASSISTANT\nworld\n",
      "utf8"
    );

    const state = createReplState({ systemPrompt: "" });
    state.history.push({ role: "user", content: "keep this" });
    state.historyVisibleRows = [
      {
        number: 1,
        transcriptPath,
        relativePath: "AI Chats/2026-05-30/15-00-00--context.md",
        fileName: "15-00-00--context.md",
        date: "2026-05-30",
        time: "15:00:00",
        title: "context",
        score: null,
        snippet: ""
      }
    ];

    const result = await executeCommand({
      line: "/history add_context 1",
      state,
      limitsByModel: {},
      mode: "tui"
    });
    assert.equal(result.handled, true);
    assert.equal(state.addedContextEntries.length, 1);
    assert.match(state.addedContextEntries[0].content, /Context from transcript/);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].content, "keep this");
  });
});
