import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLocalEnv, parseEnvContent } from "../tools/shared/env.js";

const ENV_KEYS = ["MV_TEST_A", "MV_TEST_B", "MV_TEST_QUOTED", "MV_TEST_UNCHANGED"];

function withEnv(overrides, callback) {
  const original = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);

  try {
    return callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

test("parseEnvContent supports export, comments, and quoted values", () => {
  const parsed = parseEnvContent(`
# comment
export MV_TEST_A=alpha
MV_TEST_B=beta # inline
MV_TEST_QUOTED="line 1\\nline 2"
MV_TEST_UNCHANGED='literal # inside'
INVALID-LINE
`);

  assert.deepEqual(parsed, {
    MV_TEST_A: "alpha",
    MV_TEST_B: "beta",
    MV_TEST_QUOTED: "line 1\nline 2",
    MV_TEST_UNCHANGED: "literal # inside"
  });
});

test("loadLocalEnv does not override existing env by default", () => {
  withEnv({ MV_TEST_UNCHANGED: "shell-value" }, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-env-"));
    fs.writeFileSync(
      path.join(tempDir, ".env"),
      "MV_TEST_A=alpha\nMV_TEST_UNCHANGED=file-value\n",
      "utf8"
    );

    const result = loadLocalEnv({ cwd: tempDir });
    assert.equal(result.loaded, true);
    assert.equal(result.parsedCount, 2);
    assert.equal(result.setCount, 1);
    assert.equal(process.env.MV_TEST_A, "alpha");
    assert.equal(process.env.MV_TEST_UNCHANGED, "shell-value");
  });
});

test("loadLocalEnv override=true replaces existing env values", () => {
  withEnv({ MV_TEST_UNCHANGED: "shell-value" }, () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-env-"));
    fs.writeFileSync(path.join(tempDir, ".env"), "MV_TEST_UNCHANGED=file-value\n", "utf8");

    const result = loadLocalEnv({ cwd: tempDir, override: true });
    assert.equal(result.loaded, true);
    assert.equal(result.setCount, 1);
    assert.equal(process.env.MV_TEST_UNCHANGED, "file-value");
  });
});

test("loadLocalEnv no-ops when env file does not exist", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-env-"));
  const result = loadLocalEnv({ cwd: tempDir, envFile: ".missing" });
  assert.equal(result.loaded, false);
  assert.equal(result.setCount, 0);
  assert.equal(result.parsedCount, 0);
});
