import "./helpers/neutralize-home-config.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_GIT_BRANCH,
  DEFAULT_GIT_REMOTE
} from "../tools/notes-automation/src/infrastructure/config-constants.js";
import {
  GDRIVE_COMMANDS,
  NOTES_PROXY_COMMANDS,
  SERVER_PROXY_COMMANDS,
  SYNC_COMMANDS,
  USAGE_LINES,
  createVaultCli,
  parseYN
} from "../tools/cli.js";

const NOTES_CLI = path.resolve("tools/notes-automation/src/cli.js");
const CHAT_CLI = path.resolve("tools/llm-chat-cli/src/cli.js");
const SERVER_CLI = path.resolve("tools/server/src/cli.js");

class ExitSignal extends Error {
  constructor(code) {
    super(`exit:${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-dispatch-"));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Builds a CLI whose every side effect is captured instead of performed.
 *
 * `exit` throws `ExitSignal` so injected stubs reproduce the real
 * `process.exit` control flow, which never returns.
 */
function harness(argvTail, overrides = {}) {
  const calls = { runTool: [], runToolInteractive: [], log: [], logError: [] };
  const cli = createVaultCli({
    argv: ["node", "cli.js", ...argvTail],
    runToolImpl: (command, args) => {
      calls.runTool.push({ command, args });
      return { status: 0 };
    },
    runToolInteractiveImpl: async (command, args) => {
      calls.runToolInteractive.push({ command, args });
      return 0;
    },
    checkBinaryImpl: (bin) => ({ ok: true, output: `${bin} 1.0.0` }),
    listRcloneRemotesImpl: () => ["Personal"],
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

test("vault cli prints usage for no command and for an unknown command", async () => {
  for (const argvTail of [[], ["bogus"], ["help"]]) {
    const { cli, calls } = harness(argvTail);
    await cli.main();
    assert.deepEqual(calls.log, [...USAGE_LINES]);
    assert.deepEqual(calls.runTool, []);
    assert.deepEqual(calls.logError, []);
  }
});

test("vault cli gdrive resolves check and dry-run to notes subcommands", async () => {
  const cases = [
    { argv: ["gdrive"], expected: "gdrive-check" },
    { argv: ["gdrive", "check"], expected: "gdrive-check" },
    { argv: ["gdrive", "CHECK"], expected: "gdrive-check" },
    { argv: ["gdrive", "dry-run"], expected: "gdrive-dry-run" },
    { argv: ["gdrive-check"], expected: "gdrive-check" },
    { argv: ["gdrive-dry-run"], expected: "gdrive-dry-run" }
  ];
  for (const { argv, expected } of cases) {
    const { cli, calls } = harness(argv);
    await cli.main();
    assert.deepEqual(calls.runTool, [
      { command: process.execPath, args: [NOTES_CLI, expected] }
    ]);
  }
});

test("vault cli gdrive rejects an unknown subcommand with exit 1 and never prints general usage", async () => {
  const { cli, calls } = harness(["gdrive", "badcmd"]);
  await expectExit(() => cli.main(), 1);
  assert.deepEqual(calls.logError, ["Usage: npm run vault -- gdrive <check|dry-run>"]);
  assert.deepEqual(calls.log, []);
  assert.deepEqual(calls.runTool, []);
});

test("vault cli sync dispatches every SYNC_COMMANDS arm and forwards resolve flags", async () => {
  const cases = [
    { argv: ["sync"], expected: ["sync"] },
    { argv: ["sync", "conflicts"], expected: ["sync-conflicts"] },
    { argv: ["sync", "CONFLICTS"], expected: ["sync-conflicts"] },
    { argv: ["sync", "status"], expected: ["status"] },
    { argv: ["sync", "resolve"], expected: ["sync-resolve"] },
    { argv: ["sync", "resolve", "--done"], expected: ["sync-resolve", "--done"] }
  ];
  for (const { argv, expected } of cases) {
    const { cli, calls } = harness(argv);
    await cli.main();
    assert.deepEqual(calls.runTool, [
      { command: process.execPath, args: [NOTES_CLI, ...expected] }
    ]);
  }
});

test("vault cli sync rejects an unknown subcommand with exit 1 and never prints general usage", async () => {
  const { cli, calls } = harness(["sync", "badsub"]);
  await expectExit(() => cli.main(), 1);
  assert.deepEqual(calls.logError, ["Usage: npm run vault -- sync [conflicts|resolve|status]"]);
  assert.deepEqual(calls.log, []);
  assert.deepEqual(calls.runTool, []);
});

test("vault cli proxies server commands with trailing arguments", async () => {
  for (const cmd of SERVER_PROXY_COMMANDS) {
    const { cli, calls } = harness([cmd, "--json"]);
    await cli.main();
    assert.deepEqual(calls.runTool, [
      { command: process.execPath, args: [SERVER_CLI, cmd, "--json"] }
    ]);
  }
});

test("vault cli proxies notes commands", async () => {
  for (const cmd of NOTES_PROXY_COMMANDS) {
    const { cli, calls } = harness([cmd]);
    await cli.main();
    assert.deepEqual(calls.runTool, [
      { command: process.execPath, args: [NOTES_CLI, cmd] }
    ]);
  }
});

test("vault cli chat forwards arguments to the chat entrypoint", async () => {
  const { cli, calls } = harness(["chat", "--system", "be terse", "hello"]);
  await cli.main();
  assert.deepEqual(calls.runToolInteractive, [
    { command: process.execPath, args: [CHAT_CLI, "--system", "be terse", "hello"] }
  ]);
});

test("vault cli propagates a non-zero proxy exit status", async () => {
  const { cli } = harness(["status"], {
    runToolImpl: () => ({ status: 3 })
  });
  await expectExit(() => cli.main(), 3);
});

test("vault cli maps a null proxy status to exit 1", async () => {
  const { cli } = harness(["resume"], {
    runToolImpl: () => ({ status: null })
  });
  await expectExit(() => cli.main(), 1);
});

test("vault cli maps a non-zero interactive chat status to the same exit code", async () => {
  const { cli } = harness(["chat"], {
    runToolInteractiveImpl: async () => 7
  });
  await expectExit(() => cli.main(), 7);
});

test("vault cli maps a zero-but-falsy interactive chat status to exit 1", async () => {
  const { cli } = harness(["chat"], {
    runToolInteractiveImpl: async () => null
  });
  await expectExit(() => cli.main(), 1);
});

test("vault cli install reports every binary check and detected remotes", async () => {
  const { cli, calls } = harness(["install"]);
  await cli.main();
  assert.ok(calls.log.includes("[vault-cli] node: node 1.0.0"));
  assert.ok(calls.log.includes("[vault-cli] git: git 1.0.0"));
  assert.ok(calls.log.includes("[vault-cli] rclone: rclone 1.0.0"));
  assert.ok(calls.log.includes("[vault-cli] rclone remotes: Personal"));
  assert.deepEqual(calls.runTool, [
    { command: "bash", args: ["tools/security/install-hooks.sh"] }
  ]);
});

test("vault cli install reports missing binaries and absent remotes", async () => {
  const { cli, calls } = harness(["install"], {
    checkBinaryImpl: () => ({ ok: false, output: "" }),
    listRcloneRemotesImpl: () => []
  });
  await cli.main();
  assert.ok(calls.log.includes("[vault-cli] node: missing"));
  assert.ok(calls.log.includes("[vault-cli] rclone remotes: none found"));
  assert.ok(
    calls.log.includes(
      "[vault-cli] run `rclone config` and create a remote before enabling gdrive sync"
    )
  );
});

test("vault cli install warns when the git hook installer fails", async () => {
  const { cli, calls } = harness(["install"], {
    runToolImpl: () => ({ status: 1 })
  });
  await cli.main();
  assert.ok(
    calls.log.some((line) => line.includes("warning: hook auto-install failed")),
    `expected a hook warning, got ${JSON.stringify(calls.log)}`
  );
});

test("vault cli treats an rclone listing failure as no remotes", async () => {
  const { cli, calls } = harness(["install"], {
    listRcloneRemotesImpl: () => {
      throw new Error("rclone not installed");
    }
  });
  await cli.main();
  assert.ok(calls.log.includes("[vault-cli] rclone remotes: none found"));
});

function scriptedInterface(answers) {
  const asked = [];
  let index = 0;
  return {
    asked,
    closed: false,
    factory(self) {
      return () => ({
        question: async (promptText) => {
          asked.push(promptText);
          return answers[index++] ?? "";
        },
        close: () => {
          self.closed = true;
        }
      });
    }
  };
}

test("vault cli configure writes a git-remote config and initializes the vault repo", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config", "notes-automation.config.json");
    const vaultPath = path.join(tempDir, "vault");
    const gitCalls = [];
    const scripted = scriptedInterface([
      vaultPath,
      "git",
      "remote",
      "git@example.com:me/vault.git",
      "",
      "",
      "y"
    ]);
    const { cli, calls } = harness(["configure"], {
      configPath,
      createInterfaceImpl: scripted.factory(scripted),
      homedir: () => tempDir,
      gitHasRepoImpl: () => false,
      gitInitImpl: (target) => gitCalls.push(["init", target]),
      gitRemoteSetUrlImpl: (remote, url, target) => gitCalls.push(["remote", remote, url, target])
    });

    await cli.main();

    assert.equal(scripted.closed, true);
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(written.vault_path, vaultPath);
    assert.equal(written.sync_strategy, "git");
    assert.equal(written.git_mode, "remote");
    assert.equal(written.git_repo_url, "git@example.com:me/vault.git");
    assert.equal(written.git_auto_push, true);
    assert.equal(written.remote, DEFAULT_GIT_REMOTE);
    assert.equal(written.branch, DEFAULT_GIT_BRANCH);
    assert.equal(fs.existsSync(vaultPath), true);
    assert.deepEqual(gitCalls, [
      ["init", vaultPath],
      ["remote", "origin", "git@example.com:me/vault.git", vaultPath]
    ]);
    assert.ok(calls.log.includes(`[vault-cli] wrote ${configPath}`));
  });
});

test("vault cli configure local git mode skips the remote prompts and disables auto-push", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config", "notes-automation.config.json");
    const vaultPath = path.join(tempDir, "vault");
    const scripted = scriptedInterface([vaultPath, "git", "local"]);
    const { cli } = harness(["configure"], {
      configPath,
      createInterfaceImpl: scripted.factory(scripted),
      homedir: () => tempDir,
      gitHasRepoImpl: () => true,
      gitInitImpl: () => assert.fail("gitInit must not run when the repo already exists"),
      gitRemoteSetUrlImpl: () => assert.fail("local mode must not configure a remote")
    });

    await cli.main();

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(written.git_mode, "local");
    assert.equal(written.git_auto_push, false);
  });
});

test("vault cli configure re-prompts until the gdrive remote path validates", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config", "notes-automation.config.json");
    const vaultPath = path.join(tempDir, "vault");
    const scripted = scriptedInterface([vaultPath, "gdrive", "/Obsidian", "Personal:Obsidian"]);
    const { cli, calls } = harness(["configure"], {
      configPath,
      createInterfaceImpl: scripted.factory(scripted),
      homedir: () => tempDir,
      validateRcloneRemotePathImpl: (candidate) =>
        candidate === "Personal:Obsidian"
          ? { ok: true }
          : { ok: false, error: "must use remote:path syntax" }
    });

    await cli.main();

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(written.gdrive_remote_path, "Personal:Obsidian");
    assert.ok(calls.log.includes("[vault-cli] must use remote:path syntax"));
    assert.ok(calls.log.includes("[vault-cli] detected rclone remotes: Personal"));
  });
});

test("vault cli configure reports when no rclone remotes are configured", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config", "notes-automation.config.json");
    const scripted = scriptedInterface([path.join(tempDir, "vault"), "gdrive", "Personal:Obsidian"]);
    const { cli, calls } = harness(["configure"], {
      configPath,
      createInterfaceImpl: scripted.factory(scripted),
      homedir: () => tempDir,
      listRcloneRemotesImpl: () => [],
      validateRcloneRemotePathImpl: () => ({ ok: true })
    });

    await cli.main();

    assert.ok(
      calls.log.includes("[vault-cli] no rclone remotes detected. Run `rclone config` first.")
    );
  });
});

test("vault cli configure falls back to the default vault path when the answer is blank", async () => {
  await withTempDir(async (tempDir) => {
    const configPath = path.join(tempDir, "config", "notes-automation.config.json");
    const scripted = scriptedInterface(["", "git", "local"]);
    const { cli } = harness(["configure"], {
      configPath,
      createInterfaceImpl: scripted.factory(scripted),
      homedir: () => tempDir,
      gitHasRepoImpl: () => true
    });

    await cli.main();

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(written.vault_path, path.join(tempDir, "ObsidianVault"));
  });
});

test("parseYN maps affirmative, negative, blank, and unrecognized answers", () => {
  for (const value of ["y", "Yes", "TRUE", "1", " y "]) {
    assert.equal(parseYN(value, false), true, `expected ${value} to be true`);
  }
  for (const value of ["n", "No", "false", "0"]) {
    assert.equal(parseYN(value, true), false, `expected ${value} to be false`);
  }
  assert.equal(parseYN("", true), true);
  assert.equal(parseYN("", false), false);
  assert.equal(parseYN(undefined, true), true);
  assert.equal(parseYN("maybe", true), true);
  assert.equal(parseYN("maybe", false), false);
});

test("vault cli command tables stay in sync with the documented usage banner", () => {
  assert.deepEqual([...GDRIVE_COMMANDS.keys()], ["check", "dry-run"]);
  assert.deepEqual([...SYNC_COMMANDS.keys()], ["conflicts", "resolve", "status"]);

  // Every dispatchable proxy command must appear in the usage banner; this
  // catches a new command landing without its docs line.
  const undocumented = [...SERVER_PROXY_COMMANDS, ...NOTES_PROXY_COMMANDS].filter(
    (cmd) => !USAGE_LINES.some((line) => line.includes(cmd))
  );
  assert.deepEqual(undocumented, []);
});
