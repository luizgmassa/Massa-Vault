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
