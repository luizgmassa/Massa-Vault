import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRuntimeEnv, resetRuntimeEnvWarningForTests } from "../tools/shared/runtime-env.js";

const TEST_KEY = "MASSA_AI_VAULT_CHAT_MODEL";
const ENV_KEYS = [TEST_KEY, "MASSA_AI_VAULT_HOME_CONFIG", "MASSA_AI_VAULT_ENV_FILE"];

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-runtime-env-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withEnv(overrides, callback) {
  const original = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);

  resetRuntimeEnvWarningForTests();
  try {
    return callback();
  } finally {
    resetRuntimeEnvWarningForTests();
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

function writeHomeConfig(tempDir, chatModel) {
  const homeConfigPath = path.join(tempDir, "home-config.json");
  fs.writeFileSync(homeConfigPath, JSON.stringify({ chat: { model: chatModel } }), "utf8");
  return homeConfigPath;
}

const silentStderr = { write: () => {} };

test("process.env beats both the home config and .env", () => {
  withTempDir((tempDir) => {
    withEnv({ MASSA_AI_VAULT_HOME_CONFIG: writeHomeConfig(tempDir, "home-value"), [TEST_KEY]: "shell-value" }, () => {
      fs.writeFileSync(path.join(tempDir, ".env"), `${TEST_KEY}=dotenv-value\n`, "utf8");

      loadRuntimeEnv({ cwd: tempDir, stderr: silentStderr });
      assert.equal(process.env[TEST_KEY], "shell-value");
    });
  });
});

test("home config beats .env when process.env has no value", () => {
  withTempDir((tempDir) => {
    withEnv({ MASSA_AI_VAULT_HOME_CONFIG: writeHomeConfig(tempDir, "home-value") }, () => {
      fs.writeFileSync(path.join(tempDir, ".env"), `${TEST_KEY}=dotenv-value\n`, "utf8");

      loadRuntimeEnv({ cwd: tempDir, stderr: silentStderr });
      assert.equal(process.env[TEST_KEY], "home-value");
    });
  });
});

test(".env applies when no home config and no process.env value are present", () => {
  withTempDir((tempDir) => {
    withEnv({ MASSA_AI_VAULT_HOME_CONFIG: "off" }, () => {
      fs.writeFileSync(path.join(tempDir, ".env"), `${TEST_KEY}=dotenv-value\n`, "utf8");

      loadRuntimeEnv({ cwd: tempDir, stderr: silentStderr });
      assert.equal(process.env[TEST_KEY], "dotenv-value");
    });
  });
});

test("no layer sets the key when process.env, home config, and .env are all absent", () => {
  withTempDir((tempDir) => {
    withEnv({ MASSA_AI_VAULT_HOME_CONFIG: "off" }, () => {
      loadRuntimeEnv({ cwd: tempDir });
      assert.equal(process.env[TEST_KEY], undefined);
    });
  });
});

test("loading a present .env emits exactly one deprecation warning per process", () => {
  withTempDir((tempDir) => {
    withEnv({ MASSA_AI_VAULT_HOME_CONFIG: "off" }, () => {
      fs.writeFileSync(path.join(tempDir, ".env"), `${TEST_KEY}=dotenv-value\n`, "utf8");

      let writes = 0;
      const stderr = { write: () => { writes += 1; } };

      loadRuntimeEnv({ cwd: tempDir, stderr });
      loadRuntimeEnv({ cwd: tempDir, stderr });
      loadRuntimeEnv({ cwd: tempDir, stderr });

      assert.equal(writes, 1);
    });
  });
});

test("MASSA_AI_VAULT_ENV_FILE=off leaves a present .env unread and emits no warning", () => {
  withTempDir((tempDir) => {
    withEnv({ MASSA_AI_VAULT_HOME_CONFIG: "off", MASSA_AI_VAULT_ENV_FILE: "off" }, () => {
      fs.writeFileSync(path.join(tempDir, ".env"), `${TEST_KEY}=dotenv-value\n`, "utf8");

      let writes = 0;
      const stderr = { write: () => { writes += 1; } };

      const { local } = loadRuntimeEnv({ cwd: tempDir, stderr });

      assert.equal(local.loaded, false);
      assert.equal(process.env[TEST_KEY], undefined);
      assert.equal(writes, 0);
    });
  });
});

test("no .env present emits zero deprecation warnings", () => {
  withTempDir((tempDir) => {
    withEnv({ MASSA_AI_VAULT_HOME_CONFIG: "off" }, () => {
      let writes = 0;
      const stderr = { write: () => { writes += 1; } };

      loadRuntimeEnv({ cwd: tempDir, stderr });

      assert.equal(writes, 0);
    });
  });
});
