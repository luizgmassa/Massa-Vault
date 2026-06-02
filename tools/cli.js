#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  DEFAULT_GDRIVE_MODE,
  DEFAULT_GIT_AUTO_PUSH,
  DEFAULT_GIT_BRANCH,
  DEFAULT_GIT_MODE,
  DEFAULT_GIT_REMOTE,
  DEFAULT_SYNC_STRATEGY
} from "./notes-automation/src/config-constants.js";
import { gitHasRepo, gitInit, gitRemoteSetUrl } from "./notes-automation/src/git.js";
import { listRcloneRemotes, validateRcloneRemotePath } from "./notes-automation/src/gdrive.js";
import { GDRIVE_REMOTE_PATH_EXAMPLE } from "./notes-automation/src/gdrive-constants.js";
import { createConfigDocument } from "./notes-automation/src/config-definition.js";
import { loadLocalEnv } from "./shared/env.js";

loadLocalEnv();

const CONFIG_PATH = path.resolve("config/notes-automation.config.json");
const NOTES_CLI = path.resolve("tools/notes-automation/src/cli.js");
const CHAT_CLI = path.resolve("tools/llm-chat-cli/src/cli.js");
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
const NOTES_PROXY_COMMANDS = new Set(["start", "stop", "status", "resume", "flush-sync", "flush-push"]);
const USAGE_LINES = Object.freeze([
  "Usage:",
  "  npm run vault:install",
  "  npm run vault:configure",
  "  npm run vault:chat",
  "  npm run vault:sync",
  "  npm run vault -- gdrive check|dry-run",
  "  npm run vault:start|vault:stop|vault:status|vault:resume|vault:flush-sync",
  "  # or",
  "  npm run vault -- install|configure|chat|gdrive|sync|start|stop|status|resume|flush-sync"
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

function parseYN(value, defaultValue = true) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (TRUE_LIKE.has(normalized)) return true;
  if (FALSE_LIKE.has(normalized)) return false;
  return defaultValue;
}

function listRcloneRemotesSafe() {
  try {
    return listRcloneRemotes("rclone");
  } catch {
    return [];
  }
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

async function configure() {
  const rl = readline.createInterface({ input, output });
  const defaultVaultPath = path.join(os.homedir(), "ObsidianVault");

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
      console.log(`[vault-cli] detected rclone remotes: ${remotes.join(", ")}`);
    } else {
      console.log("[vault-cli] no rclone remotes detected. Run `rclone config` first.");
    }
    console.log(
      `[vault-cli] Google Drive path must use remote:path syntax, e.g. ${GDRIVE_REMOTE_PATH_EXAMPLE} (not /Obsidian).`
    );

    while (true) {
      const remotePathAnswer = await rl.question(
        `Google Drive remote path (e.g. ${GDRIVE_REMOTE_PATH_EXAMPLE}): `
      );
      const candidate = remotePathAnswer.trim();
      const validation = validateRcloneRemotePath(candidate, remotes);
      if (validation.ok) {
        gdriveRemotePath = candidate;
        break;
      }
      console.log(`[vault-cli] ${validation.error}`);
    }

    console.log(
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

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  console.log(`[vault-cli] wrote ${CONFIG_PATH}`);

  fs.mkdirSync(vaultPath, { recursive: true });

  if (syncStrategy === "git" || syncStrategy === "both") {
    if (!gitHasRepo(vaultPath)) {
      gitInit(vaultPath);
      console.log(`[vault-cli] initialized git repo at ${vaultPath}`);
    }
    if (gitMode === "remote" && gitRepoUrl) {
      gitRemoteSetUrl(gitRemote, gitRepoUrl, vaultPath);
      console.log(`[vault-cli] configured git remote ${gitRemote} -> ${gitRepoUrl}`);
    }
  }
}

function install() {
  const checks = [
    ["node", checkBinary("node", "--version")],
    ["git", checkBinary("git", "--version")],
    ["rclone", checkBinary("rclone", "version")]
  ];

  for (const [name, result] of checks) {
    if (!result.ok) {
      console.log(`[vault-cli] ${name}: missing`);
    } else {
      console.log(`[vault-cli] ${name}: ${result.output}`);
    }
  }

  const remotes = listRcloneRemotesSafe();
  if (remotes.length) {
    console.log(`[vault-cli] rclone remotes: ${remotes.join(", ")}`);
    console.log("[vault-cli] gdrive_remote_path format: <remote>:<path> (example: Personal:Obsidian)");
  } else {
    console.log("[vault-cli] rclone remotes: none found");
    console.log("[vault-cli] run `rclone config` and create a remote before enabling gdrive sync");
  }

  const hookInstall = runTool("bash", ["tools/security/install-hooks.sh"]);
  if (hookInstall.status !== 0) {
    console.log(
      "[vault-cli] warning: hook auto-install failed. Run manually when git permissions are available: npm run hooks:install"
    );
  }
}

function proxyNotes(...args) {
  const result = runTool(process.execPath, [NOTES_CLI, ...args]);
  if (result.status !== 0) process.exit(result.status || 1);
}

async function proxyChat(args) {
  const status = await runToolInteractive(process.execPath, [CHAT_CLI, ...args]);
  if (status !== 0) process.exit(status || 1);
}

function proxyGDrive(command) {
  const resolved = GDRIVE_COMMANDS.get(command);
  if (resolved) {
    return proxyNotes(resolved);
  }
  console.error("Usage: npm run vault -- gdrive <check|dry-run>");
  process.exit(1);
}

function printUsage() {
  for (const line of USAGE_LINES) {
    console.log(line);
  }
}

async function main() {
  const cmd = process.argv[2] || "help";
  if (cmd === "install") return install();
  if (cmd === "configure") return configure();
  if (cmd === "chat") {
    return await proxyChat(process.argv.slice(3));
  }
  if (cmd === "gdrive") {
    return proxyGDrive((process.argv[3] || "check").toLowerCase());
  }
  if (cmd === "gdrive-check") {
    return proxyNotes("gdrive-check");
  }
  if (cmd === "gdrive-dry-run") {
    return proxyNotes("gdrive-dry-run");
  }
  if (cmd === "sync") {
    const sub = (process.argv[3] || "").toLowerCase();
    if (!sub) return proxyNotes("sync");
    const syncCommand = SYNC_COMMANDS.get(sub);
    if (syncCommand) {
      return proxyNotes(...syncCommand, ...(sub === "resolve" ? process.argv.slice(4) : []));
    }
    console.error("Usage: npm run vault -- sync [conflicts|resolve|status]");
    process.exit(1);
  }
  if (NOTES_PROXY_COMMANDS.has(cmd)) {
    return proxyNotes(cmd);
  }

  printUsage();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[vault-cli] ${message}`);
  process.exit(1);
});
