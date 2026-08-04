import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadServerConfig } from "../tools/server/src/infrastructure/config.js";
import { loadVaultCliRuntimeConfig } from "../tools/shared/vault-cli-config.js";

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-config-"));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("server config is file-first and normalizes supervisor paths and services", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "server.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          state_path: "state/server.json",
          pid_path: "state/server.pid",
          log_dir: "logs",
          services: {
            litellm: {
              enabled: true,
              command: "node",
              args: ["fake-litellm.js"],
              health_url: "http://127.0.0.1:4999/health"
            },
            "router-gateway": {
              enabled: false
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const config = loadServerConfig({ configPath, env: {} });
    assert.equal(config.configPath, configPath);
    assert.equal(config.statePath, path.join(tempDir, "state/server.json"));
    assert.equal(config.pidPath, path.join(tempDir, "state/server.pid"));
    assert.equal(config.logDir, path.join(tempDir, "logs"));
    assert.equal(config.services[0].name, "litellm");
    assert.equal(config.services[0].command, "node");
    assert.deepEqual(config.services[0].args, ["fake-litellm.js"]);
    assert.equal(config.services[1].name, "router-gateway");
    assert.equal(config.services[1].enabled, false);
  });
});

test("server config preserves env overrides for local runtime ports and paths", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "server.config.json");
    fs.writeFileSync(configPath, JSON.stringify({ services: {} }), "utf8");

    const config = loadServerConfig({
      configPath,
      env: {
        MASSA_AI_VAULT_SERVER_STATE_PATH: path.join(tempDir, "state.json"),
        MASSA_AI_VAULT_SERVER_LOG_DIR: path.join(tempDir, "logs"),
        ROUTER_GATEWAY_PORT: "4111",
        MCP_SERVER_PORT: "4222"
      }
    });

    assert.equal(config.statePath, path.join(tempDir, "state.json"));
    assert.equal(config.logDir, path.join(tempDir, "logs"));
    assert.equal(
      config.services.find((service) => service.name === "router-gateway").healthUrl,
      "http://127.0.0.1:4111/health"
    );
    assert.equal(
      config.services.find((service) => service.name === "mcp-server").healthUrl,
      "http://127.0.0.1:4222/health"
    );
  });
});

test("vault CLI config reads JSON defaults with env overrides for chat settings", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "vault-cli.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        notes_config_path: "config/custom-notes.json",
        chat: {
          gateway_url: "http://127.0.0.1:4105",
          model: "smart-router-custom",
          rag_enabled: false,
          idle_sync_ms: 1234
        }
      }),
      "utf8"
    );

    const config = loadVaultCliRuntimeConfig({
      configPath,
      env: {
        MASSA_AI_VAULT_CHAT_GATEWAY_URL: "http://127.0.0.1:4999",
        MASSA_AI_VAULT_CHAT_RAG: "on"
      }
    });

    assert.equal(config.notesConfigPath, path.join(tempDir, "config/custom-notes.json"));
    assert.equal(config.chat.gatewayUrl, "http://127.0.0.1:4999");
    assert.equal(config.chat.model, "smart-router-custom");
    assert.equal(config.chat.ragEnabled, true);
    assert.equal(config.chat.idleSyncMs, 1234);
  });
});
