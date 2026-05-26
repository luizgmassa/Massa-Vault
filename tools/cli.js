#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { gitHasRepo, gitInit, gitRemoteSetUrl } from "./notes-automation/src/git.js";

const CONFIG_PATH = path.resolve("config/notes-automation.config.json");
const NOTES_CLI = path.resolve("tools/notes-automation/src/cli.js");
const CHAT_CLI = path.resolve("tools/llm-chat-cli/src/cli.js");

function runTool(command, args = []) {
  return spawnSync(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env
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
  if (["y", "yes", "true", "1"].includes(normalized)) return true;
  if (["n", "no", "false", "0"].includes(normalized)) return false;
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
  return {
    enabled: true,
    vault_path: vaultPath,
    watch_paths: ["."],
    include_globs: [
      "**/*.md",
      "templates/**/*.md",
      ".obsidian/app.json",
      ".obsidian/community-plugins.json",
      ".obsidian/core-plugins.json"
    ],
    ignore_globs: [
      ".git/**",
      ".automation/**",
      ".obsidian/workspace.json",
      ".obsidian/plugins/**/data.json",
      ".obsidian/plugins/**/cache/**",
      ".obsidian/plugins/**/tmp/**",
      "**/*.png",
      "**/*.jpg",
      "**/*.jpeg",
      "**/*.gif",
      "**/*.pdf",
      "**/*.zip"
    ],
    push_interval_min: 10,
    debounce_ms: 1500,
    sync_strategy: syncStrategy,
    git_mode: gitMode,
    git_repo_url: gitRepoUrl,
    git_auto_push: gitAutoPush,
    remote: gitRemote,
    branch: gitBranch,
    gdrive_binary: "rclone",
    gdrive_remote_path: gdriveRemotePath,
    gdrive_mode: gdriveMode,
    gdrive_first_run_resync: true,
    gdrive_args: ["--exclude", ".git/**", "--exclude", ".obsidian/workspace.json"]
  };
}

async function configure() {
  const rl = readline.createInterface({ input, output });
  const defaultVaultPath = path.join(os.homedir(), "ObsidianVault");

  const vaultAnswer = await rl.question(`Vault path [${defaultVaultPath}]: `);
  const vaultPath = path.resolve(vaultAnswer.trim() || defaultVaultPath);

  const syncAnswer = await rl.question("Sync strategy (git|gdrive|both) [both]: ");
  const syncStrategy = (syncAnswer.trim() || "both").toLowerCase();

  let gitMode = "remote";
  let gitRepoUrl = "";
  let gitRemote = "origin";
  let gitBranch = "master";
  let gitAutoPush = true;

  if (syncStrategy === "git" || syncStrategy === "both") {
    const modeAnswer = await rl.question("Git mode (remote|local) [remote]: ");
    gitMode = (modeAnswer.trim() || "remote").toLowerCase();

    if (gitMode === "remote") {
      gitRepoUrl = (await rl.question("Git repo URL (ssh/https/file path): ")).trim();
      const remoteAnswer = await rl.question("Git remote name [origin]: ");
      gitRemote = remoteAnswer.trim() || "origin";
      const branchAnswer = await rl.question("Git branch [master]: ");
      gitBranch = branchAnswer.trim() || "master";
      const autoPushAnswer = await rl.question("Auto-push enabled? (y/n) [y]: ");
      gitAutoPush = parseYN(autoPushAnswer, true);
    } else {
      gitAutoPush = false;
    }
  }

  let gdriveRemotePath = "";
  let gdriveMode = "copy";
  if (syncStrategy === "gdrive" || syncStrategy === "both") {
    const remotePathAnswer = await rl.question("Google Drive remote path (e.g. gdrive:massa-vault): ");
    gdriveRemotePath = remotePathAnswer.trim();
    const gdriveModeAnswer = await rl.question("Google Drive sync mode (copy|sync|bisync) [copy]: ");
    gdriveMode = (gdriveModeAnswer.trim() || "copy").toLowerCase();
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

  const hookInstall = runTool("bash", ["tools/security/install-hooks.sh"]);
  if (hookInstall.status !== 0) {
    console.log(
      "[vault-cli] warning: hook auto-install failed. Run manually when git permissions are available: npm run hooks:install"
    );
  }
}

function proxyNotes(command) {
  const result = runTool(process.execPath, [NOTES_CLI, command]);
  if (result.status !== 0) process.exit(result.status || 1);
}

function proxyChat(args) {
  const result = runTool(process.execPath, [CHAT_CLI, ...args]);
  if (result.status !== 0) process.exit(result.status || 1);
}

async function main() {
  const cmd = process.argv[2] || "help";
  if (cmd === "install") return install();
  if (cmd === "configure") return configure();
  if (cmd === "chat") {
    return proxyChat(process.argv.slice(3));
  }
  if (["start", "stop", "status", "resume", "flush-sync", "flush-push"].includes(cmd)) {
    return proxyNotes(cmd);
  }

  console.log("Usage:");
  console.log("  npm run vault:install");
  console.log("  npm run vault:configure");
  console.log("  npm run vault:chat");
  console.log("  npm run vault:start|vault:stop|vault:status|vault:resume|vault:flush-sync");
  console.log("  # or");
  console.log("  npm run vault -- install|configure|chat|start|stop|status|resume|flush-sync");
}

await main();
