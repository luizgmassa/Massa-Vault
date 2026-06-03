import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyRequest, loadPolicy } from "../tools/router-gateway/src/domain/classifier.js";
import {
  parseLiteLLMModelConfig,
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
