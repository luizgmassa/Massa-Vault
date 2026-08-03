#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assertRepoRootCwd } from "./shared/repo-root.js";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_GDRIVE_MODE,
  DEFAULT_GIT_AUTO_PUSH,
  DEFAULT_GIT_BRANCH,
  DEFAULT_GIT_MODE,
  DEFAULT_GIT_REMOTE,
  DEFAULT_SYNC_STRATEGY
} from "./notes-automation/src/infrastructure/config-constants.js";
import { gitHasRepo, gitInit, gitRemoteSetUrl } from "./notes-automation/src/infrastructure/git.js";
import {
  listRcloneRemotes,
  validateRcloneRemotePath
} from "./notes-automation/src/infrastructure/gdrive.js";
import { GDRIVE_REMOTE_PATH_EXAMPLE } from "./notes-automation/src/infrastructure/gdrive-constants.js";
import { createConfigDocument } from "./notes-automation/src/infrastructure/config-definition.js";
import { loadRuntimeEnv } from "./shared/runtime-env.js";
import { buildHomeConfigDocument, resolveHomeConfigPath } from "./shared/home-config.js";
import { parseEnvContent } from "./shared/env.js";

const CONFIG_PATH = path.resolve("config/notes-automation.config.json");
const NOTES_CLI = path.resolve("tools/notes-automation/src/cli.js");
const CHAT_CLI = path.resolve("tools/llm-chat-cli/src/cli.js");
const SERVER_CLI = path.resolve("tools/server/src/cli.js");
const ENV_PATH = path.resolve(".env");
const LOCAL_NOTES_CONFIG_PATH = path.resolve("config/notes-automation.local.json");
const TRUE_LIKE = new Set(["y", "yes", "true", "1"]);
const FALSE_LIKE = new Set(["n", "no", "false", "0"]);
const GDRIVE_COMMANDS = new Map([
  ["check", "gdrive-check"],
  ["dry-run", "gdrive-dry-run"]
]);
const SYNC_COMMANDS = new Map([
  ["conflicts", ["sync-conflicts"]],
  ["resolve", ["sync-resolve"]],
  ["status", ["status"]]
]);
const CONFIG_COMMANDS = new Map([
  ["path", "config-path"],
  ["migrate", "config-migrate"]
]);
const SERVER_PROXY_COMMANDS = new Set(["start", "stop", "status", "restart"]);
const NOTES_PROXY_COMMANDS = new Set(["resume", "flush-sync", "flush-push"]);
const USAGE_LINES = Object.freeze([
  "Usage:",
  "  npm run vault:install",
  "  npm run vault:configure",
  "  npm run vault:chat",
  "  npm run vault:sync",
  "  npm run server:start|server:stop|server:status",
  "  npm run vault -- gdrive check|dry-run",
  "  npm run vault -- config path|migrate [--force] [--dry-run]",
  "  npm run vault:start|vault:stop|vault:status|vault:resume|vault:flush-sync",
  "  # or",
  "  npm run vault -- install|configure|chat|gdrive|sync|config|start|stop|status|restart|resume|flush-sync|flush-push"
]);

function runTool(command, args = []) {
  return spawnSync(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env
  });
}

function runToolInteractive(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(typeof code === "number" ? code : 1);
    });
  });
}

function checkBinary(bin, versionArg = "--version") {
  try {
    const out = execFileSync(bin, [versionArg], { encoding: "utf8" }).trim();
    return { ok: true, output: out.split("\n")[0] };
  } catch {
    return { ok: false, output: "" };
  }
}

export function parseYN(value, defaultValue = true) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (TRUE_LIKE.has(normalized)) return true;
  if (FALSE_LIKE.has(normalized)) return false;
  return defaultValue;
}

function buildConfig({
  vaultPath,
  syncStrategy,
  gitMode,
  gitRepoUrl,
  gitRemote,
  gitBranch,
  gitAutoPush,
  gdriveRemotePath,
  gdriveMode
}) {
  return createConfigDocument({
    vaultPath,
    syncStrategy,
    gitMode,
    gitRepoUrl,
    gitRemote,
    gitBranch,
    gitAutoPush,
    gdriveRemotePath,
    gdriveMode
  });
}

