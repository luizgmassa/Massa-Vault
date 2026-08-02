import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GENERATED_LITELLM_CONFIG_PATH,
  MODEL_MANAGER_STATE_PATH,
  addModelManager,
  createDefaultModelManagerState,
  discoverModelManagerModels,
  editModelManager,
  fetchLiteLLMActiveAliases,
  generateLiteLLMConfigFromModelManagerState,
  getActivePinnedModel,
  markActiveAliases,
  pinModelAlias,
  readModelManagerState,
  removeModelManager,
  resolveLiteLLMConfigPath,
  sanitizeModelAlias,
  selectModelManager,
  setModelAutoMode,
  verifyDiscoveredModelManagerModels,
  writeGeneratedLiteLLMConfig,
  writeModelManagerState
} from "../tools/shared/model-managers.js";
import {
  parseLiteLLMModelConfig,
  resolveModelRoute
} from "../tools/router-gateway/src/domain/model-resolution.js";
import {
  formatModelScreenLines,
  routingFromPinnedModelState
} from "../tools/llm-chat-cli/src/services/model-manager.js";

function withTempCwd(fn) {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmt-"));
  process.chdir(tempDir);
  try {
    return fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("MMT alias sanitizer keeps LiteLLM aliases stable", () => {
  assert.equal(sanitizeModelAlias("Qwen 3.5:9B"), "qwen_3_5_9b");
  assert.equal(sanitizeModelAlias("123 model"), "m_123_model");
  assert.equal(sanitizeModelAlias("áé model"), "ae_model");
});

test("MMT model screen uses selected wording and explicit select hints", () => {
  const state = {
    verifiedModels: [
      {
        alias: "mmt_ollama_qwen3_5_9b",
        managerId: "ollama",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        providerModel: "ollama_chat/qwen3.5:9b",
        location: "local",
        status: "active"
      }
    ],
    preferences: { mode: "pin", pinnedAlias: "mmt_ollama_qwen3_5_9b" },
    restartRequired: false
  };

  const lines = formatModelScreenLines(state);
  assert.match(lines.join("\n"), /\| # \| Alias \| Model \| Location \| Via \| Status \| Selected \|/);
  assert.match(lines.join("\n"), /\/model select <row\|alias>/);
  assert.doesNotMatch(lines.join("\n"), /Pinned/);

  const routing = routingFromPinnedModelState(state);
  assert.equal(routing.displayModel, "qwen3.5:9b");
  assert.equal(routing.modelLocation, "local");
  assert.equal(routing.modelManagerTool, "ollama");
});

test("MMT generated config is strict and uses local auto tiers", () => {
  const state = {
    managers: [
      { id: "ollama", tool: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true },
      { id: "studio", tool: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", enabled: true }
    ],
    verifiedModels: [
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        alias: "mmt_ollama_qwen3_5_9b",
        providerModel: "ollama_chat/qwen3.5:9b",
        apiBase: "http://127.0.0.1:11434",
        location: "local",
        status: "active"
      },
      {
        managerId: "studio",
        managerTool: "lmstudio",
        name: "local-llama",
        alias: "mmt_studio_local_llama",
        providerModel: "openai/local-llama",
        apiBase: "http://127.0.0.1:1234/v1",
        location: "local",
        status: "active"
      }
    ],
    preferences: { mode: "auto", pinnedAlias: null, defaultAlias: null }
  };

  const generated = generateLiteLLMConfigFromModelManagerState(state);
  assert.match(generated.yaml, /model_name: mmt_ollama_qwen3_5_9b/);
  assert.match(generated.yaml, /model_manager_tool: "ollama"/);
  assert.match(generated.yaml, /model_name: mmt_studio_local_llama/);
  assert.match(generated.yaml, /model_manager_tool: "lmstudio"/);
  assert.match(generated.yaml, /model_name: smart-router-general/);
  assert.match(generated.yaml, /MEDIUM: mmt_ollama_qwen3_5_9b/);
  assert.doesNotMatch(generated.yaml, /\.litellm\/litellm-config\.yaml/);

  const parsed = parseLiteLLMModelConfig(generated.yaml);
  assert.equal(parsed.mmt_ollama_qwen3_5_9b.providerModel, "ollama_chat/qwen3.5:9b");
  assert.equal(parsed.mmt_ollama_qwen3_5_9b.modelManagerTool, "ollama");
  assert.equal(parsed["smart-router-general"].complexity.tiers.MEDIUM, "mmt_ollama_qwen3_5_9b");
});

test("MMT generated config gives LM Studio local OpenAI routes an api key", () => {
  const lmStudioGenerated = generateLiteLLMConfigFromModelManagerState({
    managers: [
      { id: "studio", tool: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", enabled: true }
    ],
    verifiedModels: [
      {
        managerId: "studio",
        managerTool: "lmstudio",
        name: "local-llama",
        providerModel: "openai/local-llama",
        apiBase: "http://127.0.0.1:1234/v1",
        location: "local",
        status: "active"
      }
    ]
  });

  assert.match(
    lmStudioGenerated.yaml,
    /model_name: mmt_studio_local_llama[\s\S]*api_base: "http:\/\/127\.0\.0\.1:1234\/v1"[\s\S]*api_key: "lm-studio"/
  );

  const ollamaGenerated = generateLiteLLMConfigFromModelManagerState({
    managers: [
      { id: "ollama", tool: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }
    ],
    verifiedModels: [
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        providerModel: "ollama_chat/qwen3.5:9b",
        apiBase: "http://127.0.0.1:11434",
        location: "local",
        status: "active"
      }
    ]
  });

  assert.doesNotMatch(ollamaGenerated.yaml, /api_key:/);
});

test("MMT generated config skips failed smoke and embedding-only models", () => {
  const generated = generateLiteLLMConfigFromModelManagerState({
    managers: [
      { id: "studio", tool: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", enabled: true }
    ],
    discoveredModels: [
      {
        managerId: "studio",
        managerTool: "lmstudio",
        name: "qwen/qwen3.6-27b",
        status: "error",
        error: "LM Studio smoke failed (400)"
      }
    ],
    verifiedModels: [
      {
        managerId: "studio",
        managerTool: "lmstudio",
        name: "qwen/qwen3.6-27b",
        providerModel: "openai/qwen/qwen3.6-27b",
        apiBase: "http://127.0.0.1:1234/v1",
        location: "local",
        status: "active"
      },
      {
        managerId: "studio",
        managerTool: "lmstudio",
        name: "text-embedding-nomic-embed-text-v1.5",
        providerModel: "openai/text-embedding-nomic-embed-text-v1.5",
        apiBase: "http://127.0.0.1:1234/v1",
        location: "local",
        status: "active"
      },
      {
        managerId: "studio",
        managerTool: "lmstudio",
        name: "qwen/qwen3.5-9b",
        providerModel: "openai/qwen/qwen3.5-9b",
        apiBase: "http://127.0.0.1:1234/v1",
        location: "local",
        status: "active"
      }
    ]
  });

  assert.doesNotMatch(generated.yaml, /model_name: mmt_studio_qwen_qwen3_6_27b/);
  assert.doesNotMatch(generated.yaml, /model_name: mmt_studio_text_embedding_nomic_embed_text_v1_5/);
  assert.match(generated.yaml, /model_name: mmt_studio_qwen_qwen3_5_9b/);
  assert.match(generated.yaml, /MEDIUM: mmt_studio_qwen_qwen3_5_9b/);
});

test("MMT generated config treats dash-cloud model tags as cloud", () => {
  const generated = generateLiteLLMConfigFromModelManagerState({
    managers: [
      { id: "ollama", tool: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true },
      { id: "studio", tool: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", enabled: true }
    ],
    verifiedModels: [
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "gpt-oss:120b-cloud",
        providerModel: "ollama_chat/gpt-oss:120b-cloud",
        apiBase: "http://127.0.0.1:11434",
        location: "local",
        status: "active"
      },
      {
        managerId: "studio",
        managerTool: "lmstudio",
        name: "qwen/qwen3.5-9b",
        providerModel: "openai/qwen/qwen3.5-9b",
        apiBase: "http://127.0.0.1:1234/v1",
        location: "local",
        status: "active"
      }
    ]
  });

  assert.match(
    generated.yaml,
    /model_name: mmt_ollama_gpt_oss_120b_cloud[\s\S]*model_location: "cloud"/
  );
  assert.match(generated.yaml, /MEDIUM: mmt_studio_qwen_qwen3_5_9b/);
});

test("MMT discovery creates candidates and smoke validation promotes verified models", async () => {
  const state = addModelManager({}, { tool: "ollama", name: "ollama" });
  const discoveredResult = await discoverModelManagerModels(state, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3.5:9b", capabilities: ["completion"] }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });
  assert.equal(discoveredResult.discovered[0].status, "candidate");
  assert.deepEqual(discoveredResult.discovered[0].capabilities, ["completion"]);
  assert.equal(discoveredResult.state.verifiedModels.length, 0);
  assert.equal(generateLiteLLMConfigFromModelManagerState(discoveredResult.state).yaml, "");

  const smokeCalls = [];
  const verifiedResult = await verifyDiscoveredModelManagerModels(discoveredResult.state, {
    fetchImpl: async (url, init) => {
      smokeCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ message: { content: "ok" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(verifiedResult.verified[0].status, "verified");
  assert.equal(verifiedResult.state.verifiedModels[0].alias, "mmt_ollama_qwen3_5_9b");
  assert.equal(smokeCalls[0].body.model, "qwen3.5:9b");
  assert.match(
    generateLiteLLMConfigFromModelManagerState(verifiedResult.state).yaml,
    /model_name: mmt_ollama_qwen3_5_9b/
  );
});

test("MMT smoke validation skips non-chat and expected unavailable models", async () => {
  const base = addModelManager({}, { tool: "ollama", name: "ollama" });
  const state = {
    ...base,
    discoveredModels: [
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "embeddinggemma:latest",
        capabilities: ["embedding"],
        status: "candidate"
      },
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "deepseek-v4-flash:cloud",
        capabilities: ["completion"],
        status: "candidate"
      },
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "qwen3.6:27b",
        capabilities: ["completion"],
        status: "error",
        error: "previous smoke failed"
      },
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        capabilities: ["completion"],
        status: "candidate"
      }
    ]
  };

  const smokeCalls = [];
  const result = await verifyDiscoveredModelManagerModels(state, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      smokeCalls.push(body.model);
      if (body.model === "deepseek-v4-flash:cloud") {
        return new Response(
          JSON.stringify({ error: "this model requires a subscription, upgrade for access" }),
          { status: 403, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: { content: "ok" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(smokeCalls, ["deepseek-v4-flash:cloud", "qwen3.5:9b"]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.skipped.length, 3);
  assert.deepEqual(result.verified.map((model) => model.name), ["qwen3.5:9b"]);
  assert.match(
    result.state.discoveredModels.find((model) => model.name === "deepseek-v4-flash:cloud").error,
    /requires a subscription/
  );
});

test("MMT active/pending separation rejects pending pins", () => {
  const base = addModelManager({}, { tool: "ollama", name: "ollama" });
  const state = {
    ...base,
    verifiedModels: [
      {
        managerId: "ollama",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        alias: "mmt_ollama_qwen3_5_9b",
        providerModel: "ollama_chat/qwen3.5:9b",
        apiBase: "http://127.0.0.1:11434",
        location: "local",
        status: "verified"
      }
    ]
  };

  const pending = markActiveAliases(state, {
    activeAliases: ["smart-router-general"],
    generatedConfigHash: "hash-a",
    aliases: ["mmt_ollama_qwen3_5_9b", "smart-router-general"]
  });
  assert.equal(pending.verifiedModels[0].status, "pending");
  assert.equal(pending.restartRequired, true);
  assert.throws(() => pinModelAlias(pending, "mmt_ollama_qwen3_5_9b"), /restart required/);

  const active = markActiveAliases(state, {
    activeAliases: ["mmt_ollama_qwen3_5_9b", "smart-router-general"],
    generatedConfigHash: "hash-a",
    aliases: ["mmt_ollama_qwen3_5_9b", "smart-router-general"]
  });
  assert.equal(active.verifiedModels[0].status, "active");
  assert.equal(active.restartRequired, false);
  assert.equal(pinModelAlias(active, "mmt_ollama_qwen3_5_9b").preferences.mode, "pin");
});

test("router honors active MMT pin and emits manager metadata", () => {
  const yaml = `
model_list:
  - model_name: mmt_ollama_qwen3_5_9b
    litellm_params:
      model: "ollama_chat/qwen3.5:9b"
      api_base: "http://127.0.0.1:11434"
    model_info:
      model_manager_id: "ollama"
      model_manager_tool: "ollama"
      model_location: "local"
  - model_name: smart-router-general
    litellm_params:
      model: "auto_router/complexity_router"
      complexity_router_config:
        tiers:
          SIMPLE: mmt_ollama_qwen3_5_9b
          MEDIUM: mmt_ollama_qwen3_5_9b
      complexity_router_default_model: mmt_ollama_qwen3_5_9b
`;
  const models = parseLiteLLMModelConfig(yaml);
  const routing = resolveModelRoute({
    targetModel: "smart-router-general",
    body: { messages: [{ role: "user", content: "hello" }] },
    models,
    modelManagerState: {
      preferences: { mode: "pin", pinnedAlias: "mmt_ollama_qwen3_5_9b" },
      verifiedModels: [
        {
          managerId: "ollama",
          managerTool: "ollama",
          name: "qwen3.5:9b",
          alias: "mmt_ollama_qwen3_5_9b",
          providerModel: "ollama_chat/qwen3.5:9b",
          apiBase: "http://127.0.0.1:11434",
          location: "local",
          status: "active"
        }
      ]
    }
  });

  assert.equal(routing.targetModel, "smart-router-general");
  assert.equal(routing.routedModel, "mmt_ollama_qwen3_5_9b");
  assert.equal(routing.providerModel, "ollama_chat/qwen3.5:9b");
  assert.equal(routing.modelLocation, "local");
  assert.equal(routing.modelManagerId, "ollama");
  assert.equal(routing.modelManagerTool, "ollama");
});

test("router ignores active MMT pin when loaded LiteLLM config lacks the alias", () => {
  const models = parseLiteLLMModelConfig(`
model_list:
  - model_name: general_local
    litellm_params:
      model: "ollama_chat/qwen3.5:9b"
      api_base: "http://127.0.0.1:11434"
  - model_name: smart-router-general
    litellm_params:
      model: "auto_router/complexity_router"
      complexity_router_config:
        tiers:
          SIMPLE: general_local
          MEDIUM: general_local
      complexity_router_default_model: general_local
`);

  const routing = resolveModelRoute({
    targetModel: "smart-router-general",
    body: { messages: [{ role: "user", content: "hello" }] },
    models,
    modelManagerState: {
      preferences: { mode: "pin", pinnedAlias: "mmt_ollama_qwen3_5_9b" },
      verifiedModels: [
        {
          managerId: "ollama",
          managerTool: "ollama",
          name: "qwen3.5:9b",
          alias: "mmt_ollama_qwen3_5_9b",
          providerModel: "ollama_chat/qwen3.5:9b",
          apiBase: "http://127.0.0.1:11434",
          location: "local",
          status: "active"
        }
      ]
    }
  });

  assert.equal(routing.routedModel, "general_local");
  assert.equal(routing.providerModel, "ollama_chat/qwen3.5:9b");
});

test("generated LiteLLM config path is canonical unless explicitly overridden", () =>
  withTempCwd(() => {
    assert.equal(resolveLiteLLMConfigPath(), GENERATED_LITELLM_CONFIG_PATH);
    writeGeneratedLiteLLMConfig({
      state: {
        verifiedModels: [
          {
            managerId: "ollama",
            managerTool: "ollama",
            name: "qwen3.5:9b",
            alias: "mmt_ollama_qwen3_5_9b",
            providerModel: "ollama_chat/qwen3.5:9b",
            apiBase: "http://127.0.0.1:11434",
            location: "local",
            status: "active"
          }
        ]
      }
    });
    assert.equal(resolveLiteLLMConfigPath(), GENERATED_LITELLM_CONFIG_PATH);
    assert.equal(resolveLiteLLMConfigPath({ explicitPath: "/tmp/manual.yaml" }), "/tmp/manual.yaml");
  }));

test("MMT active alias refresh authenticates LiteLLM /v1/models when api key is set", async () => {
  let capturedUrl = "";
  let capturedHeaders = {};
  const aliases = await fetchLiteLLMActiveAliases({
    baseUrl: "http://127.0.0.1:4000",
    apiKey: "sk-local",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers || {};
      return new Response(JSON.stringify({ data: [{ id: "smart-router-general" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.equal(capturedUrl, "http://127.0.0.1:4000/v1/models");
  assert.equal(capturedHeaders.authorization, "Bearer sk-local");
  assert.deepEqual(aliases, ["smart-router-general"]);
});

test("MMT active alias refresh omits LiteLLM auth header when api key is empty", async () => {
  let capturedHeaders = {};
  await fetchLiteLLMActiveAliases({
    baseUrl: "http://127.0.0.1:4000",
    apiKey: "",
    fetchImpl: async (_url, init) => {
      capturedHeaders = init?.headers || {};
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.equal("authorization" in capturedHeaders, false);
});

// --- TST-17: MMT state-file I/O and corrupt-state recovery -----------------

test("readModelManagerState recovers to createDefaultModelManagerState on malformed JSON", () =>
  withTempCwd(() => {
    fs.mkdirSync(path.dirname(MODEL_MANAGER_STATE_PATH), { recursive: true });
    fs.writeFileSync(MODEL_MANAGER_STATE_PATH, "{ this is not valid json ]", "utf8");

    const recovered = readModelManagerState(MODEL_MANAGER_STATE_PATH);

    // Observable recovery: corrupt JSON must fall back to exactly the default
    // shape, not silently return a partially-parsed or mutated object.
    assert.deepEqual(recovered, createDefaultModelManagerState());
  }));

test("readModelManagerState recovers to createDefaultModelManagerState when the file is missing", () =>
  withTempCwd(() => {
    const recovered = readModelManagerState(path.join("nested", "missing", "model-managers.json"));
    assert.deepEqual(recovered, createDefaultModelManagerState());
  }));

test("writeModelManagerState then readModelManagerState round-trips a valid state", () =>
  withTempCwd(() => {
    const state = addModelManager({}, { tool: "ollama", baseUrl: "http://127.0.0.1:11434", name: "Ollama" });
    const written = writeModelManagerState(state, MODEL_MANAGER_STATE_PATH);
    const reread = readModelManagerState(MODEL_MANAGER_STATE_PATH);

    assert.deepEqual(reread, written);
    assert.equal(reread.managers[0].tool, "ollama");
    assert.equal(reread.managers[0].baseUrl, "http://127.0.0.1:11434");

    const onDisk = fs.readFileSync(path.resolve(MODEL_MANAGER_STATE_PATH), "utf8");
    assert.deepEqual(JSON.parse(onDisk), written);
  }));

test("writeModelManagerState creates the parent directory when absent", () =>
  withTempCwd(() => {
    const nestedPath = path.join("deeply", "nested", "dir", "model-managers.json");
    assert.equal(fs.existsSync(path.dirname(nestedPath)), false);

    writeModelManagerState({}, nestedPath);

    assert.equal(fs.existsSync(nestedPath), true);
    const persisted = JSON.parse(fs.readFileSync(nestedPath, "utf8"));
    assert.equal(persisted.version, 1);
  }));

// --- Other untested shared/model-managers.js exports ------------------------

test("addModelManager rejects an unsupported MMT tool", () => {
  assert.throws(
    () => addModelManager({}, { tool: "carrier-pigeon", baseUrl: "http://example" }),
    /Unsupported MMT tool\. Use ollama or lmstudio\./
  );
});

test("removeModelManager drops the manager and its discovered/verified models", () => {
  const base = addModelManager({}, { tool: "ollama", id: "ollamaa", name: "Ollama A" });
  const state = {
    ...base,
    discoveredModels: [
      { managerId: "ollamaa", managerTool: "ollama", name: "qwen3.5:9b", status: "candidate" }
    ],
    verifiedModels: [
      {
        managerId: "ollamaa",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        providerModel: "ollama_chat/qwen3.5:9b",
        location: "local",
        status: "active"
      }
    ]
  };

  const next = removeModelManager(state, "ollamaa");
  assert.equal(next.managers.length, 0);
  assert.equal(next.discoveredModels.length, 0);
  assert.equal(next.verifiedModels.length, 0);
  assert.deepEqual(next.selectedManagerIds, []);
});

test("editModelManager updates baseUrl/name/enabled and rejects an unknown manager id", () => {
  const state = addModelManager({}, { tool: "ollama", id: "ollamaa", name: "Ollama A" });

  const edited = editModelManager(state, "ollamaa", { baseUrl: "http://127.0.0.1:9999", name: "Renamed", enabled: false });
  assert.equal(edited.managers[0].baseUrl, "http://127.0.0.1:9999");
  assert.equal(edited.managers[0].name, "Renamed");
  assert.equal(edited.managers[0].enabled, false);

  assert.throws(() => editModelManager(state, "does-not-exist", { baseUrl: "http://x" }), /Unknown MMT manager: does-not-exist/);
});

test("selectModelManager narrows selection to one manager and rejects an unknown manager id", () => {
  const withA = addModelManager({}, { tool: "ollama", id: "ollamaa", name: "Ollama A" });
  const state = addModelManager(withA, { tool: "lmstudio", id: "studiob", name: "Studio B" });

  const selected = selectModelManager(state, "studiob");
  assert.deepEqual(selected.selectedManagerIds, ["studiob"]);
  assert.deepEqual(
    selected.managers.map((manager) => [manager.id, manager.selected]),
    [
      ["ollamaa", false],
      ["studiob", true]
    ]
  );

  assert.throws(() => selectModelManager(state, "does-not-exist"), /Unknown MMT manager: does-not-exist/);
});

test("pinModelAlias rejects an unknown alias", () => {
  assert.throws(() => pinModelAlias({}, "mmt_missing_alias"), /Unknown model alias: mmt_missing_alias/);
});

test("setModelAutoMode clears a pinned alias back to auto mode", () => {
  const pinned = {
    preferences: { mode: "pin", pinnedAlias: "mmt_ollama_qwen3_5_9b", defaultAlias: null }
  };
  const auto = setModelAutoMode(pinned);
  assert.equal(auto.preferences.mode, "auto");
  assert.equal(auto.preferences.pinnedAlias, null);
});

test("getActivePinnedModel returns null outside pin mode and the active model when pinned", () => {
  const model = {
    managerId: "ollamaa",
    managerTool: "ollama",
    name: "qwen3.5:9b",
    alias: "mmt_ollamaa_qwen3_5_9b",
    providerModel: "ollama_chat/qwen3.5:9b",
    location: "local",
    status: "active"
  };

  assert.equal(getActivePinnedModel({ preferences: { mode: "auto" }, verifiedModels: [model] }), null);
  assert.equal(
    getActivePinnedModel({
      preferences: { mode: "pin", pinnedAlias: "mmt_ollamaa_qwen3_5_9b" },
      verifiedModels: [model]
    })?.alias,
    "mmt_ollamaa_qwen3_5_9b"
  );
});

test("markActiveAliases resets a pin back to auto once the pinned model is no longer active", () => {
  const state = {
    verifiedModels: [
      {
        managerId: "ollamaa",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        alias: "mmt_ollamaa_qwen3_5_9b",
        providerModel: "ollama_chat/qwen3.5:9b",
        location: "local",
        status: "verified"
      }
    ],
    preferences: { mode: "pin", pinnedAlias: "mmt_ollamaa_qwen3_5_9b" }
  };

  const activated = markActiveAliases(state, {
    activeAliases: ["mmt_ollamaa_qwen3_5_9b"],
    generatedConfigHash: "hash-a",
    aliases: ["mmt_ollamaa_qwen3_5_9b"]
  });
  assert.equal(activated.preferences.mode, "pin");
  assert.equal(activated.preferences.pinnedAlias, "mmt_ollamaa_qwen3_5_9b");

  const deactivated = markActiveAliases(activated, {
    activeAliases: [],
    generatedConfigHash: "hash-b",
    aliases: ["mmt_ollamaa_qwen3_5_9b"]
  });
  assert.equal(deactivated.verifiedModels[0].status, "pending");
  assert.equal(deactivated.preferences.mode, "auto");
  assert.equal(deactivated.preferences.pinnedAlias, null);
});

test("writeGeneratedLiteLLMConfig throws when there are no configurable verified models", () =>
  withTempCwd(() => {
    assert.throws(
      () => writeGeneratedLiteLLMConfig({ state: {} }),
      /No verified MMT models available to generate LiteLLM config\./
    );
  }));

test("MMT discovery surfaces per-manager errors instead of throwing", async () => {
  const state = addModelManager({}, { tool: "ollama", id: "ollamaa", name: "Ollama A" });
  const result = await discoverModelManagerModels(state, {
    fetchImpl: async () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
  });

  assert.equal(result.discovered.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].managerId, "ollamaa");
  assert.match(result.errors[0].error, /Ollama discovery failed \(404\)/);
});

test("MMT discovery and smoke validation work for LM Studio managers", async () => {
  const state = addModelManager({}, { tool: "lmstudio", id: "studio-a", name: "Studio A" });
  const discoveredResult = await discoverModelManagerModels(state, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen/qwen3.5-9b", capabilities: ["completion"] }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
  });
  assert.equal(discoveredResult.discovered[0].name, "qwen/qwen3.5-9b");
  assert.equal(discoveredResult.discovered[0].providerModel, "openai/qwen/qwen3.5-9b");

  const verifiedResult = await verifyDiscoveredModelManagerModels(discoveredResult.state, {
    fetchImpl: async (url) => {
      assert.match(String(url), /\/chat\/completions$/);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(verifiedResult.verified[0].status, "verified");
});

test("MMT smoke validation records a genuine (non-skip) failure with a non-JSON error body", async () => {
  const state = addModelManager({}, { tool: "ollama", id: "ollamaa", name: "Ollama A" });
  const withCandidate = {
    ...state,
    discoveredModels: [
      {
        managerId: "ollamaa",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        capabilities: ["completion"],
        status: "candidate"
      }
    ]
  };

  const result = await verifyDiscoveredModelManagerModels(withCandidate, {
    fetchImpl: async () =>
      new Response("internal server meltdown", { status: 500, headers: { "content-type": "text/plain" } })
  });

  assert.equal(result.verified.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /Ollama smoke failed \(500\): internal server meltdown/);
  assert.equal(
    result.state.discoveredModels.find((model) => model.name === "qwen3.5:9b").status,
    "error"
  );
});

test("MMT smoke validation skips the failed-to-load-model unavailable case", async () => {
  const state = addModelManager({}, { tool: "ollama", id: "ollamaa", name: "Ollama A" });
  const withCandidate = {
    ...state,
    discoveredModels: [
      {
        managerId: "ollamaa",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        capabilities: ["completion"],
        status: "candidate"
      }
    ]
  };

  const result = await verifyDiscoveredModelManagerModels(withCandidate, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "failed to load model into memory" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].error, /failed to load model/);
});

test("verifyDiscoveredModelManagerModels short-circuits when there are no discovered candidates", async () => {
  const result = await verifyDiscoveredModelManagerModels({ discoveredModels: [] });
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.state.discoveredModels, []);
});

test("MMT smoke validation records a genuine failure even when reading the error body itself throws", async () => {
  const state = addModelManager({}, { tool: "ollama", id: "ollamaa", name: "Ollama A" });
  const withCandidate = {
    ...state,
    discoveredModels: [
      {
        managerId: "ollamaa",
        managerTool: "ollama",
        name: "qwen3.5:9b",
        capabilities: ["completion"],
        status: "candidate"
      }
    ]
  };

  const result = await verifyDiscoveredModelManagerModels(withCandidate, {
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: () => {
        throw new Error("body already consumed");
      }
    })
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error, "Ollama smoke failed (500)");
});

test("fetchLiteLLMActiveAliases throws when LiteLLM /v1/models responds not-ok", async () => {
  await assert.rejects(
    () =>
      fetchLiteLLMActiveAliases({
        baseUrl: "http://127.0.0.1:4000",
        apiKey: "",
        fetchImpl: async () => new Response("nope", { status: 503 })
      }),
    /LiteLLM \/v1\/models failed \(503\)/
  );
});
