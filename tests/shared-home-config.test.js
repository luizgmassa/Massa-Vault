import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOME_CONFIG_ENV_MAP,
  applyHomeConfigEnv,
  buildHomeConfigDocument,
  projectHomeConfigEnv,
  readHomeConfig,
  readHomeConfigSection,
  resolveHomeConfigPath
} from "../tools/shared/home-config.js";

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-home-config-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const SAMPLE_HOMEDIR = "/home/example-user";

test("resolveHomeConfigPath defaults to ~/.config/massa-ai-vault/config.json", () => {
  const resolved = resolveHomeConfigPath({ env: {}, homedir: () => SAMPLE_HOMEDIR });
  assert.equal(resolved, path.join(SAMPLE_HOMEDIR, ".config", "massa-ai-vault", "config.json"));
});

test("resolveHomeConfigPath honours XDG_CONFIG_HOME", () => {
  const resolved = resolveHomeConfigPath({
    env: { XDG_CONFIG_HOME: "/xdg/config" },
    homedir: () => SAMPLE_HOMEDIR
  });
  assert.equal(resolved, path.join("/xdg/config", "massa-ai-vault", "config.json"));
});

test("resolveHomeConfigPath honours MASSA_VAULT_HOME_CONFIG as an explicit path override", () => {
  const resolved = resolveHomeConfigPath({
    env: { MASSA_VAULT_HOME_CONFIG: "/explicit/path/config.json" },
    homedir: () => SAMPLE_HOMEDIR
  });
  assert.equal(resolved, path.resolve("/explicit/path/config.json"));
});

test("resolveHomeConfigPath returns null when MASSA_VAULT_HOME_CONFIG is off", () => {
  const resolved = resolveHomeConfigPath({
    env: { MASSA_VAULT_HOME_CONFIG: "off" },
    homedir: () => SAMPLE_HOMEDIR
  });
  assert.equal(resolved, null);
});

test("resolveHomeConfigPath returns null when MASSA_VAULT_HOME_CONFIG is an empty string", () => {
  const resolved = resolveHomeConfigPath({
    env: { MASSA_VAULT_HOME_CONFIG: "" },
    homedir: () => SAMPLE_HOMEDIR
  });
  assert.equal(resolved, null);
});

test("projectHomeConfigEnv projects every mapped leaf to its env key", () => {
  const document = {
    litellm: { master_key: "sk-test", config_path: "/lite/config.yaml" },
    router: {
      gateway_host: "0.0.0.0",
      gateway_port: 4100,
      litellm_base_url: "http://127.0.0.1:4000",
      policy_path: "/router/policy.json",
      require_smart_router_model: false
    },
    server: {
      config_path: "/server/config.json",
      state_path: "/server/state.json",
      pid_path: "/server/pid",
      log_dir: "/server/logs"
    },
    mcp: { config_path: "/mcp/config.json", host: "127.0.0.1", port: 4200 },
    chat: {
      gateway_url: "http://127.0.0.1:4100",
      model: "smart-router",
      rag_enabled: true,
      idle_sync_ms: 30000,
      system_prompt: "be terse",
      ollama_url: "http://127.0.0.1:11434",
      embed_model: "embeddinggemma",
      cli_config_path: "/chat/cli.json",
      notes_config_path: "/chat/notes.json"
    }
  };

  const projected = projectHomeConfigEnv(document);

  assert.equal(Object.keys(projected).length, HOME_CONFIG_ENV_MAP.size);
  for (const envKey of HOME_CONFIG_ENV_MAP.values()) {
    assert.equal(typeof projected[envKey], "string", `expected ${envKey} to project`);
  }
  assert.equal(projected.LITELLM_MASTER_KEY, "sk-test");
  assert.equal(projected.ROUTER_GATEWAY_PORT, "4100");
  assert.equal(projected.ROUTER_GATEWAY_REQUIRE_SMART_ROUTER_MODEL, "false");
  assert.equal(projected.MASSA_VAULT_CHAT_SYSTEM_PROMPT, "be terse");
});

test("projectHomeConfigEnv treats null, undefined, and empty string as absent", () => {
  const document = {
    litellm: { master_key: null, config_path: undefined },
    router: { gateway_host: "", policy_path: "  " }
  };

  const projected = projectHomeConfigEnv(document);
  assert.equal("LITELLM_MASTER_KEY" in projected, false);
  assert.equal("LITELLM_CONFIG_PATH" in projected, false);
  assert.equal("ROUTER_GATEWAY_HOST" in projected, false);
  assert.equal(projected.ROUTER_POLICY_PATH, "  ");
});

