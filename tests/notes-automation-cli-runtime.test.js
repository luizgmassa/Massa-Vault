import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// --- Module-load-time cwd trap -------------------------------------------
//
// `tools/notes-automation/src/infrastructure/state.js` computes STATE_DIR
// (and `config-constants.js` computes DEFAULT_CONFIG_PATH) with
// `path.resolve(...)` at module top level, evaluated exactly once on first
// import in this process. A per-test `process.chdir()` performed *after*
// that first import cannot change where `runtime.js` reads/writes state or
// its config file - those absolute paths are already baked in.
//
// To get real isolation from the actual worktree (and avoid ever touching
// `<worktree>/.automation` or `<worktree>/config`, which other concurrent
// agents and the real project also use), we create one scratch root,
// `chdir` into it, and only then import `runtime.js` for the first (and
// only) time in this process. That freezes its internal STATE_DIR/
// CONFIG_PATH constants to paths under the scratch root. We immediately
// `chdir` back so the rest of the suite runs from the original cwd.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "notes-cli-runtime-"));
const ORIGINAL_CWD = process.cwd();

const CONFIG_DIR = path.join(ROOT, "config");
const CONFIG_FILE = path.join(CONFIG_DIR, "notes-automation.config.json");
const STATE_DIR = path.join(ROOT, ".automation", "notes-automation");
const PID_FILE = path.join(STATE_DIR, "service.pid");
const STATE_FILE = path.join(STATE_DIR, "state.json");

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfigDocument(), null, 2), "utf8");

process.chdir(ROOT);
const { main } = await import("../tools/notes-automation/src/commands/runtime.js");
process.chdir(ORIGINAL_CWD);

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// A pid guaranteed not to belong to any running process, so
// `isProcessRunning` deterministically reports it as dead without any race.
const DEAD_PID = 999999999;

function defaultConfigDocument(overrides = {}) {
  return {
    enabled: true,
    vault_path: ".",
    watch_paths: ["."],
    include_globs: ["**/*.md"],
    ignore_globs: [],
    push_interval_min: 10,
    debounce_ms: 50,
    sync_strategy: "git",
    git_mode: "local",
    git_repo_url: "",
    git_auto_push: false,
    remote: "origin",
    branch: "master",
    gdrive_binary: "rclone",
    gdrive_remote_path: "",
    gdrive_mode: "bisync",
    gdrive_resync_mode: "newer",
    gdrive_first_run_resync: true,
    gdrive_args: [],
    ...overrides
  };
}

function writeFixtureConfig(overrides = {}) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfigDocument(overrides), null, 2), "utf8");
}

function resetStateDir() {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function writeFixtureState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function readFixtureState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function writeFixturePid(pid) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), "utf8");
}

function pidFileExists() {
  return fs.existsSync(PID_FILE);
}

function readFixturePid() {
  return fs.readFileSync(PID_FILE, "utf8").trim();
}

function lastJsonLog(logs) {
  return JSON.parse(logs[logs.length - 1]);
}

// Drives `main()` in-process: swaps `process.argv`, `process.exit`,
// `console.log`, and `console.error`, always restoring every one of them in
// a `finally` regardless of how `main()` exits. `process.exit` throws a
// tagged sentinel instead of killing the test runner.
async function runMain(args) {
  const originalArgv = process.argv;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];

  process.argv = [originalArgv[0], originalArgv[1], ...args];
  console.log = (...parts) => {
    logs.push(parts.map(String).join(" "));
  };
  console.error = (...parts) => {
    errors.push(parts.map(String).join(" "));
  };
  process.exit = (code) => {
    const sentinel = new Error("__TEST_PROCESS_EXIT__");
    sentinel.__isTestProcessExit = true;
    sentinel.exitCode = code;
    throw sentinel;
  };

  try {
    await main();
    return { exitCode: null, logs, errors };
  } catch (error) {
    if (error && error.__isTestProcessExit) {
      return { exitCode: error.exitCode, logs, errors };
    }
    throw error;
  } finally {
    process.argv = originalArgv;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
}

