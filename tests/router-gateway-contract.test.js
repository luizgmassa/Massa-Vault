import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyRequest, loadPolicy } from "../tools/router-gateway/src/domain/classifier.js";
import {
  parseLiteLLMModelConfig,
  resolveExecutedModelRoute,
  resolveModelRoute
} from "../tools/router-gateway/src/domain/model-resolution.js";
import { forwardRequest } from "../tools/router-gateway/src/infrastructure/proxy.js";

const litellmConfig = `
model_list:
  - model_name: code_local
    litellm_params:
      model: ollama_chat/qwen2.5-coder:7b
      api_base: http://localhost:11434

  - model_name: code_cloud
    litellm_params:
      model: ollama_chat/qwen3-coder-next:cloud
      api_base: http://localhost:11434

  - model_name: smart-router-code
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: code_local
          MEDIUM: code_cloud
          COMPLEX: code_cloud
        token_thresholds:
          simple: 24
          complex: 300
      complexity_router_default_model: code_local

router_settings:
  fallbacks:
    - code_cloud:
        - code_local
`;

test("parses LiteLLM config and resolves local/cloud concrete models", () => {
  const models = parseLiteLLMModelConfig(litellmConfig);

  const local = resolveModelRoute({
    targetModel: "smart-router-code",
    body: { messages: [{ role: "user", content: "debug" }] },
    models
  });
  assert.equal(local.routedModel, "code_local");
  assert.equal(local.providerModel, "ollama_chat/qwen2.5-coder:7b");
  assert.equal(local.displayModel, "qwen2.5-coder:7b");
  assert.equal(local.modelLocation, "local");

  const cloud = resolveModelRoute({
    targetModel: "smart-router-code",
    body: { messages: [{ role: "user", content: "debug " + "x ".repeat(1400) }] },
    models
  });
  assert.equal(cloud.routedModel, "code_cloud");
  assert.equal(cloud.providerModel, "ollama_chat/qwen3-coder-next:cloud");
  assert.equal(cloud.displayModel, "qwen3-coder-next:cloud");
  assert.equal(cloud.modelLocation, "cloud");
  assert.deepEqual(cloud.fallbackRoutes, ["code_local"]);
  assert.equal(cloud.localFallbackAvailable, true);

  const dashCloud = resolveModelRoute({
    targetModel: "dash_cloud",
    body: { messages: [{ role: "user", content: "debug" }] },
    models: parseLiteLLMModelConfig(`
model_list:
  - model_name: dash_cloud
    litellm_params:
      model: ollama_chat/gpt-oss:120b-cloud
      api_base: http://localhost:11434
`)
  });
  assert.equal(dashCloud.modelLocation, "cloud");
});

test("resolveExecutedModelRoute corrects executed fallback route from upstream model group", () => {
  const models = parseLiteLLMModelConfig(`
model_list:
  - model_name: general_local
    litellm_params:
      model: ollama_chat/qwen3.5:9b
      api_base: http://localhost:11434

  - model_name: general_cloud
    litellm_params:
      model: ollama_chat/deepseek-v3.2:cloud
      api_base: http://localhost:11434
`);

  const corrected = resolveExecutedModelRoute({
    routing: {
      lane: "general",
      confidence: 1,
      targetModel: "smart-router-general",
      routedModel: "general_cloud",
      providerModel: "ollama_chat/deepseek-v3.2:cloud",
      displayModel: "deepseek-v3.2:cloud",
      modelLocation: "cloud",
      fallbackRoutes: ["general_local"],
      localFallbackAvailable: true
    },
    executedModelGroup: "general_local",
    models
  });

  assert.equal(corrected.routedModel, "general_local");
  assert.equal(corrected.providerModel, "ollama_chat/qwen3.5:9b");
  assert.equal(corrected.displayModel, "qwen3.5:9b");
  assert.equal(corrected.modelLocation, "local");
  assert.equal(corrected.fallbackUsed, true);
  assert.equal(corrected.fallbackWarning, "cloud route fell back to local model qwen3.5:9b");
});

test("keeps OpenAI payload shape and forwards chosen model", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-policy-"));
  const policyPath = path.join(tempDir, "router.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      confidenceFloor: 0.3,
      lanes: {
        code: { model: "smart-router-code", phrases: ["debug"] },
        multimodal: { model: "smart-router-multimodal", phrases: ["image"] },
        general: { model: "smart-router-general", phrases: [] }
      }
    }),
    "utf8"
  );

  const body = {
    model: "smart-router",
    messages: [{ role: "user", content: "debug this error" }],
    context: {
      source: "obsidian",
      note_path: "notes/today.md",
      selection_length: 24
    }
  };
  const policy = loadPolicy(policyPath);
  const routing = classifyRequest(body, policy);
  const forwardedBody = { ...body, model: routing.targetModel };

  let upstreamBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "http://127.0.0.1:4000/chat/completions");
    assert.equal(init.method, "POST");
    upstreamBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };

  const response = await forwardRequest({
    baseUrl: "http://127.0.0.1:4000",
    pathname: "/chat/completions",
    body: forwardedBody,
    headers: { "content-type": "application/json" }
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(routing.lane, "code");
  assert.equal(upstreamBody.model, "smart-router-code");
  assert.equal(Array.isArray(upstreamBody.messages), true);
  assert.equal(upstreamBody.context.source, "obsidian");
  assert.equal(json.object, "chat.completion");

  globalThis.fetch = originalFetch;
});
