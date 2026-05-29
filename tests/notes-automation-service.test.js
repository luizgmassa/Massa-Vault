import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotesAutomationService } from "../tools/notes-automation/src/service.js";
import { readState } from "../tools/notes-automation/src/state.js";

function createConfig(tempDir, vaultPath, overrides = {}) {
  const configPath = path.join(tempDir, "notes.config.json");
  const baseConfig = {
    enabled: true,
    vault_path: vaultPath,
    watch_paths: ["."],
    include_globs: ["**/*.md"],
    ignore_globs: [".git/**", ".automation/**"],
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
    gdrive_mode: "copy",
    gdrive_resync_mode: "newer",
    gdrive_first_run_resync: true,
    gdrive_args: []
  };
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...baseConfig, ...overrides }, null, 2),
    "utf8"
  );
  return configPath;
}

function withTempCwd(run) {
  const previousCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-service-cwd-"));
  process.chdir(tempDir);
  try {
    return run(tempDir);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeFakeRclone(tempDir) {
  const scriptPath = path.join(tempDir, "fake-rclone.mjs");
  const script = `#!/usr/bin/env node
import fs from "node:fs";

const statePath = process.env.FAKE_RCLONE_STATE;
const mode = process.env.FAKE_RCLONE_MODE || "lockout-then-success";
const command = process.argv[2];
const args = process.argv.slice(3);

function readCount() {
  if (!statePath || !fs.existsSync(statePath)) return 0;
  return Number(fs.readFileSync(statePath, "utf8")) || 0;
}

function writeCount(value) {
  if (!statePath) return;
  fs.writeFileSync(statePath, String(value), "utf8");
}

if (command === "listremotes") {
  process.stdout.write("Personal:\\n");
  process.exit(0);
}

if (command === "delete") {
  process.exit(0);
}

if (command === "bisync") {
  const count = readCount() + 1;
  writeCount(count);

  const hasResync = args.includes("--resync");
  const modeIndex = args.indexOf("--resync-mode");
  const resyncMode = modeIndex >= 0 ? args[modeIndex + 1] : "";

  if (count === 1 && !hasResync) {
    process.stderr.write(
      "CRITICAL: cannot find prior Path1 listing file\\nMust run --resync to recover\\n"
    );
    process.exit(7);
  }

  if (count === 2 && hasResync && resyncMode === "newer") {
    if (mode === "lockout-then-success") {
      process.stdout.write("recovered\\n");
      process.exit(0);
    }
    process.stderr.write("CRITICAL: recovery failed after --resync\\n");
    process.exit(7);
  }

  process.stderr.write("unexpected bisync args\\n");
  process.exit(9);
}

process.stderr.write("unsupported command\\n");
process.exit(2);
`;
  fs.writeFileSync(scriptPath, script, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test("falls back to polling mode when fs.watch throws EMFILE", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-service-"));
  const vaultPath = path.join(tempDir, "vault");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "note.md"), "hello", "utf8");
  const configPath = createConfig(tempDir, vaultPath);

  const originalWatch = fs.watch;
  fs.watch = () => {
    const error = new Error("too many open files");
    error.code = "EMFILE";
    throw error;
  };

  const service = new NotesAutomationService(configPath);
  try {
    service.start();
    assert.equal(service.watchMode, "polling");
    assert.equal(service.watchFailures.length > 0, true);
    assert.ok(service.pollTimer);
    const state = readState();
    assert.equal(Number.isInteger(state.pid), true);
  } finally {
    await service.shutdown();
    fs.watch = originalWatch;
  }
});

test("runSync serializes concurrent requests and replays queued reason", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-service-"));
  const vaultPath = path.join(tempDir, "vault");
  fs.mkdirSync(vaultPath, { recursive: true });
  const configPath = createConfig(tempDir, vaultPath);
  const service = new NotesAutomationService(configPath);

  const reasons = [];
  service.executeSync = (reason) => {
    reasons.push(reason);
    return { ok: true };
  };

  await Promise.all([
    service.runSync({ reason: "manual-a" }),
    service.runSync({ reason: "manual-b" })
  ]);

  assert.deepEqual(reasons, ["manual-a", "manual-b"]);
});

test("gdrive lockout followed by auto-resync success does not pause sync", () => {
  withTempCwd((tempDir) => {
    const vaultPath = path.join(tempDir, "vault");
    fs.mkdirSync(vaultPath, { recursive: true });
    const fakeRclonePath = writeFakeRclone(tempDir);
    const fakeStatePath = path.join(tempDir, "fake-rclone.state");
    process.env.FAKE_RCLONE_STATE = fakeStatePath;
    process.env.FAKE_RCLONE_MODE = "lockout-then-success";

    const configPath = createConfig(tempDir, vaultPath, {
      sync_strategy: "gdrive",
      gdrive_mode: "bisync",
      gdrive_resync_mode: "newer",
      gdrive_first_run_resync: false,
      gdrive_remote_path: "Personal:Obsidian",
      gdrive_binary: fakeRclonePath
    });
    const service = new NotesAutomationService(configPath);
    service.updateState({ running: false, pid: null, sync: {} }, { force: true });

    try {
      const result = service.syncGoogleDriveInbound();
      const state = readState();

      assert.equal(result.ok, true);
      assert.equal(service.paused, false);
      assert.equal(state.paused, false);
      assert.equal(state.lastGDriveAutoResyncAttempted, true);
      assert.equal(state.lastGDriveAutoResyncApplied, true);
      assert.equal(state.lastGDriveResyncMode, "newer");
      assert.match(String(state.lastGDriveInitialError || ""), /must run --resync to recover/i);
      assert.equal(state.lastGDriveError, null);
    } finally {
      delete process.env.FAKE_RCLONE_STATE;
      delete process.env.FAKE_RCLONE_MODE;
    }
  });
});

test("gdrive lockout followed by failed auto-resync pauses with actionable alert", () => {
  withTempCwd((tempDir) => {
    const vaultPath = path.join(tempDir, "vault");
    fs.mkdirSync(vaultPath, { recursive: true });
    const fakeRclonePath = writeFakeRclone(tempDir);
    const fakeStatePath = path.join(tempDir, "fake-rclone.state");
    process.env.FAKE_RCLONE_STATE = fakeStatePath;
    process.env.FAKE_RCLONE_MODE = "lockout-then-fail";

    const configPath = createConfig(tempDir, vaultPath, {
      sync_strategy: "gdrive",
      gdrive_mode: "bisync",
      gdrive_resync_mode: "newer",
      gdrive_first_run_resync: false,
      gdrive_remote_path: "Personal:Obsidian",
      gdrive_binary: fakeRclonePath
    });
    const service = new NotesAutomationService(configPath);
    service.updateState({ running: false, pid: null, sync: {} }, { force: true });

    try {
      const result = service.syncGoogleDriveInbound();
      const state = readState();

      assert.equal(result.ok, false);
      assert.equal(service.paused, true);
      assert.equal(state.paused, true);
      assert.equal(state.sync.status, "paused");
      assert.equal(state.lastGDriveAutoResyncAttempted, true);
      assert.equal(state.lastGDriveAutoResyncApplied, false);
      assert.match(String(state.alert || ""), /auto recovery/i);
    } finally {
      delete process.env.FAKE_RCLONE_STATE;
      delete process.env.FAKE_RCLONE_MODE;
    }
  });
});
