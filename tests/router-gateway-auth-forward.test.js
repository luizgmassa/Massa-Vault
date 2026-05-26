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
    const response = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, {
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
