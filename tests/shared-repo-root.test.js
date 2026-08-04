import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertRepoRootCwd } from "../tools/shared/repo-root.js";

const REPO_ROOT = path.resolve();

test("assertRepoRootCwd allows the repo root and any cwd outside the repo", () => {
  assert.doesNotThrow(() => assertRepoRootCwd({ cwd: REPO_ROOT }));
  assert.doesNotThrow(() => assertRepoRootCwd({ cwd: os.tmpdir() }));
});

test("assertRepoRootCwd rejects a repo subdirectory", () => {
  assert.throws(
    () => assertRepoRootCwd({ cwd: path.join(REPO_ROOT, "tools") }),
    /run this command from the repo root/
  );
});

test("vault cli invoked from a repo subdirectory fails fast instead of creating stray state", () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "tools", "cli.js"), "status"], {
    cwd: path.join(REPO_ROOT, "tools"),
    env: { ...process.env, MASSA_AI_VAULT_HOME_CONFIG: "off" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr || ""), /run this command from the repo root/);
});
