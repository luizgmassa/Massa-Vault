import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isLocalBindHost,
  loadMcpRuntimeConfig,
  DEFAULT_MCP_PATH,
  DEFAULT_MCP_SERVER_PORT,
  DEFAULT_MCP_SERVER_HOST
} from "../tools/mcp-server/src/infrastructure/runtime-config.js";

const ENV_KEYS = ["MCP_SERVER_CONFIG_PATH", "MCP_SERVER_HOST", "MCP_SERVER_PORT"];

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runtime-config-"));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withEnv(overrides, run) {
  const original = {};
  for (const key of ENV_KEYS) original[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

function writeConfig(tempDir, document) {
  const configPath = path.join(tempDir, "mcp-server.config.json");
  fs.writeFileSync(configPath, JSON.stringify(document), "utf8");
  return configPath;
}

// --- isLocalBindHost ---

test("isLocalBindHost accepts loopback hosts, including case and whitespace variants", () => {
  assert.equal(isLocalBindHost("127.0.0.1"), true);
  assert.equal(isLocalBindHost("localhost"), true);
  assert.equal(isLocalBindHost("LOCALHOST"), true);
  assert.equal(isLocalBindHost("::1"), true);
  assert.equal(isLocalBindHost("  127.0.0.1  "), true);
  assert.equal(isLocalBindHost("  localhost  "), true);
});

test("isLocalBindHost rejects non-loopback hosts and empty/missing values", () => {
  assert.equal(isLocalBindHost("0.0.0.0"), false);
  assert.equal(isLocalBindHost("example.com"), false);
  assert.equal(isLocalBindHost(""), false);
  assert.equal(isLocalBindHost(null), false);
  assert.equal(isLocalBindHost(undefined), false);
});

// --- loadMcpRuntimeConfig: guard behavior ---

test("loadMcpRuntimeConfig throws when the config host field is non-local", () => {
  withTempDir((tempDir) => {
    const configPath = writeConfig(tempDir, { host: "0.0.0.0" });
    withEnv({ MCP_SERVER_CONFIG_PATH: configPath, MCP_SERVER_HOST: undefined, MCP_SERVER_PORT: undefined }, () => {
      assert.throws(() => loadMcpRuntimeConfig(), /must bind to localhost/);
    });
  });
});

test("loadMcpRuntimeConfig throws when MCP_SERVER_HOST env is non-local, even with a local config host (env precedence)", () => {
  withTempDir((tempDir) => {
    const configPath = writeConfig(tempDir, { host: "127.0.0.1" });
    withEnv({ MCP_SERVER_CONFIG_PATH: configPath, MCP_SERVER_HOST: "0.0.0.0", MCP_SERVER_PORT: undefined }, () => {
      assert.throws(() => loadMcpRuntimeConfig(), /must bind to localhost/);
    });
  });
});

// --- loadMcpRuntimeConfig: full normalized shape ---

test("loadMcpRuntimeConfig normalizes a fully-specified local config", () => {
  withTempDir((tempDir) => {
    const configPath = writeConfig(tempDir, {
      host: "localhost",
      port: 5300,
      mcp_path: "custom-path",
      source_library_path: ".automation/mcp-server/custom-library.json",
      allowed_origins: ["http://EXAMPLE.com/", "not a valid url"],
      auth: {
        username: "tester",
        password: "fake-test-password-123",
        access_token_ttl_seconds: 120,
        refresh_token_ttl_seconds: 999
      },
      sources: {
        default_search_limit: 3,
        max_search_limit: 9,
        max_source_text_chars: 4000
      },
      answer_sessions: { ttl_seconds: 42 }
    });

    withEnv({ MCP_SERVER_CONFIG_PATH: configPath, MCP_SERVER_HOST: undefined, MCP_SERVER_PORT: undefined }, () => {
      const config = loadMcpRuntimeConfig();

      assert.equal(config.configPath, path.resolve(configPath));
      assert.equal(config.host, "localhost");
      assert.equal(config.port, 5300);
      assert.equal(config.mcpPath, "/custom-path");
      assert.equal(
        config.sourceLibraryPath,
        path.resolve(".automation/mcp-server/custom-library.json")
      );
      assert.deepEqual(config.allowedOrigins, ["http://example.com", "not a valid url"]);
      assert.equal(config.auth.username, "tester");
      assert.equal(config.auth.password, "fake-test-password-123");
      assert.equal(config.auth.accessTokenTtlMs, 120 * 1000);
      assert.equal(config.auth.refreshTokenTtlMs, 999 * 1000);
      assert.equal(config.sources.defaultSearchLimit, 3);
      assert.equal(config.sources.maxSearchLimit, 9);
      assert.equal(config.sources.maxSourceTextChars, 4000);
      assert.equal(config.answerSessions.ttlMs, 42 * 1000);
    });
  });
});

test("loadMcpRuntimeConfig applies documented defaults for a minimal local config", () => {
  withTempDir((tempDir) => {
    const configPath = writeConfig(tempDir, { host: "127.0.0.1" });

    withEnv({ MCP_SERVER_CONFIG_PATH: configPath, MCP_SERVER_HOST: undefined, MCP_SERVER_PORT: undefined }, () => {
      const config = loadMcpRuntimeConfig();

      assert.equal(config.host, DEFAULT_MCP_SERVER_HOST);
      assert.equal(config.port, DEFAULT_MCP_SERVER_PORT);
      assert.equal(config.mcpPath, DEFAULT_MCP_PATH);
      assert.equal(
        config.sourceLibraryPath,
        path.resolve(".automation/mcp-server/source-library.json")
      );
      assert.deepEqual(config.allowedOrigins, ["http://127.0.0.1", "http://localhost"]);
      assert.equal(config.auth.username, "admin");
      assert.equal(config.auth.password, "admin");
      assert.equal(config.auth.accessTokenTtlMs, 3600 * 1000);
      assert.equal(config.auth.refreshTokenTtlMs, 86400 * 1000);
      assert.equal(config.sources.defaultSearchLimit, 5);
      assert.equal(config.sources.maxSearchLimit, 20);
      assert.equal(config.sources.maxSourceTextChars, 12000);
      assert.equal(config.answerSessions.ttlMs, 7200 * 1000);
    });
  });
});
