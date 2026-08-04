import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// T6 needs to exercise the default-config-path gated branch (R9), but
// DEFAULT_VAULT_CLI_CONFIG_PATH is `path.resolve("config/vault-cli.config.json")`
// against cwd *at import time*, and that path is this repo's real tracked
// config/vault-cli.config.json. Chdir into a scratch root before the first
// (dynamic) import freezes it to a scratch-root path instead, so these tests
// never read or write the real file. Mirrors the precedent in
// tests/notes-automation-cli-runtime.test.js and tests/notes-automation-config.test.js.
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-config-scratch-"));
const ORIGINAL_CWD = process.cwd();
fs.mkdirSync(path.join(SCRATCH_ROOT, "config"), { recursive: true });

process.chdir(SCRATCH_ROOT);
const { loadVaultCliRuntimeConfig, DEFAULT_VAULT_CLI_CONFIG_PATH } = await import(
  "../tools/shared/vault-cli-config.js"
);
process.chdir(ORIGINAL_CWD);

function writeDefaultTrackedConfig(document) {
  fs.writeFileSync(DEFAULT_VAULT_CLI_CONFIG_PATH, JSON.stringify(document), "utf8");
}

function writeHomeConfig(homeConfigPath, document) {
  fs.mkdirSync(path.dirname(homeConfigPath), { recursive: true });
  fs.writeFileSync(homeConfigPath, JSON.stringify(document), "utf8");
}

test("home config's chat section beats config/vault-cli.config.json for the default config path", () => {
  writeDefaultTrackedConfig({ chat: { model: "tracked-model", gateway_url: "http://127.0.0.1:9001" } });
  const homeConfigPath = path.join(SCRATCH_ROOT, "home-config.json");
  writeHomeConfig(homeConfigPath, { chat: { model: "home-model" } });

  const config = loadVaultCliRuntimeConfig({ env: { MASSA_AI_VAULT_HOME_CONFIG: homeConfigPath } });
  assert.equal(config.chat.model, "home-model");
  // Home config only overrides the keys it sets -- the tracked file's other
  // chat field must still apply.
  assert.equal(config.chat.gatewayUrl, "http://127.0.0.1:9001");
});

test("environment values still override the home config's chat section", () => {
  writeDefaultTrackedConfig({ chat: { model: "tracked-model" } });
  const homeConfigPath = path.join(SCRATCH_ROOT, "home-config.json");
  writeHomeConfig(homeConfigPath, { chat: { model: "home-model" } });

  const config = loadVaultCliRuntimeConfig({
    env: {
      MASSA_AI_VAULT_HOME_CONFIG: homeConfigPath,
      MASSA_AI_VAULT_CHAT_MODEL: "env-model"
    }
  });
  assert.equal(config.chat.model, "env-model");
});

test("a non-default configPath gets no home-config injection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-config-"));
  const configPath = path.join(tempDir, "vault-cli.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ chat: { model: "explicit-model" } }), "utf8");

  const homeConfigPath = path.join(SCRATCH_ROOT, "home-config.json");
  writeHomeConfig(homeConfigPath, { chat: { model: "should-not-apply" } });

  const config = loadVaultCliRuntimeConfig({
    configPath,
    env: { MASSA_AI_VAULT_HOME_CONFIG: homeConfigPath }
  });
  assert.equal(config.chat.model, "explicit-model");
});

test("no home config present leaves the tracked config's chat section untouched", () => {
  writeDefaultTrackedConfig({ chat: { model: "tracked-only-model" } });

  const config = loadVaultCliRuntimeConfig({ env: { MASSA_AI_VAULT_HOME_CONFIG: "off" } });
  assert.equal(config.chat.model, "tracked-only-model");
});
