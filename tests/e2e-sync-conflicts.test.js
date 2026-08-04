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

// Why: the conflict recovery loop (sync → quarantine → sync-conflicts →
//      sync-resolve --done → sync) had unit coverage of its git plumbing and
//      state writes but no test driving the real one-shot CLI through a real
//      two-sided rebase conflict — the exact journey the pause alert tells a
//      user to take.
// Impacts: E2E-12 (.specs/features/e2e-extended-journeys/spec.md, carrying
//          the parent P3-G requirement).
// Test: node --test tests/e2e-sync-conflicts.test.js
//
// Same hermeticity boundary as e2e-sync-journey: the notes CLI runs with
// cwd = temp workspace (config path and .automation state are cwd-relative).
// Both divergent commits rewrite the same line of note.md — overlapping
// hunks are what guarantees a content conflict from real git.

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

function runNotesCli(t, workspace, args, name) {
  return spawnChild(
    t,
    process.execPath,
    [repoPath("tools", "notes-automation", "src", "cli.js"), ...args],
    { cwd: workspace, env: childEnv(), name }
  );
}

async function runNotesCliJson(t, workspace, args, name) {
  const cli = runNotesCli(t, workspace, args, name);
  const exit = await cli.waitForExit();
  return { exit, payload: JSON.parse(cli.stdout()), diagnostics: cli.diagnostics };
}

// Fixture order matters (spec Fixture Calibrations): the peer clone is taken
// only after the pre-divergence clean sync has pushed, so bare remote, vault,
// and peer share the protected-artifact .gitignore commit as common ancestor.
async function conflictFixtures(t) {
  const workspace = createTempWorkspace(t, "e2e-conflict");
  const remotePath = path.join(workspace, "remote.git");
  runGit(["init", "--bare", remotePath], workspace);

  const vaultPath = path.join(workspace, "vault");
  runGit(["clone", remotePath, vaultPath], workspace);
  configureUser(vaultPath);
  runGit(["checkout", "-b", "master"], vaultPath);
  fs.writeFileSync(path.join(vaultPath, "note.md"), "base\n", "utf8");
  runGit(["add", "note.md"], vaultPath);
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

  const cleanSync = runNotesCli(t, workspace, ["sync"], "notes-sync-clean");
  const cleanExit = await cleanSync.waitForExit();
  assert.equal(cleanExit.code, 0, cleanSync.diagnostics());

  const peerPath = path.join(workspace, "peer");
  runGit(["clone", remotePath, peerPath], workspace);
  configureUser(peerPath);
  fs.writeFileSync(path.join(peerPath, "note.md"), "remote line\n", "utf8");
  runGit(["add", "note.md"], peerPath);
  runGit(["commit", "-m", "peer edit"], peerPath);
  runGit(["push", "origin", "master"], peerPath);

  fs.writeFileSync(path.join(vaultPath, "note.md"), "local line\n", "utf8");
  runGit(["add", "note.md"], vaultPath);
  runGit(["commit", "-m", "local edit"], vaultPath);

  return { workspace, remotePath, vaultPath };
}

test("diverged sync quarantines the conflict; conflicts/resolve list and clear it", async (t) => {
  const { workspace, remotePath, vaultPath } = await conflictFixtures(t);

  // E2E-12/AC1: the diverged one-shot sync exits non-zero, reports the
  // conflict, and quarantines stage snapshots with the rebase-inverted
  // local/remote roles (stage 2 = remote tip, stage 3 = local commit).
  const conflicted = await runNotesCliJson(t, workspace, ["sync"], "notes-sync-conflict");
  assert.notEqual(conflicted.exit.code, 0, conflicted.diagnostics());
  assert.equal(conflicted.payload.ok, false);
  assert.equal(conflicted.payload.serviceMode, "oneshot");
  assert.equal(conflicted.payload.sync.status, "conflict");
  assert.equal(conflicted.payload.sync.conflictCount, 1);
  assert.equal(conflicted.payload.sync.conflicts[0].filePath, "note.md");

  const quarantineRoot = path.join(vaultPath, ".automation", "sync-conflicts");
  const captures = fs.readdirSync(quarantineRoot);
  assert.equal(captures.length, 1, `expected one quarantine capture, saw: ${captures}`);
  const captureDir = path.join(quarantineRoot, captures[0]);
  // Stage snapshots come back trimmed (the git capture helper trims all
  // command output — tools/notes-automation/src/infrastructure/git.js).
  assert.equal(
    fs.readFileSync(path.join(captureDir, "note.md.remote.txt"), "utf8"),
    "remote line"
  );
  assert.equal(
    fs.readFileSync(path.join(captureDir, "note.md.local.txt"), "utf8"),
    "local line"
  );
  assert.equal(
    fs.readFileSync(path.join(captureDir, "note.md.base.txt"), "utf8"),
    "base"
  );
  assert.equal(fs.existsSync(path.join(captureDir, "note.md.worktree.txt")), true);
  assert.equal(fs.existsSync(path.join(captureDir, "summary.json")), true);
  // Rebase aborted: the vault is back on the local commit, not half-rebased.
  assert.equal(fs.readFileSync(path.join(vaultPath, "note.md"), "utf8"), "local line\n");

  // E2E-12/AC2: sync-conflicts exits 0 and lists the conflict (ok carries
  // the signal, not the exit code).
  const listed = await runNotesCliJson(t, workspace, ["sync-conflicts"], "notes-conflicts");
  assert.equal(listed.exit.code, 0, listed.diagnostics());
  assert.equal(listed.payload.ok, true);
  assert.equal(listed.payload.sync.status, "conflict");
  assert.equal(listed.payload.sync.conflicts[0].filePath, "note.md");

  // E2E-12/AC3: sync-resolve without --done exits non-zero with the guide.
  const guide = await runNotesCliJson(t, workspace, ["sync-resolve"], "notes-resolve-guide");
  assert.notEqual(guide.exit.code, 0, guide.diagnostics());
  assert.ok(String(guide.payload.message).includes("sync resolve --done"), guide.payload.message);
  assert.ok(guide.payload.conflictRootHint, "expected a conflictRootHint");

  // E2E-12/AC4: after the user resolves the divergence, --done clears the
  // conflict state and the pipeline is actually unblocked.
  runGit(["reset", "--hard", "origin/master"], vaultPath);

  const done = await runNotesCliJson(t, workspace, ["sync-resolve", "--done"], "notes-resolve-done");
  assert.equal(done.exit.code, 0, done.diagnostics());
  assert.ok(String(done.payload.message).includes("Conflict state cleared"), done.payload.message);

  const cleared = await runNotesCliJson(t, workspace, ["sync-conflicts"], "notes-conflicts-cleared");
  assert.equal(cleared.exit.code, 0, cleared.diagnostics());
  assert.equal(cleared.payload.ok, false);
  assert.equal(cleared.payload.sync.conflictCount, 0);

  const resumed = await runNotesCliJson(t, workspace, ["sync"], "notes-sync-resumed");
  assert.equal(resumed.exit.code, 0, resumed.diagnostics());
  assert.equal(resumed.payload.sync.status, "idle");
  assert.equal(fs.readFileSync(path.join(vaultPath, "note.md"), "utf8"), "remote line\n");
  assert.equal(runGit(["rev-parse", "master"], remotePath), runGit(["rev-parse", "HEAD"], vaultPath));
  // Quarantine artifacts never reach the remote (protected .automation/).
  const remoteFiles = runGit(["ls-tree", "-r", "--name-only", "master"], remotePath);
  assert.equal(remoteFiles.includes(".automation"), false, remoteFiles);
});