test("projectHomeConfigEnv returns an empty object for a non-object document", () => {
  assert.deepEqual(projectHomeConfigEnv(null), {});
  assert.deepEqual(projectHomeConfigEnv(undefined), {});
  assert.deepEqual(projectHomeConfigEnv("not an object"), {});
});

test("readHomeConfig returns loaded:false when the file does not exist", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    const result = readHomeConfig({ configPath });
    assert.equal(result.loaded, false);
    assert.deepEqual(result.document, {});
  });
});

test("readHomeConfig reads and parses a valid home config file", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, chat: { model: "custom" } }), "utf8");

    const result = readHomeConfig({ configPath });
    assert.equal(result.loaded, true);
    assert.equal(result.path, configPath);
    assert.deepEqual(result.document.chat, { model: "custom" });
  });
});

test("readHomeConfig degrades to loaded:false and warns on malformed JSON instead of throwing", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, "{ not valid json", "utf8");

    let warned = "";
    const fakeStderr = { write: (chunk) => { warned += chunk; } };

    const result = readHomeConfig({ configPath, stderr: fakeStderr });
    assert.equal(result.loaded, false);
    assert.deepEqual(result.document, {});
    assert.match(warned, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("applyHomeConfigEnv sets unset keys and never overrides an already-set key", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        chat: { model: "from-home-config", gateway_url: "http://127.0.0.1:4100" }
      }),
      "utf8"
    );

    const env = {
      MASSA_VAULT_HOME_CONFIG: configPath,
      MASSA_VAULT_CHAT_MODEL: "already-set-by-shell"
    };

    const result = applyHomeConfigEnv({ env, homedir: () => SAMPLE_HOMEDIR });
    assert.equal(result.loaded, true);
    assert.equal(env.MASSA_VAULT_CHAT_MODEL, "already-set-by-shell");
    assert.equal(env.MASSA_VAULT_CHAT_GATEWAY_URL, "http://127.0.0.1:4100");
  });
});

test("applyHomeConfigEnv is a no-op when disabled", () => {
  const env = { MASSA_VAULT_HOME_CONFIG: "off" };
  const result = applyHomeConfigEnv({ env, homedir: () => SAMPLE_HOMEDIR });
  assert.equal(result.loaded, false);
  assert.equal(result.setCount, 0);
});

test("readHomeConfigSection returns the named section or {} when absent", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ notes: { vault_path: "/tmp/vault", sync_strategy: "both" } }),
      "utf8"
    );

    const env = { MASSA_VAULT_HOME_CONFIG: configPath };
    assert.deepEqual(readHomeConfigSection("notes", { env, homedir: () => SAMPLE_HOMEDIR }), {
      vault_path: "/tmp/vault",
      sync_strategy: "both"
    });
    assert.deepEqual(readHomeConfigSection("chat", { env, homedir: () => SAMPLE_HOMEDIR }), {});
  });
});

test("readHomeConfigSection returns {} when the home config is disabled", () => {
  const env = { MASSA_VAULT_HOME_CONFIG: "off" };
  assert.deepEqual(readHomeConfigSection("notes", { env, homedir: () => SAMPLE_HOMEDIR }), {});
});

test("buildHomeConfigDocument builds the nested document from a flat env map", () => {
  const document = buildHomeConfigDocument({
    envValues: {
      LITELLM_MASTER_KEY: "sk-live",
      MASSA_VAULT_CHAT_MODEL: "smart-router",
      MASSA_VAULT_CHAT_RAG: ""
    },
    localNotesDocument: { vault_path: "/tmp/vault", sync_strategy: "both" }
  });

  assert.equal(document.version, 1);
  assert.equal(document.litellm.master_key, "sk-live");
  assert.equal(document.chat.model, "smart-router");
  assert.equal("rag_enabled" in document.chat, false);
  assert.deepEqual(document.notes, { vault_path: "/tmp/vault", sync_strategy: "both" });
});

test("buildHomeConfigDocument omits the notes section when no local document is given", () => {
  const document = buildHomeConfigDocument({ envValues: { LITELLM_MASTER_KEY: "sk-live" } });
  assert.equal("notes" in document, false);
});

test("buildHomeConfigDocument is the inverse of projectHomeConfigEnv for mapped leaves", () => {
  const envValues = {};
  let i = 0;
  for (const envKey of HOME_CONFIG_ENV_MAP.values()) {
    envValues[envKey] = `value-${i}`;
    i += 1;
  }

  const document = buildHomeConfigDocument({ envValues });
  const roundTripped = projectHomeConfigEnv(document);
  assert.deepEqual(roundTripped, envValues);
});
