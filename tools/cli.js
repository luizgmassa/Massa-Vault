#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { gitHasRepo, gitInit, gitRemoteSetUrl } from "./notes-automation/src/git.js";
import { listRcloneRemotes, validateRcloneRemotePath } from "./notes-automation/src/gdrive.js";
import { loadLocalEnv } from "./shared/env.js";

loadLocalEnv();

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
  if (["y", "yes", "true", "1"].includes(normalized)) return true;
  if (["n", "no", "false", "0"].includes(normalized)) return false;
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
      ".DS_Store",
      "**/.DS_Store",
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
    gdrive_resync_mode: "newer",
    gdrive_first_run_resync: true,
    gdrive_args: [
      "--exclude",
      ".git/**",
      "--exclude",
      ".obsidian/workspace.json",
      "--exclude",
      ".automation/**",
      "--exclude",
      ".DS_Store",
      "--exclude",
      "**/.DS_Store"
    ]
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
  let gdriveMode = "bisync";
  if (syncStrategy === "gdrive" || syncStrategy === "both") {
    const remotes = listRcloneRemotesSafe();
    if (remotes.length) {
      console.log(`[vault-cli] detected rclone remotes: ${remotes.join(", ")}`);
    } else {
      console.log("[vault-cli] no rclone remotes detected. Run `rclone config` first.");
    }
    console.log(
      "[vault-cli] Google Drive path must use remote:path syntax, e.g. Personal:Obsidian (not /Obsidian)."
    );

    while (true) {
      const remotePathAnswer = await rl.question("Google Drive remote path (e.g. Personal:Obsidian): ");
      const candidate = remotePathAnswer.trim();
      const validation = validateRcloneRemotePath(candidate, remotes);
      if (validation.ok) {
        gdriveRemotePath = candidate;
        break;
      }
      console.log(`[vault-cli] ${validation.error}`);
    }

    console.log("[vault-cli] Google Drive mode is fixed to bisync for safe two-way sync.");
    gdriveMode = "bisync";
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
  if (command === "check") {
    return proxyNotes("gdrive-check");
  }
  if (command === "dry-run") {
    return proxyNotes("gdrive-dry-run");
  }
  console.error("Usage: npm run vault -- gdrive <check|dry-run>");
  process.exit(1);
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
    if (sub === "conflicts") return proxyNotes("sync-conflicts");
    if (sub === "resolve") return proxyNotes("sync-resolve", ...(process.argv.slice(4)));
    if (sub === "status") return proxyNotes("status");
    console.error("Usage: npm run vault -- sync [conflicts|resolve|status]");
    process.exit(1);
  }
  if (["start", "stop", "status", "resume", "flush-sync", "flush-push"].includes(cmd)) {
    return proxyNotes(cmd);
  }

  console.log("Usage:");
  console.log("  npm run vault:install");
  console.log("  npm run vault:configure");
  console.log("  npm run vault:chat");
  console.log("  npm run vault:sync");
  console.log("  npm run vault -- gdrive check|dry-run");
  console.log("  npm run vault:start|vault:stop|vault:status|vault:resume|vault:flush-sync");
  console.log("  # or");
  console.log(
    "  npm run vault -- install|configure|chat|gdrive|sync|start|stop|status|resume|flush-sync"
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[vault-cli] ${message}`);
  process.exit(1);
});
