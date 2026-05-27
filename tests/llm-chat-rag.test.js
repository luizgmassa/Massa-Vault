import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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

test("executeCommand /save and /sync delegate to save+sync hook", async () => {
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
  assert.equal(saveResult.handled, true);
  assert.equal(saveResult.exit, false);

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
  assert.equal(calls, 2);
  assert.match(messages.join("\n"), /transcript saved/i);
  assert.match(messages.join("\n"), /sync status=idle/i);
});
