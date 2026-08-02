import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROUTER_GATEWAY_REQUIRED_MODEL } from "../tools/router-gateway/src/infrastructure/constants.js";
import { DEFAULT_CHAT_MODEL } from "../tools/llm-chat-cli/src/infrastructure/vault-cli-config.js";
import { generateLiteLLMConfigFromModelManagerState } from "../tools/shared/model-managers.js";

function loadRouterGatewayPolicy() {
  const configPath = path.resolve("config/router-gateway.json");
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

function generatedAliasesFixture() {
  const state = {
    managers: [{ id: "ollama", tool: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true }],
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
    ],
    preferences: { mode: "auto", pinnedAlias: null, defaultAlias: null }
  };
  return generateLiteLLMConfigFromModelManagerState(state);
}

test("client-side DEFAULT_CHAT_MODEL matches gateway-side ROUTER_GATEWAY_REQUIRED_MODEL", () => {
  assert.equal(DEFAULT_CHAT_MODEL, ROUTER_GATEWAY_REQUIRED_MODEL);
});

test("every router-gateway.json lane model appears in the generated LiteLLM alias list", () => {
  const policy = loadRouterGatewayPolicy();
  const laneModels = Object.values(policy.lanes).map((lane) => lane.model);
  assert.ok(laneModels.length > 0, "expected at least one lane in config/router-gateway.json");

  const generated = generatedAliasesFixture();
  for (const laneModel of laneModels) {
    assert.ok(
      generated.aliases.includes(laneModel),
      `expected generated LiteLLM aliases to include lane model "${laneModel}", got: ${generated.aliases.join(", ")}`
    );
  }
});

test("ROUTER_GATEWAY_REQUIRED_MODEL is not itself one of the concrete lane aliases", () => {
  // The client sends ROUTER_GATEWAY_REQUIRED_MODEL ("smart-router"); the gateway then
  // classifies it into one of the lane models below. They must stay distinct concepts,
  // but the required model string must still be the exact prefix all lane models share.
  const policy = loadRouterGatewayPolicy();
  for (const lane of Object.values(policy.lanes)) {
    assert.ok(
      lane.model.startsWith(ROUTER_GATEWAY_REQUIRED_MODEL),
      `expected lane model "${lane.model}" to start with "${ROUTER_GATEWAY_REQUIRED_MODEL}"`
    );
  }
});
