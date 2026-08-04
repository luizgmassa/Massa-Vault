import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  childEnv,
  createTempWorkspace,
  repoPath,
  spawnChild
} from "./helpers/e2e-harness.js";

// Why: the sync pipeline (commit -> pull/rebase -> push) had unit coverage of
//      its git plumbing but no test running the real one-shot CLI against a
//      real remote — the journey a user's `vault sync` actually takes.
// Impacts: E2E-05 (.specs/features/e2e-test-suite/spec.md).
// Test: node --test tests/e2e-sync-journey.test.js
//
// The notes CLI runs with cwd = temp workspace: its config path and state dir
// (.automation/notes-automation) are cwd-relative with no env override, so the
// temp cwd is both the config mechanism and the hermeticity boundary.

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

function configureUser(dir) {
  runGit(["config", "user.name", "Test Bot"], dir);
  runGit(["config", "user.email", "test@example.com"], dir);
}

function syncFixtures(t) {
  const workspace = createTempWorkspace(t, "e2e-sync");
  const remotePath = path.join(workspace, "remote.git");
  runGit(["init", "--bare", remotePath], workspace);

  const vaultPath = path.join(workspace, "vault");
  runGit(["clone", remotePath, vaultPath], workspace);
  configureUser(vaultPath);
  runGit(["checkout", "-b", "master"], vaultPath);
  fs.writeFileSync(path.join(vaultPath, "seed.md"), "seed\n", "utf8");
  runGit(["add", "seed.md"], vaultPath);
  runGit(["commit", "-m", "seed"], vaultPath);
  runGit(["push", "-u", "origin", "master"], vaultPath);

  fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "config", "notes-automation.config.json"),
    JSON.stringify({
      enabled: true,
      vault_path: vaultPath,
      sync_strategy: "git",
      git_auto_push: true
    }),
    "utf8"
  );
  return { workspace, remotePath, vaultPath };
}

function runSyncCli(t, workspace, name) {
  return spawnChild(
    t,
    process.execPath,
    [repoPath("tools", "notes-automation", "src", "cli.js"), "sync"],
    { cwd: workspace, env: childEnv(), name }
  );
}

test("sync commits and pushes the note; unchanged re-run is a no-op", async (t) => {
  const { workspace, remotePath, vaultPath } = syncFixtures(t);
  fs.writeFileSync(path.join(vaultPath, "new-note.md"), "fresh thought\n", "utf8");

  const sync = runSyncCli(t, workspace, "notes-sync");
  const exit = await sync.waitForExit();

  // E2E-05: the one-shot CLI (daemon absent, standalone path) lands the note
  // on the real remote.
  assert.equal(exit.code, 0, sync.diagnostics());
  const remoteFiles = runGit(["ls-tree", "-r", "--name-only", "master"], remotePath);
  assert.ok(remoteFiles.includes("new-note.md"), remoteFiles);
  const remoteHead = runGit(["rev-parse", "master"], remotePath);
  const localHead = runGit(["rev-parse", "HEAD"], vaultPath);
  assert.equal(remoteHead, localHead);

  const rerun = runSyncCli(t, workspace, "notes-sync-noop");
  const rerunExit = await rerun.waitForExit();

  // E2E-05: an unchanged vault produces no further commit — same remote head.
  assert.equal(rerunExit.code, 0, rerun.diagnostics());
  assert.equal(runGit(["rev-parse", "master"], remotePath), remoteHead);
});
