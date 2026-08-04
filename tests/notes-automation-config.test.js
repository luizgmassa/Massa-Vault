import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

// T5 needs to exercise the DEFAULT_CONFIG_PATH/DEFAULT_LOCAL_CONFIG_PATH
// gated branch (R9), but those constants are `path.resolve("config/...")`
// against cwd *at import time* in config-constants.js, and that path is this
// repo's real tracked config/notes-automation.config.json. Chdir into a
// scratch root before the first (dynamic) import of config.js / its
// constants freezes them to scratch-root paths instead, so default-path
// tests never read or write the real file. Mirrors the precedent in
// tests/notes-automation-cli-runtime.test.js.
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-scratch-"));
const ORIGINAL_CWD = process.cwd();
fs.mkdirSync(path.join(SCRATCH_ROOT, "config"), { recursive: true });

process.chdir(SCRATCH_ROOT);
const { loadConfig, VaultPathError } = await import(
  "../tools/notes-automation/src/infrastructure/config.js"
);
const { DEFAULT_CONFIG_PATH, DEFAULT_LOCAL_CONFIG_PATH } = await import(
  "../tools/notes-automation/src/infrastructure/config-constants.js"
);
const { createConfigDocument } = await import(
  "../tools/notes-automation/src/infrastructure/config-definition.js"
);
process.chdir(ORIGINAL_CWD);

const CONFIG_ENV_KEYS = [
  "NOTES_AUTOMATION_ENABLED",
  "NOTES_AUTOMATION_PUSH_INTERVAL_MIN",
  "NOTES_AUTOMATION_GIT_REPO_URL",
  "NOTES_AUTOMATION_GIT_AUTO_PUSH",
  "NOTES_AUTOMATION_REMOTE",
  "NOTES_AUTOMATION_BRANCH",
  "NOTES_AUTOMATION_GDRIVE_BIN",
  "NOTES_AUTOMATION_GDRIVE_REMOTE_PATH",
  "VAULT_PATH",
  "MASSA_AI_VAULT_HOME_CONFIG"
];

function withConfigEnv(overrides, callback) {
  const original = {};
  for (const key of CONFIG_ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  // Default to disabled (R2) rather than merely unset: an unset override
  // falls through resolveHomeConfigPath() to the real default
  // homedir()/.config/massa-ai-vault/config.json, which would read a real,
  // populated home config on a developer machine. Tests that intentionally
  // exercise the home-config layer (below) set MASSA_AI_VAULT_HOME_CONFIG to an
  // explicit fixture path inside their own callback, after this default runs.
  process.env.MASSA_AI_VAULT_HOME_CONFIG = "off";
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

test("vault-root guard throws when sync_strategy is both and vaultPath resolves to the repo root", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: REPO_ROOT,
        sync_strategy: "both"
      }),
      "utf8"
    );

    assert.throws(() => loadConfig(configPath), VaultPathError);
  });
});

test("vault-root guard throws when sync_strategy is git and vaultPath resolves to the repo root", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: REPO_ROOT,
        sync_strategy: "git"
      }),
      "utf8"
    );

    assert.throws(() => loadConfig(configPath), VaultPathError);
  });
});

test("vault-root guard throws when sync_strategy is gdrive and vaultPath resolves to the repo root", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: REPO_ROOT,
        sync_strategy: "gdrive",
        gdrive_remote_path: "gdrive:massa-vault"
      }),
      "utf8"
    );

    assert.throws(() => loadConfig(configPath), VaultPathError);
  });
});

test("vault-root guard does not throw when sync is disabled even at the repo root", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: REPO_ROOT,
        sync_strategy: "none"
      }),
      "utf8"
    );

    const config = loadConfig(configPath);
    assert.equal(config.git.enabled, false);
    assert.equal(config.gdrive.enabled, false);
    assert.equal(config.vaultPath, REPO_ROOT);
  });
});

test("vault-root guard does not throw for a temp absolute path with sync enabled", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: "/tmp/some-other-vault",
        sync_strategy: "both"
      }),
      "utf8"
    );

    const config = loadConfig(configPath);
    assert.equal(config.git.enabled, true);
    assert.equal(config.gdrive.enabled, true);
    assert.equal(config.vaultPath, "/tmp/some-other-vault");
  });
});

