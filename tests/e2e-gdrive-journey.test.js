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

// Why: the "both" strategy (git + Drive) had unit coverage of the rclone
//      adapter and the import classifier, but no test driving real sync CLI
//      runs through the whole cooperation: pre-gdrive snapshot push, bisync
//      via a real rclone subprocess, the first-run dangerous-import safety
//      hold (the adapter's own first-run marker is a new internal artifact
//      vs the pre-bisync baseline, so run 1 always pauses and withholds the
//      push — shipped behavior, STATE.md follow-up), and the next run's
//      snapshot prePush carrying the held import commit out.
// Impacts: E2E-13 (.specs/features/e2e-extended-journeys/spec.md, carrying
//          the parent P3-G requirement).
// Test: node --test tests/e2e-gdrive-journey.test.js
//
// The gdrive boundary is a fake rclone (temp .mjs, chmod 0o755 — execFileSync
// runs it via shebang, no shell) that logs every invocation to
// FAKE_RCLONE_STATE and materializes one Drive-originated note on bisync.
// The vault seeds 12 committed notes so percent-based classification stays
// out of play (1 import = 8.33% of baseline, below the 10% threshold) and
// the dangerous verdict is attributable to the marker self-import alone.

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

function writeFakeRclone(workspace) {
  const scriptPath = path.join(workspace, "fake-rclone.mjs");
  const script = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const logPath = process.env.FAKE_RCLONE_STATE;
const command = process.argv[2] || "";
const args = process.argv.slice(3);
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ command, args }) + "\\n", "utf8");
}

if (command === "listremotes") {
  process.stdout.write("Personal:\\n");
  process.exit(0);
}
if (command === "delete") {
  process.exit(0);
}
if (command === "bisync") {
  const imported = path.join(args[0], "gdrive-note.md");
  if (!fs.existsSync(imported)) {
    fs.writeFileSync(imported, "from drive\\n", "utf8");
  }
  process.stdout.write("bisync ok\\n");
  process.exit(0);
}
process.stderr.write("unsupported command: " + command + "\\n");
process.exit(2);
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function gdriveFixtures(t) {
  const workspace = createTempWorkspace(t, "e2e-gdrive");
  const remotePath = path.join(workspace, "remote.git");
  runGit(["init", "--bare", remotePath], workspace);

  const vaultPath = path.join(workspace, "vault");
  runGit(["clone", remotePath, vaultPath], workspace);
  configureUser(vaultPath);
  runGit(["checkout", "-b", "master"], vaultPath);
  for (let i = 1; i <= 12; i += 1) {
    const name = `note-${String(i).padStart(2, "0")}.md`;
    fs.writeFileSync(path.join(vaultPath, name), `seed ${i}\n`, "utf8");
  }
  runGit(["add", "."], vaultPath);
  runGit(["commit", "-m", "seed"], vaultPath);
  runGit(["push", "-u", "origin", "master"], vaultPath);

  const fakeRclonePath = writeFakeRclone(workspace);
  const rcloneLogPath = path.join(workspace, "rclone-log.jsonl");

  fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "config", "notes-automation.config.json"),
    JSON.stringify({
      enabled: true,
      vault_path: vaultPath,
      sync_strategy: "both",
      git_auto_push: true,
      gdrive_remote_path: "Personal:Obsidian",
      gdrive_binary: fakeRclonePath,
      gdrive_resync_mode: "newer"
    }),
    "utf8"
  );
  return { workspace, remotePath, vaultPath, rcloneLogPath };
}

