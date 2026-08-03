import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGatewayServer } from "../tools/router-gateway/src/server.js";

function writeTempPolicy(tempDir) {
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
  return policyPath;
}

async function withRunningGatewayServer(options, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-negative-"));
  const policyPath = writeTempPolicy(tempDir);
  const liteLLMConfigPath = path.join(tempDir, "missing-litellm-config.yaml");
  const server = createGatewayServer({
    policyPath,
    liteLLMConfigPath,
    liteLLMBaseUrl: "http://127.0.0.1:4000",
    requireSmartRouterModel: true,
    ...options
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("router-gateway rejects a request whose body.model is not the required smart-router model", async () => {
  await withRunningGatewayServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "some-other-model",
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error.message, /requires model=/);
  });
});

test("router-gateway rejects malformed JSON bodies with a 400", async () => {
  await withRunningGatewayServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json"
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.message, "Invalid JSON body");
  });
});

test("router-gateway GET /health returns 200 ok", async () => {
  await withRunningGatewayServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { method: "GET" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { ok: true });
  });
});

test("router-gateway returns 404 for an unknown path", async () => {
  await withRunningGatewayServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/does-not-exist`, { method: "GET" });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error.message, "Not found");
  });
});

test("router-gateway returns a fixed message for an upstream 500 without echoing the body", async () => {
  // Upstream error bodies can carry LiteLLM/model-config internals; the client
  // gets a constant message and the detail goes to the server log only.
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const consoleErrors = [];
  console.error = (...args) => consoleErrors.push(args.join(" "));
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "upstream exploded" } }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });

  try {
    await withRunningGatewayServer({}, async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "smart-router",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(response.status, 500);
      const payload = await response.json();
      assert.equal(payload.error.message, "Upstream LiteLLM call failed");
      assert.equal(payload.error.upstream, undefined);
      assert.equal(JSON.stringify(payload).includes("upstream exploded"), false);
      assert.ok(payload.error.routing);
    });
    assert.equal(
      consoleErrors.some((entry) => entry.includes("upstream exploded")),
      true,
      "expected the upstream body to be logged server-side"
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("router-gateway returns a catch-all 500 when the upstream call throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unreachable");
  };

  try {
    await withRunningGatewayServer({}, async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "smart-router",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(response.status, 500);
      const payload = await response.json();
      assert.equal(payload.error.message, "network unreachable");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
