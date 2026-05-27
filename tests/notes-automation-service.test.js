import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotesAutomationService } from "../tools/notes-automation/src/service.js";
import { readState } from "../tools/notes-automation/src/state.js";

function createConfig(tempDir, vaultPath) {
  const configPath = path.join(tempDir, "notes.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
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
        gdrive_first_run_resync: true,
        gdrive_args: []
      },
      null,
      2
    ),
    "utf8"
  );
  return configPath;
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
