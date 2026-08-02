import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStartupWarmup,
  createReplState,
  createStatusRenderer,
  executeCommand,
  processPrompt,
  saveTranscript
} from "../tools/llm-chat-cli/src/cli.js";
import { createSessionUsage } from "../tools/llm-chat-cli/src/domain/usage.js";
import { classifyRequest, loadPolicy } from "../tools/router-gateway/src/domain/classifier.js";
import {
  parseLiteLLMModelConfig,
  resolveModelRoute
} from "../tools/router-gateway/src/domain/model-resolution.js";
import {
  buildVaultContextPayload,
  buildVaultManifestPayload,
  combineVaultPayloads
} from "../tools/llm-chat-cli/src/domain/vault-context.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const ROUTER_POLICY_PATH = path.join(REPO_ROOT, "config", "router-gateway.json");
const MMT_LITELLM_CONFIG = `
model_list:
  - model_name: mmt_lm_studio_qwen_qwen3_5_9b
    litellm_params:
      model: openai/qwen/qwen3.5-9b
      api_base: http://127.0.0.1:1234/v1
      api_key: lm-studio
    model_info:
      model_manager_id: lm_studio
      model_manager_tool: lmstudio
      model_location: local

  - model_name: smart-router-general
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: mmt_lm_studio_qwen_qwen3_5_9b
          MEDIUM: mmt_lm_studio_qwen_qwen3_5_9b
          COMPLEX: mmt_lm_studio_qwen_qwen3_5_9b
          REASONING: mmt_lm_studio_qwen_qwen3_5_9b
      complexity_router_default_model: mmt_lm_studio_qwen_qwen3_5_9b

  - model_name: smart-router-code
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: mmt_lm_studio_qwen_qwen3_5_9b
          MEDIUM: mmt_lm_studio_qwen_qwen3_5_9b
          COMPLEX: mmt_lm_studio_qwen_qwen3_5_9b
          REASONING: mmt_lm_studio_qwen_qwen3_5_9b
      complexity_router_default_model: mmt_lm_studio_qwen_qwen3_5_9b
`;

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

