import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const NOTES_AUTOMATION_CLI = path.resolve("tools/notes-automation/src/cli.js");

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-cli-sync-"));
  try {
    run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeState(tempDir, state) {
  const stateDir = path.join(tempDir, ".automation", "notes-automation");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

function readState(tempDir) {
  const statePath = path.join(tempDir, ".automation", "notes-automation", "state.json");
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function runNotesCli(args, cwd) {
  // This spawns a real subprocess whose commands/runtime.js loads the runtime
  // env at import time: without forcing MASSA_AI_VAULT_HOME_CONFIG=off, a developer
  // machine with a real ~/.config/massa-ai-vault/config.json would leak that
  // file's settings into the child (same guard as vault-cli-executables.test.js).
  const result = spawnSync(process.execPath, [NOTES_AUTOMATION_CLI, ...args], {
    cwd,
    env: { ...process.env, MASSA_AI_VAULT_HOME_CONFIG: "off" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    status: Number(result.status),
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

function parseJson(output) {
  return JSON.parse(String(output || "{}"));
}

test("sync-conflicts returns json contract with active conflicts", () => {
  withTempDir((tempDir) => {
    writeState(tempDir, {
      running: false,
      paused: true,
      sync: {
        status: "conflict",
        conflictCount: 1,
        conflicts: [
          {
            filePath: "notes/today.md",
            worktreePath: "/tmp/sync-conflicts/today.worktree.txt",
            oursPath: "/tmp/sync-conflicts/today.ours.txt",
            theirsPath: "/tmp/sync-conflicts/today.theirs.txt",
            basePath: "/tmp/sync-conflicts/today.base.txt"
          }
        ]
      }
    });

    const result = runNotesCli(["sync-conflicts"], tempDir);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    const payload = parseJson(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.sync.status, "conflict");
    assert.equal(payload.sync.conflictCount, 1);
    assert.equal(Array.isArray(payload.sync.conflicts), true);
    assert.equal(payload.sync.conflicts.length, 1);
    assert.equal(payload.sync.conflicts[0].filePath, "notes/today.md");
  });
});

test("sync-resolve returns guided recovery payload and exits non-zero when unresolved", () => {
  withTempDir((tempDir) => {
    writeState(tempDir, {
      running: false,
      paused: true,
      vaultPath: "/tmp/demo-vault",
      sync: {
        status: "conflict",
        conflictCount: 1,
        conflicts: [
          {
            filePath: "notes/today.md",
            worktreePath: "/tmp/demo-vault/.automation/sync-conflicts/2026-01-01/today.worktree.txt"
          }
        ]
      }
    });

    const result = runNotesCli(["sync-resolve"], tempDir);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");

    const payload = parseJson(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.message, /sync resolve --done/i);
    assert.equal(payload.conflictRootHint, "/tmp/demo-vault");
    assert.equal(Array.isArray(payload.conflicts), true);
    assert.equal(payload.conflicts.length, 1);
  });
});

test("sync-resolve --done clears paused/conflict state in oneshot mode", () => {
  withTempDir((tempDir) => {
    writeState(tempDir, {
      running: false,
      paused: true,
      alert: "Sync paused",
      sync: {
        status: "conflict",
        reason: "manual",
        queuedReason: "manual",
        conflictCount: 2,
        conflicts: [{ filePath: "a.md" }, { filePath: "b.md" }],
        lastError: "merge conflict"
      }
    });

    const result = runNotesCli(["sync-resolve", "--done"], tempDir);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    const payload = parseJson(result.stdout);
    assert.equal(payload.ok, true);
    assert.match(payload.message, /Conflict state cleared/i);
    assert.equal(payload.sync.status, "idle");
    assert.equal(payload.sync.conflictCount, 0);
    assert.equal(payload.sync.lastError, null);

    const state = readState(tempDir);
    assert.equal(state.paused, false);
    assert.equal(state.alert, null);
    assert.equal(state.sync.status, "idle");
    assert.equal(state.sync.conflictCount, 0);
    assert.deepEqual(state.sync.conflicts, []);
  });
});

test("sync-conflicts payload includes gdrive import classification and review guidance fields", () => {
  withTempDir((tempDir) => {
    writeState(tempDir, {
      running: false,
      paused: false,
      sync: {
        status: "idle",
        conflictCount: 0,
        conflicts: [],
        lastGDriveImportClassification: "suspicious",
        lastGDriveImportSummary: {
          changedCount: 22,
          addedCount: 6,
          modifiedCount: 11,
          deletedCount: 5
        },
        reviewNeeded: true,
        lastPreGDriveSnapshotCommit: "abc123",
        preGDriveSnapshotSkipped: null
      }
    });

    const result = runNotesCli(["sync-conflicts"], tempDir);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    const payload = parseJson(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.sync.gdrive_import, "suspicious");
    assert.equal(payload.sync.gdriveImport, "suspicious");
    assert.equal(payload.sync.reviewNeeded, true);
    assert.equal(payload.sync.gdriveImportSummary.changedCount, 22);
    assert.equal(payload.sync.lastPreGDriveSnapshotCommit, "abc123");
    assert.match(String(payload.sync.nextAction || ""), /review/i);
  });
});