test("printStatus recovers a stale pidfile from a live pid recorded in state.json", async () => {
  resetStateDir();
  writeFixturePid(DEAD_PID);
  writeFixtureState({ running: true, pid: process.pid });

  const { exitCode, logs, errors } = await runMain(["status"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.running, true);
  assert.equal(payload.pid, process.pid);
  assert.equal(Boolean(payload.state.staleStateRecovered), false);
  assert.equal(payload.sync.running, true);

  assert.equal(readFixturePid(), String(process.pid));
});

test("printStatus recovers a stale pid recorded in state.json, marks staleStateRecovered, and removes the pidfile", async () => {
  resetStateDir();
  writeFixturePid(DEAD_PID);
  writeFixtureState({ running: true });

  const { exitCode, logs, errors } = await runMain(["status"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.running, false);
  assert.equal(payload.pid, null);
  assert.equal(payload.state.staleStateRecovered, true);

  assert.equal(pidFileExists(), false);
  const onDisk = readFixtureState();
  assert.equal(onDisk.running, false);
  assert.equal(onDisk.pid, null);
  assert.equal(onDisk.staleStateRecovered, true);
});

test("stopService reports not running and resets state when no pidfile exists", async () => {
  resetStateDir();
  writeFixtureState({ running: true, pid: DEAD_PID });

  const { exitCode, logs, errors } = await runMain(["stop"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  assert.ok(logs.some((line) => /not running/.test(line)));

  const onDisk = readFixtureState();
  assert.equal(onDisk.running, false);
  assert.equal(onDisk.pid, null);
});

test("stopService sends SIGTERM to a live process and reports success", async () => {
  resetStateDir();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  writeFixturePid(child.pid);

  try {
    const { exitCode, logs, errors } = await runMain(["stop"]);

    assert.equal(exitCode, null);
    assert.equal(errors.length, 0);
    assert.ok(logs.some((line) => line.includes(`stop signal sent to pid ${child.pid}`)));
    assert.equal(pidFileExists(), false);

    await new Promise((resolve) => child.once("exit", resolve));
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});

test("stopService recovers from an ESRCH race between the running check and the kill call", async () => {
  resetStateDir();
  writeFixturePid(process.pid);

  const originalKill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (pid === process.pid && signal === "SIGTERM") {
      const error = new Error("kill ESRCH");
      error.code = "ESRCH";
      throw error;
    }
    return originalKill(pid, signal);
  };

  try {
    const { exitCode, logs, errors } = await runMain(["stop"]);

    assert.equal(exitCode, null);
    assert.equal(errors.length, 0);
    assert.ok(logs.some((line) => /not running/.test(line)));
    assert.equal(pidFileExists(), false);

    const onDisk = readFixtureState();
    assert.equal(onDisk.running, false);
    assert.equal(onDisk.pid, null);
  } finally {
    process.kill = originalKill;
  }
});

test("resume exits 1 with an error when the daemon is not running", async () => {
  resetStateDir();

  const { exitCode, logs, errors } = await runMain(["resume"]);

  assert.equal(exitCode, 1);
  assert.equal(logs.length, 0);
  assert.ok(errors.some((line) => /service is not running/.test(line)));
});

test("flush-push records the requested action and prints confirmation when the daemon is running", async () => {
  resetStateDir();
  writeFixturePid(process.pid);
  writeFixtureState({ running: true });

  const { exitCode, logs, errors } = await runMain(["flush-push"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  assert.ok(logs.some((line) => line.includes("action requested: flush-push")));

  const onDisk = readFixtureState();
  assert.equal(onDisk.requestedAction, "flush-push");
  assert.equal(typeof onDisk.requestedAt, "string");
  assert.ok(onDisk.requestedAt.length > 0);
});

test("start guards against spawning a second daemon when one is already running", async () => {
  resetStateDir();
  writeFixturePid(process.pid);

  const { exitCode, logs, errors } = await runMain(["start"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  assert.ok(logs.some((line) => line.includes(`already running with pid ${process.pid}`)));
});

test("status reports the full derived sync summary including conflicts, gdrive import fields, and an alert", async () => {
  resetStateDir();
  writeFixturePid(process.pid);
  writeFixtureState({
    running: true,
    paused: true,
    alert: "Sync paused: Git conflict detected.",
    lastGDriveRequiresResync: true,
    lastGDriveAutoResyncAttempted: true,
    lastGDriveAutoResyncApplied: false,
    lastGDriveAutoResyncAt: "2026-01-01T00:00:00.000Z",
    lastGDriveResyncMode: "newer",
    lastGDriveInitialError: "initial gdrive error",
    sync: {
      status: "conflict",
      reason: "manual",
      queuedReason: "manual",
      conflictCount: 1,
      conflicts: [{ filePath: "notes/today.md" }],
      lastError: "merge conflict",
      lastSuccessAt: "2025-12-31T00:00:00.000Z",
      finishedAt: "2025-12-31T00:00:00.000Z",
      lastGDriveImportClassification: "dangerous",
      lastGDriveImportSummary: { changedCount: 5, addedCount: 1, modifiedCount: 3, deletedCount: 1 },
      reviewNeeded: true,
      lastPreGDriveSnapshotCommit: "deadbeef",
      preGDriveSnapshotSkipped: null
    }
  });

  const { exitCode, logs, errors } = await runMain(["status"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  const sync = payload.sync;

  assert.equal(sync.running, true);
  assert.equal(sync.paused, true);
  assert.equal(sync.status, "conflict");
  assert.equal(sync.reason, "manual");
  assert.equal(sync.queuedReason, "manual");
  assert.equal(sync.conflictCount, 1);
  assert.deepEqual(sync.conflicts, [{ filePath: "notes/today.md" }]);
  assert.equal(sync.lastError, "merge conflict");
  assert.equal(sync.lastSuccessAt, "2025-12-31T00:00:00.000Z");
  assert.equal(sync.finishedAt, "2025-12-31T00:00:00.000Z");
  assert.equal(sync.lastGDriveRequiresResync, true);
  assert.equal(sync.lastGDriveAutoResyncAttempted, true);
  assert.equal(sync.lastGDriveAutoResyncApplied, false);
  assert.equal(sync.lastGDriveAutoResyncAt, "2026-01-01T00:00:00.000Z");
  assert.equal(sync.lastGDriveResyncMode, "newer");
  assert.equal(sync.lastGDriveInitialError, "initial gdrive error");
  assert.equal(sync.gdrive_import, "dangerous");
  assert.equal(sync.gdriveImport, "dangerous");
  assert.equal(sync.gdriveImportSummary.changedCount, 5);
  assert.equal(sync.reviewNeeded, true);
  assert.equal(sync.lastPreGDriveSnapshotCommit, "deadbeef");
  assert.equal(sync.preGDriveSnapshotSkipped, null);
  assert.match(String(sync.nextAction || ""), /review/i);
  assert.equal(sync.alert, "Sync paused: Git conflict detected.");
});

test("sync-conflicts reports zero conflicts and ok:false when sync is idle", async () => {
  resetStateDir();
  writeFixtureState({ running: false, sync: { status: "idle", conflictCount: 0, conflicts: [] } });

  const { exitCode, logs, errors } = await runMain(["sync-conflicts"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.ok, false);
  assert.equal(payload.sync.conflictCount, 0);
  assert.deepEqual(payload.sync.conflicts, []);
});

test("sync-resolve returns the no-active-conflicts early return without --done", async () => {
  resetStateDir();
  writeFixtureState({ running: false, sync: { status: "idle", conflictCount: 0, conflicts: [] } });

  const { exitCode, logs, errors } = await runMain(["sync-resolve"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.ok, true);
  assert.equal(payload.message, "No active sync conflicts.");
});

test("sync-resolve --done requests a daemon resume instead of clearing state directly when a live pid is present", async () => {
  resetStateDir();
  writeFixturePid(process.pid);
  writeFixtureState({
    running: true,
    paused: true,
    alert: "Sync paused: Git conflict detected.",
    sync: { status: "conflict", conflictCount: 1, conflicts: [{ filePath: "a.md" }], lastError: "boom" }
  });

  const { exitCode, logs, errors } = await runMain(["sync-resolve", "--done"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  assert.ok(logs.some((line) => line.includes("action requested: resume")));
  const payload = lastJsonLog(logs);
  assert.equal(payload.ok, true);
  assert.match(payload.message, /resume requested/i);

  const onDisk = readFixtureState();
  assert.equal(onDisk.requestedAction, "resume");
  // Unlike the no-daemon --done branch, state is NOT cleared directly here -
  // the running daemon is expected to clear it once it processes the
  // resume request.
  assert.equal(onDisk.paused, true);
  assert.equal(onDisk.sync.status, "conflict");
});

test("sync runs the real oneshot manual sync when no daemon is running and reports serviceMode oneshot", async () => {
  resetStateDir();
  const vaultDir = fs.mkdtempSync(path.join(ROOT, "oneshot-vault-"));
  writeFixtureConfig({ vault_path: vaultDir, sync_strategy: "git", git_mode: "local", git_auto_push: false });

  const { exitCode, logs, errors } = await runMain(["sync"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.serviceMode, "oneshot");
  assert.equal(payload.ok, true);
  assert.equal(payload.result.ok, true);
  assert.ok(fs.existsSync(path.join(vaultDir, ".git")));
});

test("sync in oneshot mode exits 1 and reports ok:false when the sync run itself fails", async () => {
  resetStateDir();
  const vaultDir = fs.mkdtempSync(path.join(ROOT, "oneshot-fail-vault-"));
  // git_mode "remote" with no configured "origin" remote makes pullGitInbound's
  // `git fetch` fail immediately (no network attempted - git rejects the
  // missing remote locally), driving runManualSync's oneshot ok:false /
  // process.exit(1) branch deterministically.
  writeFixtureConfig({ vault_path: vaultDir, sync_strategy: "git", git_mode: "remote", git_auto_push: false });

  const { exitCode, logs, errors } = await runMain(["sync"]);

  assert.equal(exitCode, 1);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.serviceMode, "oneshot");
  assert.equal(payload.ok, false);
  assert.equal(payload.result.ok, false);
  assert.ok(typeof payload.result.error === "string" && payload.result.error.length > 0);
});

test("flush-sync dispatches the same oneshot manual sync path as sync", async () => {
  resetStateDir();
  const vaultDir = fs.mkdtempSync(path.join(ROOT, "flush-sync-vault-"));
  writeFixtureConfig({ vault_path: vaultDir, sync_strategy: "git", git_mode: "local", git_auto_push: false });

  const { exitCode, logs, errors } = await runMain(["flush-sync"]);

  assert.equal(exitCode, null);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.serviceMode, "oneshot");
  assert.equal(payload.ok, true);
});

test("sync in daemon mode requests the sync action quietly and resolves via the requestSettled branch", async () => {
  resetStateDir();
  writeFixturePid(process.pid);
  writeFixtureState({ running: true, sync: { status: "idle" } });

  // Fires well inside the first (and only, for this test) poll window
  // (WAIT_FOR_SYNC_POLL_MS is 500ms) so waitForSyncCompletion observes
  // requestedAction present on the first poll, then absent on the second.
  const timer = setTimeout(() => {
    const state = readFixtureState();
    delete state.requestedAction;
    delete state.requestedAt;
    writeFixtureState(state);
  }, 150);

  try {
    const { exitCode, logs, errors } = await runMain(["sync"]);

    assert.equal(exitCode, null);
    assert.equal(errors.length, 0);
    // requestAction is called with { quiet: true } on this path.
    assert.equal(logs.some((line) => line.includes("action requested:")), false);

    const payload = lastJsonLog(logs);
    assert.equal(payload.serviceMode, "daemon");
    assert.equal(payload.ok, true);
    assert.equal(Boolean(payload.sync.timedOut), false);
  } finally {
    clearTimeout(timer);
  }
});

test("sync in daemon mode resolves via the syncSettled branch when only sync.status changes", async () => {
  resetStateDir();
  writeFixturePid(process.pid);
  // Already "syncing" at the first poll and requestedAction is deliberately
  // never cleared, so this isolates the syncSettled branch of
  // waitForSyncCompletion from the requestSettled branch.
  writeFixtureState({ running: true, sync: { status: "syncing" } });

  const timer = setTimeout(() => {
    const state = readFixtureState();
    state.sync = { ...state.sync, status: "idle" };
    writeFixtureState(state);
  }, 150);

  try {
    const { exitCode, logs, errors } = await runMain(["sync"]);

    assert.equal(exitCode, null);
    assert.equal(errors.length, 0);
    const payload = lastJsonLog(logs);
    assert.equal(payload.serviceMode, "daemon");
    assert.equal(payload.sync.status, "idle");
    assert.equal(payload.ok, true);

    // requestedAction was intentionally left in place - proves the daemon
    // path settled on the sync-status transition, not the request clearing.
    const onDisk = readFixtureState();
    assert.equal(onDisk.requestedAction, "sync");
  } finally {
    clearTimeout(timer);
  }
});

test("sync in daemon mode exits 1 and reports ok:false when the settled sync carries a lastError", async () => {
  resetStateDir();
  writeFixturePid(process.pid);
  writeFixtureState({ running: true, sync: { status: "idle", lastError: "forced failure" } });

  const timer = setTimeout(() => {
    const state = readFixtureState();
    delete state.requestedAction;
    delete state.requestedAt;
    writeFixtureState(state);
  }, 150);

  try {
    const { exitCode, logs, errors } = await runMain(["sync"]);

    assert.equal(exitCode, 1);
    assert.equal(errors.length, 0);
    const payload = lastJsonLog(logs);
    assert.equal(payload.serviceMode, "daemon");
    assert.equal(payload.ok, false);
    assert.equal(payload.sync.lastError, "forced failure");
  } finally {
    clearTimeout(timer);
  }
});

test("gdrive-check reports skipped:true and exits 1 when gdrive sync is disabled by sync_strategy", async () => {
  resetStateDir();
  writeFixtureConfig({ sync_strategy: "git" });

  const { exitCode, logs, errors } = await runMain(["gdrive-check"]);

  assert.equal(exitCode, 1);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.ok, false);
  assert.equal(payload.skipped, true);
  assert.match(payload.reason, /sync_strategy/);
});

test("gdrive-dry-run reports skipped:true and exits 1 when gdrive sync is disabled by sync_strategy", async () => {
  resetStateDir();
  writeFixtureConfig({ sync_strategy: "git" });

  const { exitCode, logs, errors } = await runMain(["gdrive-dry-run"]);

  assert.equal(exitCode, 1);
  assert.equal(errors.length, 0);
  const payload = lastJsonLog(logs);
  assert.equal(payload.ok, false);
  assert.equal(payload.skipped, true);
  assert.match(payload.reason, /sync_strategy/);
});

test("main prints usage and exits 1 for an unrecognized command", async () => {
  resetStateDir();

  const { exitCode, logs, errors } = await runMain(["not-a-real-command"]);

  assert.equal(exitCode, 1);
  assert.equal(logs.length, 0);
  assert.ok(errors.some((line) => line.startsWith("Usage: node tools/notes-automation/src/cli.js")));
});
