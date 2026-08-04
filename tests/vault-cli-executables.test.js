import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const VAULT_CLI = path.resolve("tools/cli.js");
const ENV_DEPRECATION_NOTICE =
  "mav: loading configuration from .env is deprecated; run `mav config migrate` to move it to the home config.";

// This spawns real subprocesses (tools/cli.js proxying to tools/server/src/cli.js)
// inheriting this repo's actual cwd and env. When a developer has a real .env
// checked out locally, each process that loads it now emits one deprecation
// line (R5) -- expected, not an error. Assert every stderr line is that exact
// notice rather than requiring empty stderr, so the test passes identically
// whether or not a local .env is present.
function assertOnlyExpectedStderr(stderr) {
  const lines = stderr.split("\n").filter(Boolean);
  for (const line of lines) {
    assert.equal(line, ENV_DEPRECATION_NOTICE);
  }
}

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-exec-"));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runVaultCli(args, env) {
  // This spawns a real subprocess that loads its own runtime env (R2/T9):
  // without forcing MASSA_AI_VAULT_HOME_CONFIG=off, a developer machine with a
  // real, populated ~/.config/massa-ai-vault/config.json would leak that
  // file's settings into the child, making this test's outcome depend on
  // whether the file exists.
  const result = spawnSync(process.execPath, [VAULT_CLI, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, MASSA_AI_VAULT_HOME_CONFIG: "off", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: Number(result.status),
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

test("vault cli emits the exact .env deprecation notice when a legacy .env is present", () => {
  // Plants a .env in a temp cwd so the notice fires deterministically,
  // independent of whether the developer's checkout has one -- this is the
  // content-level sensor on the notice string itself (validation mutant C).
  withTempDir((tempDir) => {
    fs.writeFileSync(path.join(tempDir, ".env"), "MASSA_AI_VAULT_CHAT_MODEL=from-env\n", "utf8");
    const env = { ...process.env, MASSA_AI_VAULT_HOME_CONFIG: "off" };
    delete env.MASSA_AI_VAULT_ENV_FILE;
    const result = spawnSync(process.execPath, [VAULT_CLI, "config", "path"], {
      cwd: tempDir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.equal(Number(result.status), 0);
    const stderrLines = String(result.stderr || "").trim().split("\n").filter(Boolean);
    assert.deepEqual(stderrLines, [ENV_DEPRECATION_NOTICE]);
  });
});

test("vault status delegates to mavs status JSON", () => {
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
      MASSA_AI_VAULT_SERVER_CONFIG_PATH: configPath
    });
    assert.equal(result.status, 0);
    assertOnlyExpectedStderr(result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.running, false);
    assert.equal(payload.statePath, statePath);
    assert.equal(payload.services.length, 4);
  });
});
