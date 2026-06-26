import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const VAULT_CLI = path.resolve("tools/cli.js");

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-exec-"));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runVaultCli(args, env) {
  const result = spawnSync(process.execPath, [VAULT_CLI, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: Number(result.status),
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

test("vault status delegates to massa-vault-server status JSON", () => {
  withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "server.config.json");
    const statePath = path.join(tempDir, "server-state.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        state_path: statePath,
        pid_path: path.join(tempDir, "server.pid"),
        services: {
          litellm: { enabled: false },
          "router-gateway": { enabled: false },
          "mcp-server": { enabled: false },
          "notes-automation": { enabled: false }
        }
      }),
      "utf8"
    );

    const result = runVaultCli(["status", "--json"], {
      MASSA_VAULT_SERVER_CONFIG_PATH: configPath
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.running, false);
    assert.equal(payload.statePath, statePath);
    assert.equal(payload.services.length, 4);
  });
});
