import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../tools/notes-automation/src/config.js";

test("loads both sync strategy with git and gdrive enabled", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
  const configPath = path.join(tempDir, "notes.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      vault_path: "/tmp/vault",
      sync_strategy: "both",
      git_mode: "remote",
      remote: "origin",
      branch: "main",
      gdrive_remote_path: "gdrive:massa-vault"
    }),
    "utf8"
  );

  const config = loadConfig(configPath);
  assert.equal(config.git.enabled, true);
  assert.equal(config.gdrive.enabled, true);
  assert.equal(config.git.remote, "origin");
  assert.equal(config.git.branch, "main");
  assert.equal(config.gdrive.remotePath, "gdrive:massa-vault");
});

test("loads local git mode without gdrive", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
  const configPath = path.join(tempDir, "notes.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      vault_path: "/tmp/vault",
      sync_strategy: "git",
      git_mode: "local",
      git_auto_push: false
    }),
    "utf8"
  );

  const config = loadConfig(configPath);
  assert.equal(config.git.enabled, true);
  assert.equal(config.gdrive.enabled, false);
  assert.equal(config.git.mode, "local");
  assert.equal(config.git.autoPush, false);
});
