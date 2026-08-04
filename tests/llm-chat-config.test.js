import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveDefaultConfigPath,
  resolveDefaultGatewayModel,
  resolveDefaultGatewayUrl,
  resolveDefaultIdleSyncMs
} from "../tools/llm-chat-cli/src/infrastructure/chat-config.js";

// These resolvers replaced import-time-frozen constants (ARCH-3 R5). The
// property under test is exactly the one the constants could not have: env
// changes made after module import are visible on the next call.

const TOUCHED_ENV_KEYS = [
  "MASSA_AI_VAULT_CHAT_MODEL",
  "MASSA_AI_VAULT_CHAT_GATEWAY_URL",
  "MASSA_AI_VAULT_CHAT_IDLE_SYNC_MS",
  "MASSA_AI_VAULT_NOTES_CONFIG_PATH",
  "MASSA_AI_VAULT_CLI_CONFIG_PATH"
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of TOUCHED_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of TOUCHED_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("resolveDefaultGatewayModel reflects env changes made after import", () => {
  withEnv({ MASSA_AI_VAULT_CHAT_MODEL: "custom-model-a" }, () => {
    assert.equal(resolveDefaultGatewayModel(), "custom-model-a");
  });
  withEnv({ MASSA_AI_VAULT_CHAT_MODEL: "custom-model-b" }, () => {
    assert.equal(resolveDefaultGatewayModel(), "custom-model-b");
  });
});

test("resolveDefaultGatewayUrl reflects the env override per call", () => {
  withEnv({ MASSA_AI_VAULT_CHAT_GATEWAY_URL: "http://127.0.0.1:59321" }, () => {
    assert.equal(resolveDefaultGatewayUrl(), "http://127.0.0.1:59321");
  });
});

test("resolveDefaultIdleSyncMs coerces the env override per call", () => {
  withEnv({ MASSA_AI_VAULT_CHAT_IDLE_SYNC_MS: "12345" }, () => {
    assert.equal(resolveDefaultIdleSyncMs(), 12345);
  });
});

test("resolveDefaultConfigPath honors an absolute env override per call", () => {
  const override = path.resolve("/tmp/arch3-notes-config.json");
  withEnv({ MASSA_AI_VAULT_NOTES_CONFIG_PATH: override }, () => {
    assert.equal(resolveDefaultConfigPath(), override);
  });
});
