import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_COMMANDS, USAGE_LINES, createVaultCli } from "../tools/cli.js";

class ExitSignal extends Error {
  constructor(code) {
    super(`exit:${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

// `await run(...)` (not a bare `return run(...)`) matters here: a `return`
// inside try/finally resolves the finally block before an async run()
// actually finishes its work, which would delete the temp dir / restore env
// before the assertions that depend on them have run.
async function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-config-command-"));
  try {
    return await run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withSavedEnv(keys, run) {
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  try {
    return await run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Builds a CLI whose every side effect is captured, mirroring vault-cli-dispatch.test.js. */
function harness(argvTail, overrides = {}) {
  const calls = { log: [], logError: [] };
  const cli = createVaultCli({
    argv: ["node", "cli.js", ...argvTail],
    log: (line) => calls.log.push(String(line)),
    logError: (line) => calls.logError.push(String(line)),
    exit: (code) => {
      throw new ExitSignal(code);
    },
    ...overrides
  });
  return { cli, calls };
}

async function expectExit(run, expectedCode) {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ExitSignal, `expected ExitSignal, got ${error}`);
    assert.equal(error.code, expectedCode);
    return;
  }
  assert.fail(`expected exit(${expectedCode}) but the command returned normally`);
}

const FIXTURE_ENV = [
  "LITELLM_MASTER_KEY=sk-fixture-key",
  "ROUTER_GATEWAY_PORT=4100",
  "MASSA_VAULT_CHAT_MODEL=smart-router",
  ""
].join("\n");

function writeFixtures(tempDir, { vaultPath = "/tmp/fixture-vault" } = {}) {
  const envPath = path.join(tempDir, "fixture.env");
  const localNotesConfigPath = path.join(tempDir, "notes-automation.local.json");
  fs.writeFileSync(envPath, FIXTURE_ENV, "utf8");
  fs.writeFileSync(
    localNotesConfigPath,
    JSON.stringify(
      {
        vault_path: vaultPath,
        sync_strategy: "both",
        watch_paths: ["."]
      },
      null,
      2
    ),
    "utf8"
  );
  return { envPath, localNotesConfigPath };
}

test("vault cli config command table and usage banner mention path and migrate", () => {
  assert.deepEqual([...CONFIG_COMMANDS.keys()], ["path", "migrate"]);
  assert.ok(USAGE_LINES.some((line) => line.includes("config path|migrate")));
});

test("vault cli config path prints the resolved home config path", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli, calls } = harness(["config", "path"]);
      cli.configCommand("path", []);
      assert.deepEqual(calls.log, [targetPath]);
    });
  });
});

test("vault cli config path prints an empty line when the home config is disabled", async () => {
  await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
    process.env.MASSA_VAULT_HOME_CONFIG = "off";
    const { cli, calls } = harness(["config", "path"]);
    cli.configCommand("path", []);
    assert.deepEqual(calls.log, [""]);
  });
});

test("vault cli config migrate builds and writes the home config from .env and .local.json fixtures", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    const { envPath, localNotesConfigPath } = writeFixtures(tempDir);

    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli, calls } = harness(["config", "migrate"], { envPath, localNotesConfigPath });
      cli.configCommand("migrate", []);

      assert.ok(fs.existsSync(targetPath));
      const written = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      assert.equal(written.litellm.master_key, "sk-fixture-key");
      assert.equal(written.router.gateway_port, "4100");
      assert.equal(written.chat.model, "smart-router");
      assert.equal(written.notes.vault_path, "/tmp/fixture-vault");
      assert.equal(written.notes.sync_strategy, "both");

      const fileMode = fs.statSync(targetPath).mode & 0o777;
      assert.equal(fileMode, 0o600);
      const dirMode = fs.statSync(path.dirname(targetPath)).mode & 0o777;
      assert.equal(dirMode, 0o700);

      assert.ok(calls.log.some((line) => line.includes(`wrote ${targetPath}`)));
    });
  });
});

test("vault cli config migrate refuses to clobber an existing home config without --force", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ version: 1, notes: { vault_path: "existing" } }),
      "utf8"
    );
    const { envPath, localNotesConfigPath } = writeFixtures(tempDir);

    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli, calls } = harness(["config", "migrate"], { envPath, localNotesConfigPath });

      await expectExit(() => cli.configCommand("migrate", []), 1);
      assert.ok(calls.logError.some((line) => line.includes("refusing to overwrite")));
      const stillThere = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      assert.equal(stillThere.notes.vault_path, "existing");
    });
  });
});

test("vault cli config migrate --force overwrites an existing home config", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ version: 1, notes: { vault_path: "existing" } }),
      "utf8"
    );
    const { envPath, localNotesConfigPath } = writeFixtures(tempDir);

    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli } = harness(["config", "migrate", "--force"], { envPath, localNotesConfigPath });
      cli.configCommand("migrate", ["--force"]);

      const written = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      assert.equal(written.notes.vault_path, "/tmp/fixture-vault");
      const fileMode = fs.statSync(targetPath).mode & 0o777;
      assert.equal(fileMode, 0o600);
    });
  });
});

test("vault cli config migrate --dry-run prints the document and writes nothing", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    const { envPath, localNotesConfigPath } = writeFixtures(tempDir);

    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli, calls } = harness(["config", "migrate", "--dry-run"], {
        envPath,
        localNotesConfigPath
      });
      cli.configCommand("migrate", ["--dry-run"]);

      assert.equal(fs.existsSync(targetPath), false);
      const printed = JSON.parse(calls.log.join(""));
      assert.equal(printed.notes.vault_path, "/tmp/fixture-vault");
    });
  });
});

test("vault cli config migrate refuses to write a document with a missing notes.vault_path", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    const envPath = path.join(tempDir, "fixture.env");
    fs.writeFileSync(envPath, FIXTURE_ENV, "utf8");
    const localNotesConfigPath = path.join(tempDir, "notes-automation.local.json");
    fs.writeFileSync(localNotesConfigPath, JSON.stringify({ vault_path: "" }), "utf8");

    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli, calls } = harness(["config", "migrate"], { envPath, localNotesConfigPath });

      await expectExit(() => cli.configCommand("migrate", []), 1);
      assert.ok(
        calls.logError.some((line) => line.includes("notes.vault_path is missing or empty"))
      );
      assert.ok(calls.logError.some((line) => line.includes("massa-vault configure")));
      assert.equal(fs.existsSync(targetPath), false);
    });
  });
});

test("vault cli config migrate refuses to write when the home config is disabled", async () => {
  await withTempDir(async (tempDir) => {
    const { envPath, localNotesConfigPath } = writeFixtures(tempDir);
    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = "off";
      const { cli, calls } = harness(["config", "migrate"], { envPath, localNotesConfigPath });

      await expectExit(() => cli.configCommand("migrate", []), 1);
      assert.ok(calls.logError.some((line) => line.includes("home config is disabled")));
    });
  });
});

test("vault cli config rejects an unknown subcommand with exit 1", async () => {
  const { cli, calls } = harness(["config", "bogus"]);
  await expectExit(() => cli.configCommand("bogus", []), 1);
  assert.ok(calls.logError.some((line) => line.includes("Usage: npm run vault -- config")));
});

test("vault cli main dispatches config path through the top-level cmd switch", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli, calls } = harness(["config", "path"]);
      await cli.main();
      assert.deepEqual(calls.log, [targetPath]);
    });
  });
});

test("vault cli main dispatches config migrate through the top-level cmd switch", async () => {
  await withTempDir(async (tempDir) => {
    const targetPath = path.join(tempDir, "massa-ai-vault", "config.json");
    const { envPath, localNotesConfigPath } = writeFixtures(tempDir);

    await withSavedEnv(["MASSA_VAULT_HOME_CONFIG"], async () => {
      process.env.MASSA_VAULT_HOME_CONFIG = targetPath;
      const { cli, calls } = harness(["config", "migrate"], { envPath, localNotesConfigPath });
      await cli.main();
      assert.ok(fs.existsSync(targetPath));
      assert.ok(calls.log.some((line) => line.includes(`wrote ${targetPath}`)));
    });
  });
});