/**
 * Builds the `massa-vault` client CLI with every side-effecting collaborator
 * injected behind a named default.
 *
 * The defaults reproduce the production wiring exactly, so `createVaultCli()`
 * with no arguments behaves identically to the pre-seam module-level code. The
 * seam exists so command dispatch, usage fallbacks, and exit-code propagation
 * can be asserted in-process: this file is otherwise only reachable by spawning
 * it as a subprocess, which node's coverage instrumentation cannot observe.
 *
 * Note for callers passing `exit`: the real `process.exit` never returns, so an
 * injected `exit` should throw a sentinel to reproduce that control flow. The
 * one call site where a non-throwing stub would otherwise fall through to the
 * usage banner carries an explicit `return`.
 */
export function createVaultCli({
  argv = process.argv,
  runToolImpl = runTool,
  runToolInteractiveImpl = runToolInteractive,
  checkBinaryImpl = checkBinary,
  listRcloneRemotesImpl = listRcloneRemotes,
  validateRcloneRemotePathImpl = validateRcloneRemotePath,
  createInterfaceImpl = readline.createInterface,
  gitHasRepoImpl = gitHasRepo,
  gitInitImpl = gitInit,
  gitRemoteSetUrlImpl = gitRemoteSetUrl,
  fsImpl = fs,
  homedir = os.homedir,
  log = console.log,
  logError = console.error,
  exit = (code) => process.exit(code),
  configPath = CONFIG_PATH,
  notesCliPath = NOTES_CLI,
  chatCliPath = CHAT_CLI,
  serverCliPath = SERVER_CLI,
  envPath = ENV_PATH,
  localNotesConfigPath = LOCAL_NOTES_CONFIG_PATH,
  stdin = input,
  stdout = output
} = {}) {
  function listRcloneRemotesSafe() {
    try {
      return listRcloneRemotesImpl("rclone");
    } catch {
      return [];
    }
  }

  async function configure() {
    const rl = createInterfaceImpl({ input: stdin, output: stdout });
    const defaultVaultPath = path.join(homedir(), "ObsidianVault");

    const vaultAnswer = await rl.question(`Vault path [${defaultVaultPath}]: `);
    const vaultPath = path.resolve(vaultAnswer.trim() || defaultVaultPath);

    const syncAnswer = await rl.question(
      `Sync strategy (git|gdrive|both) [${DEFAULT_SYNC_STRATEGY}]: `
    );
    const syncStrategy = (syncAnswer.trim() || DEFAULT_SYNC_STRATEGY).toLowerCase();

    let gitMode = DEFAULT_GIT_MODE;
    let gitRepoUrl = "";
    let gitRemote = DEFAULT_GIT_REMOTE;
    let gitBranch = DEFAULT_GIT_BRANCH;
    let gitAutoPush = DEFAULT_GIT_AUTO_PUSH;

    if (syncStrategy === "git" || syncStrategy === "both") {
      const modeAnswer = await rl.question(`Git mode (remote|local) [${DEFAULT_GIT_MODE}]: `);
      gitMode = (modeAnswer.trim() || DEFAULT_GIT_MODE).toLowerCase();

      if (gitMode === DEFAULT_GIT_MODE) {
        gitRepoUrl = (await rl.question("Git repo URL (ssh/https/file path): ")).trim();
        const remoteAnswer = await rl.question(`Git remote name [${DEFAULT_GIT_REMOTE}]: `);
        gitRemote = remoteAnswer.trim() || DEFAULT_GIT_REMOTE;
        const branchAnswer = await rl.question(`Git branch [${DEFAULT_GIT_BRANCH}]: `);
        gitBranch = branchAnswer.trim() || DEFAULT_GIT_BRANCH;
        const autoPushAnswer = await rl.question("Auto-push enabled? (y/n) [y]: ");
        gitAutoPush = parseYN(autoPushAnswer, DEFAULT_GIT_AUTO_PUSH);
      } else {
        gitAutoPush = false;
      }
    }

    let gdriveRemotePath = "";
    let gdriveMode = DEFAULT_GDRIVE_MODE;
    if (syncStrategy === "gdrive" || syncStrategy === "both") {
      const remotes = listRcloneRemotesSafe();
      if (remotes.length) {
        log(`[vault-cli] detected rclone remotes: ${remotes.join(", ")}`);
      } else {
        log("[vault-cli] no rclone remotes detected. Run `rclone config` first.");
      }
      log(
        `[vault-cli] Google Drive path must use remote:path syntax, e.g. ${GDRIVE_REMOTE_PATH_EXAMPLE} (not /Obsidian).`
      );

      while (true) {
        const remotePathAnswer = await rl.question(
          `Google Drive remote path (e.g. ${GDRIVE_REMOTE_PATH_EXAMPLE}): `
        );
        const candidate = remotePathAnswer.trim();
        const validation = validateRcloneRemotePathImpl(candidate, remotes);
        if (validation.ok) {
          gdriveRemotePath = candidate;
          break;
        }
        log(`[vault-cli] ${validation.error}`);
      }

      log(
        `[vault-cli] Google Drive mode is fixed to ${DEFAULT_GDRIVE_MODE} for safe two-way sync.`
      );
      gdriveMode = DEFAULT_GDRIVE_MODE;
    }

    rl.close();

    const config = buildConfig({
      vaultPath,
      syncStrategy,
      gitMode,
      gitRepoUrl,
      gitRemote,
      gitBranch,
      gitAutoPush,
      gdriveRemotePath,
      gdriveMode
    });

    fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });
    fsImpl.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    log(`[vault-cli] wrote ${configPath}`);

    fsImpl.mkdirSync(vaultPath, { recursive: true });

    if (syncStrategy === "git" || syncStrategy === "both") {
      if (!gitHasRepoImpl(vaultPath)) {
        gitInitImpl(vaultPath);
        log(`[vault-cli] initialized git repo at ${vaultPath}`);
      }
      if (gitMode === "remote" && gitRepoUrl) {
        gitRemoteSetUrlImpl(gitRemote, gitRepoUrl, vaultPath);
        log(`[vault-cli] configured git remote ${gitRemote} -> ${gitRepoUrl}`);
      }
    }
  }

  function install() {
    const checks = [
      ["node", checkBinaryImpl("node", "--version")],
      ["git", checkBinaryImpl("git", "--version")],
      ["rclone", checkBinaryImpl("rclone", "version")]
    ];

    for (const [name, result] of checks) {
      if (!result.ok) {
        log(`[vault-cli] ${name}: missing`);
      } else {
        log(`[vault-cli] ${name}: ${result.output}`);
      }
    }

    const remotes = listRcloneRemotesSafe();
    if (remotes.length) {
      log(`[vault-cli] rclone remotes: ${remotes.join(", ")}`);
      log("[vault-cli] gdrive_remote_path format: <remote>:<path> (example: Personal:Obsidian)");
    } else {
      log("[vault-cli] rclone remotes: none found");
      log("[vault-cli] run `rclone config` and create a remote before enabling gdrive sync");
    }

    const hookInstall = runToolImpl("bash", ["tools/security/install-hooks.sh"]);
    if (hookInstall.status !== 0) {
      log(
        "[vault-cli] warning: hook auto-install failed. Run manually when git permissions are available: npm run hooks:install"
      );
    }
  }

  function proxyNotes(...args) {
    const result = runToolImpl(process.execPath, [notesCliPath, ...args]);
    if (result.status !== 0) exit(result.status || 1);
  }

  function proxyServer(...args) {
    const result = runToolImpl(process.execPath, [serverCliPath, ...args]);
    if (result.status !== 0) exit(result.status || 1);
  }

  async function proxyChat(args) {
    const status = await runToolInteractiveImpl(process.execPath, [chatCliPath, ...args]);
    if (status !== 0) exit(status || 1);
  }

  function proxyGDrive(command) {
    const resolved = GDRIVE_COMMANDS.get(command);
    if (resolved) {
      return proxyNotes(resolved);
    }
    logError("Usage: npm run vault -- gdrive <check|dry-run>");
    exit(1);
  }

  function readEnvFileValues() {
    if (!fsImpl.existsSync(envPath)) return {};
    return parseEnvContent(fsImpl.readFileSync(envPath, "utf8"));
  }

  function readLocalNotesDocument() {
    if (!fsImpl.existsSync(localNotesConfigPath)) return {};
    try {
      return JSON.parse(fsImpl.readFileSync(localNotesConfigPath, "utf8"));
    } catch {
      return {};
    }
  }

  function configPathCommand() {
    const resolved = resolveHomeConfigPath({ homedir });
    log(resolved || "");
  }

  function configMigrate(args = []) {
    const force = args.includes("--force");
    const dryRun = args.includes("--dry-run");

    const targetPath = resolveHomeConfigPath({ homedir });
    if (!targetPath) {
      logError(
        "[vault-cli] home config is disabled (MASSA_VAULT_HOME_CONFIG=off); nothing to migrate."
      );
      exit(1);
      return;
    }

    const document = buildHomeConfigDocument({
      envValues: readEnvFileValues(),
      localNotesDocument: readLocalNotesDocument()
    });

    const vaultPath = document.notes && document.notes.vault_path;
    if (!vaultPath) {
      logError(
        "[vault-cli] refusing to migrate: notes.vault_path is missing or empty. Run `massa-vault configure` first."
      );
      exit(1);
      return;
    }

    if (dryRun) {
      log(JSON.stringify(document, null, 2));
      return;
    }

    const exists = fsImpl.existsSync(targetPath);
    if (exists && !force) {
      logError(
        `[vault-cli] refusing to overwrite existing home config at ${targetPath}. Use --force to overwrite.`
      );
      exit(1);
      return;
    }

    const targetDir = path.dirname(targetPath);
    fsImpl.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies to directories it actually creates. This one
    // holds litellm.master_key, so tighten it unconditionally.
    fsImpl.chmodSync(targetDir, 0o700);
    if (exists) {
      fsImpl.rmSync(targetPath, { force: true });
    }
    fsImpl.writeFileSync(targetPath, JSON.stringify(document, null, 2), { mode: 0o600 });
    log(`[vault-cli] wrote ${targetPath}`);
  }

  function configCommand(sub, args) {
    const resolved = CONFIG_COMMANDS.get(sub);
    if (resolved === "config-path") return configPathCommand();
    if (resolved === "config-migrate") return configMigrate(args);
    logError("Usage: npm run vault -- config <path|migrate> [--force] [--dry-run]");
    exit(1);
  }

  function printUsage() {
    for (const line of USAGE_LINES) {
      log(line);
    }
  }

  async function main() {
    const cmd = argv[2] || "help";
    if (cmd === "install") return install();
    if (cmd === "configure") return configure();
    if (cmd === "chat") {
      return await proxyChat(argv.slice(3));
    }
    if (cmd === "gdrive") {
      return proxyGDrive((argv[3] || "check").toLowerCase());
    }
    if (cmd === "config") {
      return configCommand((argv[3] || "").toLowerCase(), argv.slice(4));
    }
    if (cmd === "gdrive-check") {
      return proxyNotes("gdrive-check");
    }
    if (cmd === "gdrive-dry-run") {
      return proxyNotes("gdrive-dry-run");
    }
    if (cmd === "sync") {
      const sub = (argv[3] || "").toLowerCase();
      if (!sub) return proxyNotes("sync");
      const syncCommand = SYNC_COMMANDS.get(sub);
      if (syncCommand) {
        return proxyNotes(...syncCommand, ...(sub === "resolve" ? argv.slice(4) : []));
      }
      logError("Usage: npm run vault -- sync [conflicts|resolve|status]");
      exit(1);
      return;
    }
    if (SERVER_PROXY_COMMANDS.has(cmd)) {
      return proxyServer(cmd, ...argv.slice(3));
    }
    if (NOTES_PROXY_COMMANDS.has(cmd)) {
      return proxyNotes(cmd);
    }

    printUsage();
  }

  return {
    configCommand,
    configMigrate,
    configPathCommand,
    configure,
    install,
    listRcloneRemotesSafe,
    main,
    printUsage,
    proxyChat,
    proxyGDrive,
    proxyNotes,
    proxyServer
  };
}

export async function main(options) {
  return createVaultCli(options).main();
}

export {
  CONFIG_COMMANDS,
  GDRIVE_COMMANDS,
  NOTES_PROXY_COMMANDS,
  SERVER_PROXY_COMMANDS,
  SYNC_COMMANDS,
  USAGE_LINES
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assertRepoRootCwd();
  // The one env load for this process (ARCH-3). Subcommands spawned from
  // here re-load in their own guards; first-writer-wins keeps the inherited
  // env idempotent.
  loadRuntimeEnv();
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[vault-cli] ${message}`);
    process.exit(1);
  });
}
