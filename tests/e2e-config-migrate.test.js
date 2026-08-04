import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createTempWorkspace,
  repoPath,
  spawnChild
} from "./helpers/e2e-harness.js";

// Why: `config migrate` is the documented escape hatch off deprecated .env
//      files; nothing exercised the real command against a real .env, local
//      notes config, and home-config write.
// Impacts: E2E-10 (.specs/features/e2e-test-suite/spec.md).
// Test: node --test tests/e2e-config-migrate.test.js
//
// This is the one journey WITHOUT the kill-switches: migrate must read .env
// and write the home config for real. Isolation comes from redirecting
// XDG_CONFIG_HOME and HOME into the temp workspace instead.

function migrateEnv(workspace) {
  const env = { ...process.env };
  delete env.MASSA_VAULT_HOME_CONFIG;
  delete env.MASSA_VAULT_ENV_FILE;
  delete env.VAULT_PATH;
  env.XDG_CONFIG_HOME = path.join(workspace, "xdg");
  env.HOME = path.join(workspace, "home");
  return env;
}

function migrateFixtures(t) {
  const workspace = createTempWorkspace(t, "e2e-migrate");
  const vaultDir = path.join(workspace, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".env"),
    "ROUTER_GATEWAY_PORT=4321\nMASSA_VAULT_CHAT_MODEL=e2e-migrated\n",
    "utf8"
  );
  fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "config", "notes-automation.local.json"),
    JSON.stringify({ vault_path: vaultDir }),
    "utf8"
  );
  return { workspace, vaultDir };
}

function runConfigCli(t, workspace, args, name) {
  return spawnChild(t, process.execPath, [repoPath("tools", "cli.js"), "config", ...args], {
    cwd: workspace,
    env: migrateEnv(workspace),
    name
  });
}

test("migrate builds the home config from .env and refuses to clobber without --force", async (t) => {
  const { workspace, vaultDir } = migrateFixtures(t);
  const targetPath = path.join(workspace, "xdg", "massa-ai-vault", "config.json");

  const migrate = runConfigCli(t, workspace, ["migrate"], "config-migrate");
  const exit = await migrate.waitForExit();

  // E2E-10: the home config exists under the redirected XDG root with the
  // .env values projected into their document paths.
  assert.equal(exit.code, 0, migrate.diagnostics());
  assert.ok(fs.existsSync(targetPath), migrate.diagnostics());
  const document = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  assert.equal(String(document.router.gateway_port), "4321");
  assert.equal(document.chat.model, "e2e-migrated");
  assert.ok(JSON.stringify(document).includes(vaultDir));

  // E2E-10: `config path` agrees on the resolved location.
  const pathCmd = runConfigCli(t, workspace, ["path"], "config-path");
  const pathExit = await pathCmd.waitForExit();
  assert.equal(pathExit.code, 0, pathCmd.diagnostics());
  assert.ok(pathCmd.stdout().includes(targetPath), pathCmd.diagnostics());

  // E2E-10: a second migrate without --force refuses and leaves the file
  // byte-identical.
  const before = fs.readFileSync(targetPath, "utf8");
  const again = runConfigCli(t, workspace, ["migrate"], "config-migrate-again");
  const againExit = await again.waitForExit();
  assert.notEqual(againExit.code, 0, again.diagnostics());
  assert.ok(again.stderr().includes("refusing to overwrite"), again.diagnostics());
  assert.equal(fs.readFileSync(targetPath, "utf8"), before);
});
