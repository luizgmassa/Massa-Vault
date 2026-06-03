import test from "node:test";
import assert from "node:assert/strict";
import { parseLiteLLMLimits } from "../tools/llm-chat-cli/src/infrastructure/litellm-limits.js";

test("parseLiteLLMLimits extracts rpm/tpm per model", () => {
  const yaml = `
model_list:
  - model_name: code_cloud
    litellm_params:
      model: ollama_chat/qwen3-coder-next:cloud
      rpm: 60
      tpm: 90000

  - model_name: smart-router-code
    litellm_params:
      model: auto_router/complexity_router
`;
  const limits = parseLiteLLMLimits(yaml);
  assert.deepEqual(limits.code_cloud, { rpm: 60, tpm: 90000 });
  assert.deepEqual(limits["smart-router-code"], {});
});
