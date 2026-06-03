import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGatewayServer } from "../tools/router-gateway/src/server.js";

test("router-gateway forwards Authorization header to upstream", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-auth-"));
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

  let upstreamAuthorization = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    upstreamAuthorization = init.headers.authorization || null;
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

  const server = createGatewayServer({
    policyPath,
    liteLLMBaseUrl: "http://127.0.0.1:4000"
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await originalFetch(`http://127.0.0.1:${address.port}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-forwarded"
      },
      body: JSON.stringify({
        model: "smart-router",
        messages: [{ role: "user", content: "debug this" }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamAuthorization, "Bearer sk-forwarded");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("router-gateway forwards concrete model and returns model metadata headers", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-model-"));
  const policyPath = path.join(tempDir, "router.json");
  const liteLLMConfigPath = path.join(tempDir, "litellm-config.yaml");
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
  fs.writeFileSync(
    liteLLMConfigPath,
    `
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
`,
    "utf8"
  );

  let upstreamBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
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

  const server = createGatewayServer({
    policyPath,
    liteLLMConfigPath,
    liteLLMBaseUrl: "http://127.0.0.1:4000"
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await originalFetch(`http://127.0.0.1:${address.port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "smart-router",
        messages: [{ role: "user", content: "debug" }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.model, "code_local");
    assert.equal(response.headers.get("x-router-target-model"), "smart-router-code");
    assert.equal(response.headers.get("x-router-routed-model"), "code_local");
    assert.equal(response.headers.get("x-router-provider-model"), "ollama_chat/qwen2.5-coder:7b");
    assert.equal(response.headers.get("x-router-display-model"), "qwen2.5-coder:7b");
    assert.equal(response.headers.get("x-router-model-location"), "local");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("router-gateway exposes fallback metadata headers for cloud routes with local fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-fallback-"));
  const policyPath = path.join(tempDir, "router.json");
  const liteLLMConfigPath = path.join(tempDir, "litellm-config.yaml");
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
  fs.writeFileSync(
    liteLLMConfigPath,
    `
model_list:
  - model_name: general_local
    litellm_params:
      model: ollama_chat/qwen3.5:9b
      api_base: http://localhost:11434
  - model_name: general_cloud
    litellm_params:
      model: ollama_chat/deepseek-v3.2:cloud
      api_base: http://localhost:11434
  - model_name: smart-router-general
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: general_local
          MEDIUM: general_cloud
          COMPLEX: general_cloud
        token_thresholds:
          simple: 16
          complex: 100
      complexity_router_default_model: general_local

router_settings:
  fallbacks:
    - general_cloud:
        - general_local
`,
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
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

  const server = createGatewayServer({
    policyPath,
    liteLLMConfigPath,
    liteLLMBaseUrl: "http://127.0.0.1:4000"
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await originalFetch(`http://127.0.0.1:${address.port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "smart-router",
        messages: [{ role: "user", content: "hello " + "x ".repeat(600) }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-router-routed-model"), "general_cloud");
    assert.equal(response.headers.get("x-router-model-location"), "cloud");
    assert.equal(response.headers.get("x-router-fallback-routes"), "general_local");
    assert.equal(response.headers.get("x-router-local-fallback-available"), "true");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("router-gateway corrects routing headers from upstream executed fallback model group", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-fallback-corrected-"));
  const policyPath = path.join(tempDir, "router.json");
  const liteLLMConfigPath = path.join(tempDir, "litellm-config.yaml");
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
  fs.writeFileSync(
    liteLLMConfigPath,
    `
model_list:
  - model_name: general_local
    litellm_params:
      model: ollama_chat/qwen3.5:9b
      api_base: http://localhost:11434
  - model_name: general_cloud
    litellm_params:
      model: ollama_chat/deepseek-v3.2:cloud
      api_base: http://localhost:11434
  - model_name: smart-router-general
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE: general_local
          MEDIUM: general_cloud
          COMPLEX: general_cloud
        token_thresholds:
          simple: 16
          complex: 100
      complexity_router_default_model: general_local

router_settings:
  fallbacks:
    - general_cloud:
        - general_local
`,
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "general_cloud",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-litellm-model-group": "general_local"
        }
      }
    );

  const server = createGatewayServer({
    policyPath,
    liteLLMConfigPath,
    liteLLMBaseUrl: "http://127.0.0.1:4000"
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await originalFetch(`http://127.0.0.1:${address.port}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "smart-router",
        messages: [{ role: "user", content: "hello " + "x ".repeat(600) }]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-router-routed-model"), "general_local");
    assert.equal(response.headers.get("x-router-provider-model"), "ollama_chat/qwen3.5:9b");
    assert.equal(response.headers.get("x-router-display-model"), "qwen3.5:9b");
    assert.equal(response.headers.get("x-router-model-location"), "local");
    assert.equal(response.headers.get("x-router-fallback-used"), "true");
    assert.equal(
      response.headers.get("x-router-fallback-warning"),
      "cloud route fell back to local model qwen3.5:9b"
    );
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