function readRcloneLog(rcloneLogPath) {
  return fs
    .readFileSync(rcloneLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runSyncCliJson(t, workspace, rcloneLogPath, name) {
  const cli = spawnChild(
    t,
    process.execPath,
    [repoPath("tools", "notes-automation", "src", "cli.js"), "sync"],
    { cwd: workspace, env: childEnv({ FAKE_RCLONE_STATE: rcloneLogPath }), name }
  );
  const exit = await cli.waitForExit();
  return { exit, payload: JSON.parse(cli.stdout()), diagnostics: cli.diagnostics };
}

test("both-mode sync holds the first gdrive import for review, then pushes it", async (t) => {
  const { workspace, remotePath, vaultPath, rcloneLogPath } = gdriveFixtures(t);
  fs.writeFileSync(path.join(vaultPath, "local-note.md"), "fresh thought\n", "utf8");

  // E2E-13/AC1: first run — snapshot prePush lands the local note, first-run
  // --resync bisync imports the Drive note, and the adapter-written marker
  // triggers the dangerous-import safety hold: commit locally, withhold push.
  const first = await runSyncCliJson(t, workspace, rcloneLogPath, "notes-sync-both");
  assert.notEqual(first.exit.code, 0, first.diagnostics());
  assert.equal(first.payload.sync.status, "paused");
  assert.equal(first.payload.sync.gdriveImport, "dangerous");
  assert.equal(first.payload.sync.reviewNeeded, true);
  assert.ok(
    first.payload.sync.gdriveImportSummary.reasons.includes("internal_artifact_imported"),
    JSON.stringify(first.payload.sync.gdriveImportSummary)
  );
  assert.match(String(first.payload.sync.alert), /dangerous Google Drive import/);

  const firstRunLog = readRcloneLog(rcloneLogPath);
  assert.deepEqual(
    firstRunLog.map((entry) => entry.command),
    ["listremotes", "delete", "bisync"]
  );
  const bisync = firstRunLog[2];
  assert.equal(bisync.args[0], vaultPath);
  assert.equal(bisync.args[1], "Personal:Obsidian");
  assert.ok(bisync.args.includes("--resync"), bisync.args.join(" "));
  assert.equal(bisync.args[bisync.args.indexOf("--resync-mode") + 1], "newer");
  assert.ok(bisync.args.includes(".automation/**"), bisync.args.join(" "));
  assert.ok(bisync.args.includes(".logs/**"), bisync.args.join(" "));
  assert.equal(
    fs.existsSync(path.join(vaultPath, ".automation", "gdrive-resync.done")),
    true
  );

  // Held locally: the import commit exists in the vault but never reached
  // the remote — the discriminating half of the safety hold.
  assert.equal(
    runGit(["log", "-1", "--format=%s", "HEAD"], vaultPath),
    "sync(gdrive): dangerous import held for review"
  );
  const vaultFiles = runGit(["ls-tree", "-r", "--name-only", "HEAD"], vaultPath);
  assert.ok(vaultFiles.includes("gdrive-note.md"), vaultFiles);
  const remoteFilesAfterHold = runGit(["ls-tree", "-r", "--name-only", "master"], remotePath);
  assert.ok(remoteFilesAfterHold.includes("local-note.md"), remoteFilesAfterHold);
  assert.equal(remoteFilesAfterHold.includes("gdrive-note.md"), false, remoteFilesAfterHold);
  assert.ok(
    runGit(["log", "--format=%s", "master"], remotePath).includes(
      "backup(sync): snapshot before gdrive import"
    )
  );

  // E2E-13/AC2: the user accepts the import (one-shot force-clears paused)
  // and adds a note; the next run's snapshot prePush carries the held import
  // commit out, and bisync runs without --resync (marker present).
  fs.writeFileSync(path.join(vaultPath, "local-note-2.md"), "second thought\n", "utf8");
  const second = await runSyncCliJson(t, workspace, rcloneLogPath, "notes-sync-both-rerun");
  assert.equal(second.exit.code, 0, second.diagnostics());
  assert.equal(second.payload.sync.status, "idle");
  assert.equal(second.payload.sync.paused, false);
  assert.equal(second.payload.sync.reviewNeeded, false);

  const fullLog = readRcloneLog(rcloneLogPath);
  assert.deepEqual(
    fullLog.map((entry) => entry.command),
    ["listremotes", "delete", "bisync", "listremotes", "delete", "bisync"]
  );
  assert.equal(fullLog[5].args.includes("--resync"), false, fullLog[5].args.join(" "));

  const remoteFiles = runGit(["ls-tree", "-r", "--name-only", "master"], remotePath);
  assert.ok(remoteFiles.includes("gdrive-note.md"), remoteFiles);
  assert.ok(remoteFiles.includes("local-note-2.md"), remoteFiles);
  assert.ok(
    runGit(["log", "--format=%s", "master"], remotePath).includes(
      "sync(gdrive): dangerous import held for review"
    )
  );
  assert.equal(runGit(["rev-parse", "master"], remotePath), runGit(["rev-parse", "HEAD"], vaultPath));
});
