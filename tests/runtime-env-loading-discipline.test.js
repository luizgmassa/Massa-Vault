import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Sensor for arch3-runtime-env-loading R4: env loading happens once per
// process entrypoint, never at module import time. Two checks:
//
// 1. Static: the set of files with a module-scope (column-0) loadRuntimeEnv()
//    call must exactly equal IMPORT_TIME_LOAD_ALLOWLIST. The list shrinks to
//    empty as tasks T2-T6 land; a new entry appearing is a regression.
// 2. Behavioral: importing a listed module in a child process whose cwd holds
//    a poison .env must not project that .env into process.env. Modules join
//    IMPORT_SAFE_MODULES in the same commit that de-freezes them.

const REPO_ROOT = path.resolve(".");

// Files still calling loadRuntimeEnv() at module scope. Shrinks per task:
// T2 router-gateway, T3 mcp-server, T4 notes-automation, T5 tools/cli.js,
// T6 llm-chat-cli chat-config. Must reach [] by the end of the feature.
const IMPORT_TIME_LOAD_ALLOWLIST = [
  "tools/cli.js",
  "tools/llm-chat-cli/src/infrastructure/chat-config.js"
];

// Modules whose import must be side-effect-free with respect to env loading.
const IMPORT_SAFE_MODULES = [
  "tools/shared/env.js",
  "tools/shared/runtime-env.js",
  "tools/shared/vault-cli-config.js",
  "tools/server/src/infrastructure/config.js",
  "tools/router-gateway/src/infrastructure/runtime-config.js",
  "tools/router-gateway/src/server.js",
  "tools/mcp-server/src/infrastructure/runtime-config.js",
  "tools/mcp-server/src/server.js",
  "tools/notes-automation/src/commands/runtime.js",
  "tools/notes-automation/src/cli.js"
];

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("module-scope loadRuntimeEnv() calls match the shrinking allowlist exactly", () => {
  const offenders = [];
  for (const file of listJsFiles(path.join(REPO_ROOT, "tools"))) {
    const source = fs.readFileSync(file, "utf8");
    if (/^loadRuntimeEnv\(/m.test(source)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders.sort(), [...IMPORT_TIME_LOAD_ALLOWLIST].sort());
});

test("importing de-frozen modules never projects a poison .env into process.env", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arch3-poison-"));
  try {
    fs.writeFileSync(
      path.join(tempDir, ".env"),
      "MV_ARCH3_POISON=leaked\nROUTER_GATEWAY_PORT=59999\n",
      "utf8"
    );

    for (const relativePath of IMPORT_SAFE_MODULES) {
      const moduleUrl = pathToFileURL(path.join(REPO_ROOT, relativePath)).href;
      const childEnv = { ...process.env, MASSA_VAULT_HOME_CONFIG: "off" };
      // The sensor validates real-world default behavior: no off-switch set.
      delete childEnv.MASSA_VAULT_ENV_FILE;

      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(moduleUrl)});` +
            `console.log(JSON.stringify({ poison: process.env.MV_ARCH3_POISON ?? null }));`
        ],
        { cwd: tempDir, env: childEnv, encoding: "utf8", timeout: 30_000 }
      );

      assert.equal(result.status, 0, `${relativePath}: import failed: ${result.stderr}`);
      const lastLine = result.stdout.trim().split("\n").at(-1);
      assert.deepEqual(
        JSON.parse(lastLine),
        { poison: null },
        `${relativePath}: importing the module projected the poison .env`
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
