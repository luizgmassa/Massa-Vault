import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../tools/notes-automation/src/config.js";

const CONFIG_ENV_KEYS = [
  "NOTES_AUTOMATION_ENABLED",
  "NOTES_AUTOMATION_PUSH_INTERVAL_MIN",
  "NOTES_AUTOMATION_GIT_REPO_URL",
  "NOTES_AUTOMATION_GIT_AUTO_PUSH",
  "NOTES_AUTOMATION_REMOTE",
  "NOTES_AUTOMATION_BRANCH",
  "NOTES_AUTOMATION_GDRIVE_BIN",
  "NOTES_AUTOMATION_GDRIVE_REMOTE_PATH",
  "VAULT_PATH"
];

function withConfigEnv(overrides, callback) {
  const original = {};
  for (const key of CONFIG_ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);

  try {
    return callback();
  } finally {
    for (const key of CONFIG_ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

test("loads both sync strategy with git and gdrive enabled", () => {
  withConfigEnv({}, () => {
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
    assert.equal(config.gdrive.resyncMode, "newer");
    assert.equal(config.gdriveImport.suspiciousFileThreshold, 20);
    assert.equal(config.gdriveImport.suspiciousDeleteThreshold, 5);
    assert.equal(config.gdriveImport.suspiciousPercentThreshold, 10);
    assert.equal(config.gdriveImport.dangerousPercentThreshold, 50);
    assert.equal(config.ignoreGlobs.includes(".automation/**"), true);
    assert.equal(config.ignoreGlobs.includes(".DS_Store"), true);
    assert.equal(config.ignoreGlobs.includes("**/.DS_Store"), true);
  });
});

test("rejects non-bisync google drive mode when gdrive is enabled", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: "/tmp/vault",
        sync_strategy: "gdrive",
        gdrive_remote_path: "gdrive:massa-vault",
        gdrive_mode: "copy"
      }),
      "utf8"
    );

    assert.throws(() => loadConfig(configPath), /must be "bisync"/i);
  });
});

test("rejects invalid gdrive_resync_mode values", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: "/tmp/vault",
        sync_strategy: "gdrive",
        gdrive_remote_path: "gdrive:massa-vault",
        gdrive_mode: "bisync",
        gdrive_resync_mode: "fastest"
      }),
      "utf8"
    );

    assert.throws(() => loadConfig(configPath), /gdrive_resync_mode/i);
  });
});

test("loads local git mode without gdrive", () => {
  withConfigEnv({}, () => {
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
});

test("local config overrides tracked config", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    const localConfigPath = path.join(tempDir, "notes.local.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: "/tmp/base-vault",
        sync_strategy: "git",
        git_mode: "remote",
        git_auto_push: true,
        branch: "main"
      }),
      "utf8"
    );
    fs.writeFileSync(
      localConfigPath,
      JSON.stringify({
        vault_path: "/tmp/local-vault",
        sync_strategy: "gdrive",
        git_mode: "local",
        git_auto_push: false,
        gdrive_remote_path: "gdrive:local-vault"
      }),
      "utf8"
    );

    const config = loadConfig(configPath, { localConfigPath });
    assert.equal(config.vaultPath, "/tmp/local-vault");
    assert.equal(config.syncStrategy, "gdrive");
    assert.equal(config.git.mode, "local");
    assert.equal(config.git.autoPush, false);
    assert.equal(config.gdrive.remotePath, "gdrive:local-vault");
  });
});

test("environment values override local config", () => {
  withConfigEnv(
    {
      VAULT_PATH: "/tmp/env-vault",
      NOTES_AUTOMATION_BRANCH: "env-branch"
    },
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
      const configPath = path.join(tempDir, "notes.json");
      const localConfigPath = path.join(tempDir, "notes.local.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          vault_path: "/tmp/base-vault",
          sync_strategy: "git",
          branch: "main"
        }),
        "utf8"
      );
      fs.writeFileSync(
        localConfigPath,
        JSON.stringify({
          vault_path: "/tmp/local-vault",
          branch: "local"
        }),
        "utf8"
      );

      const config = loadConfig(configPath, { localConfigPath });
      assert.equal(config.vaultPath, "/tmp/env-vault");
      assert.equal(config.git.branch, "env-branch");
    }
  );
});
