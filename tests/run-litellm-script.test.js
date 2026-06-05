import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SOURCE_SCRIPT = path.resolve("scripts/run-litellm.sh");

function prepareTempRunner() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-litellm-"));
  const scriptDir = path.join(tempDir, "scripts");
  const binDir = path.join(tempDir, ".litellm", ".venv", "bin");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(scriptDir, "run-litellm.sh");
  fs.copyFileSync(SOURCE_SCRIPT, scriptPath);
  fs.writeFileSync(
    path.join(binDir, "litellm"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\"\n",
    "utf8"
  );
  fs.chmodSync(path.join(binDir, "litellm"), 0o755);
  return { tempDir, scriptPath };
}

function runScript(scriptPath, env = {}) {
  return execFileSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  }).trim();
}

function runScriptError(scriptPath, env = {}) {
  try {
    runScript(scriptPath, env);
  } catch (error) {
    return String(error.stderr || error.message);
  }
  throw new Error("Expected run-litellm to fail.");
}

test("run-litellm uses generated MMT config when present", () => {
  const { tempDir, scriptPath } = prepareTempRunner();
  try {
    fs.mkdirSync(path.join(tempDir, ".automation", "llm-chat-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".automation", "llm-chat-cli", "litellm-config.generated.yaml"),
      "model_list: []\n",
      "utf8"
    );

    const args = runScript(scriptPath, { LITELLM_CONFIG_PATH: "" });
    assert.match(args, /--config \.automation\/llm-chat-cli\/litellm-config\.generated\.yaml/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run-litellm fails clearly without generated config or explicit override", () => {
  const { tempDir, scriptPath } = prepareTempRunner();
  try {
    const stderr = runScriptError(scriptPath, { LITELLM_CONFIG_PATH: "" });
    assert.match(stderr, /missing generated config/);
    assert.match(stderr, /\/mmt apply/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run-litellm honors explicit LITELLM_CONFIG_PATH", () => {
  const { tempDir, scriptPath } = prepareTempRunner();
  try {
    fs.mkdirSync(path.join(tempDir, ".automation", "llm-chat-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".automation", "llm-chat-cli", "litellm-config.generated.yaml"),
      "model_list: []\n",
      "utf8"
    );

    const args = runScript(scriptPath, { LITELLM_CONFIG_PATH: "/tmp/manual-litellm.yaml" });
    assert.match(args, /--config \/tmp\/manual-litellm\.yaml/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
