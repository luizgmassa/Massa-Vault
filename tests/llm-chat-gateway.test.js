import test from "node:test";
import assert from "node:assert/strict";
import { streamChatCompletion } from "../tools/llm-chat-cli/src/infrastructure/gateway.js";

test("streamChatCompletion includes Authorization header when apiKey is set", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init.headers;
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  try {
    await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "sk-test-key",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "ping" }] }
    });
    assert.equal(capturedHeaders.authorization, "Bearer sk-test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion omits Authorization header when apiKey is empty", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init.headers;
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  try {
    await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "ping" }] }
    });
    assert.equal("authorization" in capturedHeaders, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion forwards AbortSignal to fetch", async () => {
  const originalFetch = globalThis.fetch;
  const abortController = new AbortController();
  let capturedSignal;
  globalThis.fetch = async (_url, init) => {
    capturedSignal = init.signal;
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  try {
    await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "ping" }] },
      signal: abortController.signal
    });
    assert.equal(capturedSignal, abortController.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion parses array-based delta content", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [];
  globalThis.fetch = async () =>
    new Response(
      'data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"Hel"},{"type":"output_text","text":"lo"}]}}]}\n\n' +
        "data: [DONE]\n\n",
      {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }
    );

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "ping" }] },
      onDelta: (chunk) => chunks.push(chunk)
    });
    assert.equal(result.assistantText, "Hello");
    assert.equal(chunks.join(""), "Hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion reads router model metadata headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("data: [DONE]\n\n", {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-router-lane": "code",
        "x-router-confidence": "0.9000",
        "x-router-target-model": "smart-router-code",
        "x-router-routed-model": "code_local",
        "x-router-provider-model": "ollama_chat/qwen2.5-coder:7b",
        "x-router-display-model": "qwen2.5-coder:7b",
        "x-router-model-location": "local"
      }
    });

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "debug" }] }
    });
    assert.equal(result.routing.targetModel, "smart-router-code");
    assert.equal(result.routing.routedModel, "code_local");
    assert.equal(result.routing.providerModel, "ollama_chat/qwen2.5-coder:7b");
    assert.equal(result.routing.displayModel, "qwen2.5-coder:7b");
    assert.equal(result.routing.modelLocation, "local");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion confirms response model from JSON payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "ollama_chat/qwen3-coder-next:cloud",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "debug" }] }
    });
    assert.equal(result.routing.responseModel, "ollama_chat/qwen3-coder-next:cloud");
    assert.equal(result.routing.displayModel, "ollama_chat/qwen3-coder-next:cloud");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion marks local fallback when response model contradicts cloud routing", async () => {
  const originalFetch = globalThis.fetch;
  const routingSnapshots = [];
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "ollama_chat/qwen3.5:9b",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-router-lane": "general",
          "x-router-confidence": "1.0000",
          "x-router-target-model": "smart-router-general",
          "x-router-routed-model": "general_cloud",
          "x-router-provider-model": "ollama_chat/deepseek-v3.2:cloud",
          "x-router-display-model": "deepseek-v3.2:cloud",
          "x-router-model-location": "cloud",
          "x-router-fallback-routes": "general_local",
          "x-router-local-fallback-available": "true"
        }
      }
    );

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "hello" }] },
      onRouting: (routing) => routingSnapshots.push(routing)
    });
    assert.equal(result.routing.routedModel, "general_local");
    assert.equal(result.routing.providerModel, "ollama_chat/qwen3.5:9b");
    assert.equal(result.routing.displayModel, "qwen3.5:9b");
    assert.equal(result.routing.modelLocation, "local");
    assert.equal(result.routing.fallbackUsed, true);
    assert.equal(result.routing.fallbackWarning, "cloud route fell back to local model qwen3.5:9b");
    assert.deepEqual(result.routing.fallbackRoutes, ["general_local"]);
    assert.equal(result.routing.localFallbackAvailable, true);
    assert.equal(routingSnapshots.at(-1).fallbackUsed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion ignores internal route alias payload when headers already expose executed local fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "general_cloud",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-router-lane": "general",
          "x-router-confidence": "1.0000",
          "x-router-target-model": "smart-router-general",
          "x-router-routed-model": "general_local",
          "x-router-provider-model": "ollama_chat/qwen3.5:9b",
          "x-router-display-model": "qwen3.5:9b",
          "x-router-model-location": "local",
          "x-router-fallback-routes": "general_local",
          "x-router-local-fallback-available": "true",
          "x-router-fallback-used": "true",
          "x-router-fallback-warning": "cloud route fell back to local model qwen3.5:9b"
        }
      }
    );

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(result.routing.responseModel, "general_cloud");
    assert.equal(result.routing.routedModel, "general_local");
    assert.equal(result.routing.providerModel, "ollama_chat/qwen3.5:9b");
    assert.equal(result.routing.displayModel, "qwen3.5:9b");
    assert.equal(result.routing.modelLocation, "local");
    assert.equal(result.routing.fallbackWarning, "cloud route fell back to local model qwen3.5:9b");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion does not promote smart-router response model to display model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        model: "smart-router-general",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "debug" }] }
    });
    assert.equal(result.routing.responseModel, "smart-router-general");
    assert.equal(result.routing.displayModel, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion confirms response model from stream payload", async () => {
  const originalFetch = globalThis.fetch;
  const routingSnapshots = [];
  globalThis.fetch = async () =>
    new Response(
      'data: {"model":"ollama_chat/qwen3-coder-next:cloud","choices":[{"delta":{"content":"ok"}}]}\n\n' +
        "data: [DONE]\n\n",
      {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }
    );

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "debug" }] },
      onRouting: (routing) => routingSnapshots.push(routing)
    });
    assert.equal(result.assistantText, "ok");
    assert.equal(result.routing.responseModel, "ollama_chat/qwen3-coder-next:cloud");
    assert.equal(routingSnapshots.at(-1).responseModel, "ollama_chat/qwen3-coder-next:cloud");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamChatCompletion handles non-SSE JSON chat response", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [];
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [{ type: "output_text", text: "Hello from JSON" }]
            }
          }
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );

  try {
    const result = await streamChatCompletion({
      baseUrl: "http://127.0.0.1:4100",
      apiKey: "",
      body: { model: "smart-router", stream: true, messages: [{ role: "user", content: "ping" }] },
      onDelta: (chunk) => chunks.push(chunk)
    });
    assert.equal(result.assistantText, "Hello from JSON");
    assert.deepEqual(result.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
    assert.equal(chunks.join(""), "Hello from JSON");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