function setHistoryConversationFlowState(state, { rows, dateRows }) {
  state.historyDateRows = Array.isArray(dateRows) ? dateRows : [];
  state.historySelectedDate = state.historyDateRows[0]?.date || null;
  state.historyVisibleRows = Array.isArray(rows) ? rows : [];
  state.historyFlowStack = [
    {
      screen: "dates",
      panel: {
        title: "History",
        lines: ["Dates (newest first)."],
        scrollable: false,
        previewMode: false
      }
    },
    {
      screen: "conversations",
      panel: {
        title: "History",
        lines: ["Conversations."],
        scrollable: false,
        previewMode: false
      }
    }
  ];
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

test("default builder skips vault context for low-signal greetings", async () => {
  await withTempDir(async (tempDir) => {
    const body = await captureProcessPromptBody({
      prompt: "Hi",
      tempDir
    });

    assert.equal(body.context, undefined);
    assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
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
      const command = await executeCommand({
        line: "/config",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      assert.equal(command.handled, true);
      assert.equal(command.exit, false);
      assert.equal(command.action?.screen, "panel");
      assert.match(command.action?.panelScreen?.lines?.join("\n") || "", /Vault context \| Disabled/i);
      assert.match(command.action?.panelScreen?.lines?.join("\n") || "", /Vault context modes \| semantic, manifest/i);
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

test("createStartupWarmup starts once, reuses promise, and waits only for primary warmup", async () => {
  let calls = 0;
  const capturedBodies = [];
  const routed = [];
  let resolveGeneralWarmup;
  let resolveCodeWarmup;
  const generalGate = new Promise((resolve) => {
    resolveGeneralWarmup = resolve;
  });
  const codeGate = new Promise((resolve) => {
    resolveCodeWarmup = resolve;
  });
  const warmup = createStartupWarmup({
    chatCompletion: async ({ body }) => {
      calls += 1;
      capturedBodies.push(body);
      const prompt = body?.messages?.[0]?.content;
      if (prompt === "Summarize today priorities.") {
        await generalGate;
        return {
          assistantText: "",
          usage: null,
          routing: {
            targetModel: "smart-router-general",
            routedModel: "general_local",
            displayModel: "qwen3.5:9b",
            modelLocation: "local"
          }
        };
      }
      await codeGate;
      return {
        assistantText: "",
        usage: null,
        routing: {
          targetModel: "smart-router-code",
          routedModel: "code_local",
          displayModel: "qwen2.5-coder:7b",
          modelLocation: "local"
        }
      };
    },
    onPrimaryRouting: (routing) => routed.push(routing)
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
  resolveGeneralWarmup();
  await delay(10);
  assert.equal(settled, true);

  let aggregateSettled = false;
  const aggregatePromise = first.then(() => {
    aggregateSettled = true;
  });
  await waitPromise;
  assert.equal(aggregateSettled, false);
  resolveCodeWarmup();
  await aggregatePromise;

  assert.equal(calls, 2);
  assert.deepEqual(routed, [
    {
      targetModel: "smart-router-general",
      routedModel: "general_local",
      displayModel: "qwen3.5:9b",
      modelLocation: "local"
    }
  ]);
  assert.deepEqual(
    capturedBodies.map((body) => body.model),
    Array.from({ length: 2 }, () => "smart-router")
  );
  assert.deepEqual(
    capturedBodies.map((body) => body.stream),
    Array.from({ length: 2 }, () => false)
  );
  assert.deepEqual(
    capturedBodies.map((body) => body.max_tokens),
    Array.from({ length: 2 }, () => 1)
  );
  assert.deepEqual(capturedBodies[0].messages, [
    { role: "user", content: "Summarize today priorities." }
  ]);
  assert.deepEqual(capturedBodies[1].messages, [
    { role: "user", content: "debug typescript stacktrace" }
  ]);
});

test("createStartupWarmup prompts resolve to active router lanes and concrete models", async () => {
  const capturedBodies = [];
  const warmup = createStartupWarmup({
    chatCompletion: async ({ body }) => {
      capturedBodies.push(body);
      return { assistantText: "", usage: null, routing: null };
    }
  });

  const result = await warmup.start();
  assert.equal(result.ok, true);

  const policy = loadPolicy(ROUTER_POLICY_PATH);
  const models = parseLiteLLMModelConfig(MMT_LITELLM_CONFIG);
  const resolutions = capturedBodies.map((body) => {
    const routing = classifyRequest(body, policy);
    const resolved = resolveModelRoute({
      targetModel: routing.targetModel,
      body,
      models
    });
    return {
      targetModel: routing.targetModel,
      routedModel: resolved.routedModel
    };
  });

  assert.deepEqual(resolutions, [
    { targetModel: "smart-router-general", routedModel: "mmt_lm_studio_qwen_qwen3_5_9b" },
    { targetModel: "smart-router-code", routedModel: "mmt_lm_studio_qwen_qwen3_5_9b" }
  ]);
});

test("createStartupWarmup ignores optional background warmup failures", async () => {
  const warnings = [];
  const warmup = createStartupWarmup({
    chatCompletion: async ({ body }) => {
      const prompt = body?.messages?.[0]?.content;
      if (prompt === "debug typescript stacktrace") {
        throw new Error("code warmup backend offline");
      }
      return { assistantText: "", usage: null, routing: null };
    },
    onWarning: (message) => warnings.push(message)
  });

  const result = await warmup.start();
  const codeWarmupResult = result.results.find((entry) => entry.name === "code-simple");

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.results.length, 2);
  assert.equal(codeWarmupResult?.name, "code-simple");
  assert.equal(codeWarmupResult?.ok, false);
  assert.equal(codeWarmupResult?.required, false);
  assert.match(String(codeWarmupResult?.error?.message || ""), /backend offline/i);
  assert.equal(warnings.length, 0);
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
  assert.equal(result.results.length, 1);
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
  assert.equal(result.results.length, 1);
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
      assert.match(openResult.action?.historyPanel?.lines?.join("\n") || "", /Dates \(newest first\)\./i);
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
      assert.equal(state.historyFlowStack.at(-1)?.screen, "conversations");
    });
  });
});

test("executeCommand history date screen accepts bare row number shortcut", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const day = "2026-05-30";
    const chatsDir = path.join(vaultPath, "AI Chats", day);
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, "10-00-00--one.md"), "## USER\none\n", "utf8");

    await withEnvValue("VAULT_PATH", vaultPath, async () => {
      const state = createReplState({ systemPrompt: "" });
      await executeCommand({
        line: "/history",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      const result = await executeCommand({
        line: "1",
        state,
        limitsByModel: {},
        mode: "tui"
      });

      assert.equal(result.handled, true);
      assert.equal(result.action?.screen, "history");
      assert.equal(state.historySelectedDate, day);
      assert.equal(state.historyVisibleRows.length, 1);
      assert.equal(state.historyFlowStack.at(-1)?.screen, "conversations");
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

test("executeCommand blocks history selection commands outside conversations screen", async () => {
  const state = createReplState({ systemPrompt: "" });
  state.history.push({ role: "user", content: "keep" });
  state.historyVisibleRows = [
    {
      number: 1,
      transcriptPath: "/tmp/fake.md",
      relativePath: "AI Chats/2026-05-30/fake.md",
      fileName: "fake.md",
      date: "2026-05-30",
      time: "10:00:00",
      title: "fake",
      score: null,
      snippet: ""
    }
  ];

  for (const line of [
    "/history switch 1",
    "/history add_context 1",
    "/history summary 1",
    "/history preview 1"
  ]) {
    const messages = [];
    const result = await executeCommand({
      line,
      state,
      limitsByModel: {},
      mode: "tui",
      handlers: {
        message: (text) => messages.push(text)
      }
    });
    assert.equal(result.handled, true);
    assert.equal(messages.some((entry) => /only in History conversations screen/i.test(entry)), true);
  }

  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].content, "keep");
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
    const historyRows = [
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
    setHistoryConversationFlowState(state, {
      rows: historyRows,
      dateRows: [{ number: 1, date: "2026-05-30", count: 1 }]
    });

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
    assert.equal(state.activeTranscript?.routing?.targetModel, "smart-router-general");
    assert.equal(state.latestRouting, null);
    assert.equal(state.transcriptSavedPath, transcriptPath);
    assert.equal(state.lastSavedHistoryLength, 2);
    assert.equal(state.sessionUsage.total_tokens, 10);
  });
});

test("executeCommand /history switch preserves initialized concrete routing when transcript metadata is incomplete", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    const transcriptPath = path.join(chatDir, "14-15-00--old-routing.md");
    fs.writeFileSync(
      transcriptPath,
      [
        "---",
        "id: \"old-routing\"",
        "created_at: \"2026-05-30T14:15:00-03:00\"",
        "gateway_url: \"http://127.0.0.1:4100\"",
        "model: \"smart-router\"",
        "router_lane: \"general\"",
        "router_target_model: \"smart-router-general\"",
        "router_confidence: \"1.0000\"",
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
    state.latestRouting = {
      lane: "code",
      confidence: "0.9500",
      targetModel: "smart-router-code",
      routedModel: "code_local",
      providerModel: "ollama_chat/qwen2.5-coder:7b",
      displayModel: "qwen2.5-coder:7b",
      modelLocation: "local",
      responseModel: "ollama_chat/qwen2.5-coder:7b"
    };
    const previousRouting = { ...state.latestRouting };
    setHistoryConversationFlowState(state, {
      rows: [
        {
          number: 1,
          transcriptPath,
          relativePath: "AI Chats/2026-05-30/14-15-00--old-routing.md",
          fileName: "14-15-00--old-routing.md",
          date: "2026-05-30",
          time: "14:15:00",
          title: "old routing",
          score: null,
          snippet: ""
        }
      ],
      dateRows: [{ number: 1, date: "2026-05-30", count: 1 }]
    });

    const result = await executeCommand({
      line: "/history switch 1",
      state,
      limitsByModel: {},
      mode: "tui",
      onSaveAndSync: async () => ({
        saveResult: { path: "/tmp/current.md", saved: true },
        summary: "[chat] sync status=idle conflicts=0"
      })
    });

    assert.equal(result.handled, true);
    assert.equal(state.activeTranscript?.routing?.targetModel, "smart-router-general");
    assert.deepEqual(state.latestRouting, previousRouting);
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
    const historyRows = [
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
    setHistoryConversationFlowState(state, {
      rows: historyRows,
      dateRows: [{ number: 1, date: "2026-05-30", count: 1 }]
    });

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

test("executeCommand /history summary uses injected LLM runner and keeps transcript history unchanged", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    const transcriptPath = path.join(chatDir, "16-00-00--summary.md");
    fs.writeFileSync(
      transcriptPath,
      "---\nid: \"summary\"\n---\n\n## USER\nNeed rollout plan\n\n## ASSISTANT\nShip in phases.\n",
      "utf8"
    );

    const state = createReplState({ systemPrompt: "" });
    state.history.push({ role: "user", content: "keep conversation" });
    const historyRows = [
      {
        number: 1,
        transcriptPath,
        relativePath: "AI Chats/2026-05-30/16-00-00--summary.md",
        fileName: "16-00-00--summary.md",
        date: "2026-05-30",
        time: "16:00:00",
        title: "summary",
        score: null,
        snippet: ""
      }
    ];
    setHistoryConversationFlowState(state, {
      rows: historyRows,
      dateRows: [{ number: 1, date: "2026-05-30", count: 1 }]
    });

    let summaryCalls = 0;
    let capturedMarkdown = "";
    const result = await executeCommand({
      line: "/history summary 1",
      state,
      limitsByModel: {},
      mode: "tui",
      historySummaryRunner: async ({ transcriptMarkdown }) => {
        summaryCalls += 1;
        capturedMarkdown = String(transcriptMarkdown || "");
        return {
          summary: "User asked for rollout plan. Assistant suggested phased delivery.",
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          routing: {
            lane: "general",
            confidence: "1.0000",
            targetModel: "smart-router-general",
            routedModel: "general_local",
            providerModel: "ollama_chat/qwen3.5:9b",
            displayModel: "qwen3.5:9b",
            modelLocation: "local",
            responseModel: "ollama_chat/qwen3.5:9b"
          }
        };
      }
    });

    assert.equal(result.handled, true);
    assert.equal(result.action?.screen, "history");
    assert.equal(result.action?.historyPanel?.renderMarkdown, true);
    assert.equal(result.action?.historyPanel?.title, "History summary");
    assert.match(result.action?.historyPanel?.lines?.join("\n") || "", /User asked for rollout plan\./);
    assert.match(capturedMarkdown, /## USER/);
    assert.equal(summaryCalls, 1);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].content, "keep conversation");
    assert.equal(state.sessionUsage.total_tokens, 3);
    assert.equal(state.latestRouting?.displayModel, "qwen3.5:9b");
    assert.equal(state.latestRouting?.modelLocation, "local");
  });
});

test("executeCommand /history preview returns scrollable markdown preview and keeps transcript history unchanged", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    const transcriptPath = path.join(chatDir, "17-00-00--preview.md");
    fs.writeFileSync(
      transcriptPath,
      "---\nid: \"preview\"\n---\n\n## USER\nhello\n\n## ASSISTANT\nworld\n",
      "utf8"
    );

    const state = createReplState({ systemPrompt: "" });
    state.history.push({ role: "assistant", content: "keep chat" });
    const historyRows = [
      {
        number: 1,
        transcriptPath,
        relativePath: "AI Chats/2026-05-30/17-00-00--preview.md",
        fileName: "17-00-00--preview.md",
        date: "2026-05-30",
        time: "17:00:00",
        title: "preview",
        score: null,
        snippet: ""
      }
    ];
    setHistoryConversationFlowState(state, {
      rows: historyRows,
      dateRows: [{ number: 1, date: "2026-05-30", count: 1 }]
    });

    const result = await executeCommand({
      line: "/history preview 1",
      state,
      limitsByModel: {},
      mode: "tui"
    });

    const panelText = result.action?.historyPanel?.lines?.join("\n") || "";
    assert.equal(result.handled, true);
    assert.equal(result.action?.screen, "history");
    assert.equal(result.action?.historyPanel?.scrollable, true);
    assert.equal(result.action?.historyPanel?.previewMode, true);
    assert.match(panelText, /```markdown/);
    assert.match(panelText, /## USER/);
    assert.match(panelText, /## ASSISTANT/);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].content, "keep chat");
  });
});

test("executeCommand history conversation aliases route to full commands", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    const transcriptPath = path.join(chatDir, "18-00-00--alias.md");
    fs.writeFileSync(
      transcriptPath,
      "---\nid: \"alias\"\n---\n\n## USER\nalias-user\n\n## ASSISTANT\nalias-assistant\n",
      "utf8"
    );

    const state = createReplState({ systemPrompt: "" });
    const historyRows = [
      {
        number: 1,
        transcriptPath,
        relativePath: "AI Chats/2026-05-30/18-00-00--alias.md",
        fileName: "18-00-00--alias.md",
        date: "2026-05-30",
        time: "18:00:00",
        title: "alias",
        score: null,
        snippet: ""
      }
    ];
    setHistoryConversationFlowState(state, {
      rows: historyRows,
      dateRows: [{ number: 1, date: "2026-05-30", count: 1 }]
    });

    const addContextResult = await executeCommand({
      line: "/add_context 1",
      state,
      limitsByModel: {},
      mode: "tui"
    });
    assert.equal(addContextResult.handled, true);
    assert.equal(state.addedContextEntries.length, 1);

    const summaryResult = await executeCommand({
      line: "/summary 1",
      state,
      limitsByModel: {},
      mode: "tui",
      historySummaryRunner: async () => ({
        summary: "Alias summary output.",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        routing: { targetModel: "smart-router-general" }
      })
    });
    assert.equal(summaryResult.handled, true);
    assert.match(summaryResult.action?.historyPanel?.lines?.join("\n") || "", /Alias summary output\./);

    const backResult = await executeCommand({
      line: "/back",
      state,
      limitsByModel: {},
      mode: "tui"
    });
    assert.equal(backResult.handled, true);
    assert.match(backResult.action?.historyPanel?.lines?.join("\n") || "", /Conversations/i);

    const previewResult = await executeCommand({
      line: "/preview 1",
      state,
      limitsByModel: {},
      mode: "tui"
    });
    assert.equal(previewResult.handled, true);
    assert.equal(previewResult.action?.historyPanel?.scrollable, true);
  });
});

test("executeCommand /back follows history stack and exits to conversation", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const day = "2026-05-30";
    const chatsDir = path.join(vaultPath, "AI Chats", day);
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatsDir, "19-00-00--back.md"),
      "---\nid: \"back\"\n---\n\n## USER\nhi\n\n## ASSISTANT\nthere\n",
      "utf8"
    );

    await withEnvValue("VAULT_PATH", vaultPath, async () => {
      const state = createReplState({ systemPrompt: "" });

      await executeCommand({
        line: "/history",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      await executeCommand({
        line: "/history date 1",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      await executeCommand({
        line: "/history summary 1",
        state,
        limitsByModel: {},
        mode: "tui",
        historySummaryRunner: async () => ({
          summary: "Back test summary.",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          routing: null
        })
      });

      const backToConversations = await executeCommand({
        line: "/back",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      assert.equal(backToConversations.handled, true);
      assert.match(
        backToConversations.action?.historyPanel?.lines?.join("\n") || "",
        /Conversations for 2026-05-30/i
      );

      const backToDates = await executeCommand({
        line: "/back",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      assert.equal(backToDates.handled, true);
      assert.match(backToDates.action?.historyPanel?.lines?.join("\n") || "", /Dates \(newest first\)\./i);

      const backToConversation = await executeCommand({
        line: "/back",
        state,
        limitsByModel: {},
        mode: "tui"
      });
      assert.equal(backToConversation.handled, true);
      assert.equal(backToConversation.action?.screen, "conversation");
      assert.equal(state.historyFlowStack.length, 0);
    });
  });
});

test("executeCommand /back exits sync and info screens to conversation", async () => {
  const state = createReplState({ systemPrompt: "" });

  state.activeScreen = "sync";
  const syncBack = await executeCommand({
    line: "/back",
    state,
    limitsByModel: {},
    mode: "tui"
  });
  assert.equal(syncBack.handled, true);
  assert.equal(syncBack.action?.screen, "conversation");

  state.activeScreen = "panel";
  const panelBack = await executeCommand({
    line: "/back",
    state,
    limitsByModel: {},
    mode: "tui"
  });
  assert.equal(panelBack.handled, true);
  assert.equal(panelBack.action?.screen, "conversation");
});

test("executeCommand allows aliases and full selectors in history search conversations list", async () => {
  await withTempDir(async (tempDir) => {
    const vaultPath = writeMinimalConfig(tempDir);
    const chatDir = path.join(vaultPath, "AI Chats", "2026-05-30");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.writeFileSync(
      path.join(chatDir, "20-00-00--search.md"),
      "# Chat\n\n## USER\nsearch alpha\n\n## ASSISTANT\nsearch beta\n",
      "utf8"
    );

    await withEnvValue("VAULT_PATH", vaultPath, async () => {
      const state = createReplState({ systemPrompt: "" });
      await withMockEmbeddings(async () => {
        const openSearch = await executeCommand({
          line: "/history search alpha",
          state,
          limitsByModel: {},
          mode: "tui"
        });
        assert.equal(openSearch.handled, true);
        assert.equal(state.historyFlowStack.at(-1)?.screen, "conversations");

        const summaryAlias = await executeCommand({
          line: "/summary 1",
          state,
          limitsByModel: {},
          mode: "tui",
          historySummaryRunner: async () => ({
            summary: "Search alias summary.",
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            routing: null
          })
        });
        assert.equal(summaryAlias.handled, true);
        assert.match(summaryAlias.action?.historyPanel?.lines?.join("\n") || "", /Search alias summary\./);

        await executeCommand({
          line: "/back",
          state,
          limitsByModel: {},
          mode: "tui"
        });

        const previewFull = await executeCommand({
          line: "/history preview 1",
          state,
          limitsByModel: {},
          mode: "tui"
        });
        assert.equal(previewFull.handled, true);
        assert.equal(previewFull.action?.historyPanel?.previewMode, true);
      });
    });
  });
});

// --- TST-20: vault-context truncation (small injected maxChars) ------------

test("buildVaultManifestPayload truncates when the file list exceeds maxChars", () => {
  const paths = Array.from({ length: 20 }, (_, i) => `note-${i}.md`);
  const maxChars = 80;

  const payload = buildVaultManifestPayload(paths, { maxChars });

  assert.equal(payload.metadata.truncated, true);
  assert.ok(payload.message.length <= maxChars);
  assert.equal(payload.metadata.total_files, 20);
  assert.ok(payload.metadata.retrieved_files < 20);
  assert.equal(payload.metadata.sources.length, payload.metadata.retrieved_files);
});

test("buildVaultManifestPayload does not truncate when everything fits", () => {
  const payload = buildVaultManifestPayload(["a.md", "b.md"], { maxChars: 6000 });
  assert.equal(payload.metadata.truncated, false);
  assert.equal(payload.metadata.retrieved_files, 2);
  assert.equal(payload.metadata.total_files, 2);
});

test("buildVaultContextPayload truncates a chunk that partially fits (remainingChars >= 32) and stays under maxChars", () => {
  const maxChars = 120;
  const items = [
    { filePath: "a.md", text: "x".repeat(30), chunkIndex: 0, score: 0.9 },
    { filePath: "b.md", text: "y".repeat(200), chunkIndex: 0, score: 0.8 }
  ];

  const payload = buildVaultContextPayload(items, { maxChars });

  assert.equal(payload.metadata.truncated, true);
  assert.ok(payload.message.length <= maxChars);
  assert.equal(payload.metadata.retrieved_chunks, 2);
  assert.match(payload.message, /y+$/);
});

test("buildVaultContextPayload's remainingChars < 32 guard drops the next chunk without truncating on the boundary" , () => {
  // Regression-locking test for the guard at vault-context.js:171. With one
  // chunk already appended, the second chunk leaves only a few characters of
  // budget (< 32), so the loop performs a bare `break` instead of slicing the
  // chunk in. Message stays within maxChars either way, but note that this
  // exact branch does NOT set `truncated = true` before breaking -- unlike
  // its sibling branch a few lines above (remainingChars <= 0) and unlike the
  // partial-slice branch just below it. That means content genuinely gets
  // dropped here while `truncated` can still read `false`. This is existing
  // production behavior (tools/llm-chat-cli/src/domain/vault-context.js:171)
  // and is pinned here as a known gap, not asserted as "correct" -- see the
  // audit finding TST-20 and the builder report for this slice.
  const maxChars = 70;
  const items = [
    { filePath: "a.md", text: "x".repeat(10), chunkIndex: 0, score: 0.9 },
    { filePath: "b.md", text: "y".repeat(200), chunkIndex: 0, score: 0.8 }
  ];

  const payload = buildVaultContextPayload(items, { maxChars });

  assert.ok(payload.message.length <= maxChars);
  assert.equal(payload.metadata.retrieved_chunks, 1);
  assert.equal(payload.metadata.sources[0].path, "a.md");
  // Pinned current (buggy) behavior: the dropped second chunk is not
  // reflected in `truncated`. If this guard starts setting `truncated = true`
  // (a legitimate fix), this assertion is the one to flip.
  assert.equal(payload.metadata.truncated, false);
});

test("buildVaultContextPayload returns the empty-context default when nothing fits", () => {
  const payload = buildVaultContextPayload([], { maxChars: 6000 });
  assert.equal(payload.metadata.truncated, false);
  assert.equal(payload.metadata.retrieved_chunks, 0);
  assert.match(payload.message, /No relevant Obsidian vault chunks/);
});

test("combineVaultPayloads slices the joined message down to maxChars and marks it truncated", () => {
  const manifestPayload = buildVaultManifestPayload(["a.md", "b.md"], { maxChars: 1000 });
  const semanticPayload = buildVaultContextPayload(
    [{ filePath: "c.md", text: "z".repeat(50), chunkIndex: 0, score: 0.5 }],
    { maxChars: 1000 }
  );
  assert.equal(manifestPayload.metadata.truncated, false);
  assert.equal(semanticPayload.metadata.truncated, false);

  const maxChars = 40;
  const combined = combineVaultPayloads(manifestPayload, semanticPayload, { maxChars });

  assert.equal(combined.metadata.truncated, true);
  assert.equal(combined.message.length, maxChars);
  assert.equal(combined.metadata.mode, "hybrid");
  assert.equal(
    combined.metadata.sources.length,
    manifestPayload.metadata.sources.length + semanticPayload.metadata.sources.length
  );
});

test("combineVaultPayloads preserves truncated=true inherited from either input even when the join fits", () => {
  const manifestPayload = buildVaultManifestPayload(
    Array.from({ length: 20 }, (_, i) => `note-${i}.md`),
    { maxChars: 80 }
  );
  assert.equal(manifestPayload.metadata.truncated, true);

  const semanticPayload = buildVaultContextPayload([], { maxChars: 6000 });
  const combined = combineVaultPayloads(manifestPayload, semanticPayload, { maxChars: 6000 });

  assert.equal(combined.metadata.truncated, true);
  assert.ok(combined.message.length <= 6000);
});