test("configure defaults and loadConfig defaults stay aligned", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    const document = createConfigDocument({
      vaultPath: "/tmp/aligned-vault"
    });
    fs.writeFileSync(configPath, JSON.stringify(document, null, 2), "utf8");

    const config = loadConfig(configPath);
    assert.equal(config.syncStrategy, "both");
    assert.equal(config.git.enabled, true);
    assert.equal(config.gdrive.enabled, true);
    assert.equal(config.git.mode, "remote");
    assert.equal(config.git.autoPush, true);
    assert.equal(config.gdrive.mode, "bisync");
    assert.equal(config.gdrive.resyncMode, "newer");
    assert.deepEqual(config.watchPaths, document.watch_paths);
    assert.deepEqual(config.includeGlobs, document.include_globs);
    assert.deepEqual(config.gdrive.args, document.gdrive_args);
    assert.equal(config.pushIntervalMin, document.push_interval_min);
    assert.equal(config.debounceMs, document.debounce_ms);
  });
});

// --- T5: home config `notes` section as the local-override layer (R7, R9) ---

function writeDefaultTrackedConfig(overrides = {}) {
  fs.writeFileSync(
    DEFAULT_CONFIG_PATH,
    JSON.stringify({
      enabled: true,
      vault_path: path.join(SCRATCH_ROOT, "base-vault"),
      sync_strategy: "git",
      git_mode: "remote",
      branch: "main",
      ...overrides
    }),
    "utf8"
  );
}

function writeDefaultLocalConfig(document) {
  fs.mkdirSync(path.dirname(DEFAULT_LOCAL_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(DEFAULT_LOCAL_CONFIG_PATH, JSON.stringify(document), "utf8");
}

function removeDefaultLocalConfig() {
  fs.rmSync(DEFAULT_LOCAL_CONFIG_PATH, { force: true });
}

function writeHomeConfig(homeConfigPath, document) {
  fs.mkdirSync(path.dirname(homeConfigPath), { recursive: true });
  fs.writeFileSync(homeConfigPath, JSON.stringify(document), "utf8");
}

test("home config's notes section beats the deprecated .local.json for the default config path", () => {
  withConfigEnv({}, () => {
    writeDefaultTrackedConfig();
    writeDefaultLocalConfig({ vault_path: path.join(SCRATCH_ROOT, "local-vault"), branch: "local" });
    const homeConfigPath = path.join(SCRATCH_ROOT, "home-config.json");
    writeHomeConfig(homeConfigPath, {
      notes: { vault_path: path.join(SCRATCH_ROOT, "home-vault"), branch: "home" }
    });
    process.env.MASSA_AI_VAULT_HOME_CONFIG = homeConfigPath;

    try {
      const config = loadConfig(DEFAULT_CONFIG_PATH);
      assert.equal(config.vaultPath, path.join(SCRATCH_ROOT, "home-vault"));
      assert.equal(config.git.branch, "home");
    } finally {
      removeDefaultLocalConfig();
    }
  });
});

test("environment values still override the home config's notes section", () => {
  withConfigEnv(
    {
      VAULT_PATH: path.join(SCRATCH_ROOT, "env-vault"),
      NOTES_AUTOMATION_BRANCH: "env-branch"
    },
    () => {
      writeDefaultTrackedConfig();
      const homeConfigPath = path.join(SCRATCH_ROOT, "home-config.json");
      writeHomeConfig(homeConfigPath, {
        notes: { vault_path: path.join(SCRATCH_ROOT, "home-vault"), branch: "home" }
      });
      process.env.MASSA_AI_VAULT_HOME_CONFIG = homeConfigPath;

      const config = loadConfig(DEFAULT_CONFIG_PATH);
      assert.equal(config.vaultPath, path.join(SCRATCH_ROOT, "env-vault"));
      assert.equal(config.git.branch, "env-branch");
    }
  );
});

test("a non-default configPath gets no home-config injection", () => {
  withConfigEnv({}, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-config-"));
    const configPath = path.join(tempDir, "notes.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        vault_path: path.join(tempDir, "temp-base-vault"),
        sync_strategy: "git",
        branch: "tracked"
      }),
      "utf8"
    );
    const homeConfigPath = path.join(SCRATCH_ROOT, "home-config.json");
    writeHomeConfig(homeConfigPath, {
      notes: { vault_path: "/should-not-apply", branch: "should-not-apply" }
    });
    process.env.MASSA_AI_VAULT_HOME_CONFIG = homeConfigPath;

    const config = loadConfig(configPath);
    assert.equal(config.vaultPath, path.join(tempDir, "temp-base-vault"));
    assert.equal(config.git.branch, "tracked");
  });
});

test("the T1 vault-root guard still fires through the home config notes layer", () => {
  withConfigEnv({}, () => {
    writeDefaultTrackedConfig();
    const homeConfigPath = path.join(SCRATCH_ROOT, "home-config.json");
    writeHomeConfig(homeConfigPath, {
      notes: { vault_path: REPO_ROOT, sync_strategy: "both" }
    });
    process.env.MASSA_AI_VAULT_HOME_CONFIG = homeConfigPath;

    assert.throws(() => loadConfig(DEFAULT_CONFIG_PATH), VaultPathError);
  });
});
