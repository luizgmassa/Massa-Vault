import test from "node:test";
import assert from "node:assert/strict";
import { streamChatCompletion } from "../tools/llm-chat-cli/src/gateway.js";

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
