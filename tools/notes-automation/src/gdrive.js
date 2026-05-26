import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runCommand(binary, args, run = execFileSync) {
  const output = run(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return output.trim();
}

function listRemotesHint(availableRemotes) {
  if (!availableRemotes.length) {
    return "No rclone remotes detected. Run `rclone config` first.";
  }
  return `Available remotes: ${availableRemotes.join(", ")}`;
}

function looksLikeLocalPath(value) {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    value.startsWith("~\\") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export function listRcloneRemotes(binary = "rclone", run = execFileSync) {
  const raw = runCommand(binary, ["listremotes"], run);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/:$/, ""));
}

export function validateRcloneRemotePath(remotePath, availableRemotes = []) {
  const value = String(remotePath || "").trim();
  if (!value) {
    return {
      ok: false,
      error: "Missing gdrive_remote_path in config (expected remote:path, e.g. Personal:Obsidian)."
    };
  }

  if (looksLikeLocalPath(value)) {
    const suffix = value.replace(/^\/+/, "");
    const suggestedRemote = availableRemotes[0] || "your-remote";
    return {
      ok: false,
      error:
        `Invalid gdrive_remote_path "${value}". This looks like a local filesystem path, not an rclone remote path. ` +
        `Use remote:path format, e.g. ${suggestedRemote}:${suffix || "Obsidian"}. ` +
        listRemotesHint(availableRemotes)
    };
  }

  const separator = value.indexOf(":");
  if (separator <= 0) {
    return {
      ok: false,
      error:
        `Invalid gdrive_remote_path "${value}". Expected remote:path format (for example Personal:Obsidian). ` +
        listRemotesHint(availableRemotes)
    };
  }

  const remoteName = value.slice(0, separator).trim();
  if (!remoteName) {
    return {
      ok: false,
      error:
        `Invalid gdrive_remote_path "${value}". Missing remote name before ':'. ` +
        listRemotesHint(availableRemotes)
    };
  }

  if (availableRemotes.length && !availableRemotes.includes(remoteName)) {
    return {
      ok: false,
      error:
        `Remote "${remoteName}" from gdrive_remote_path "${value}" was not found in rclone config. ` +
        listRemotesHint(availableRemotes)
    };
  }

  return { ok: true, remoteName, remotePath: value };
}

function firstRunMarker(vaultPath) {
  return path.join(vaultPath, ".automation", "gdrive-resync.done");
}

export function syncToGoogleDrive(
  vaultPath,
  gdriveConfig,
  { run = execFileSync, availableRemotes } = {}
) {
  if (!gdriveConfig.enabled) {
    return { ok: true, skipped: true, reason: "gdrive disabled" };
  }

  let remotes = [];
  try {
    remotes = Array.isArray(availableRemotes)
      ? availableRemotes
      : listRcloneRemotes(gdriveConfig.binary, run);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to inspect rclone remotes: ${String(error?.stderr || error?.message || error)}`
    };
  }

  const pathValidation = validateRcloneRemotePath(gdriveConfig.remotePath, remotes);
  if (!pathValidation.ok) {
    return { ok: false, error: pathValidation.error };
  }

  const mode = String(gdriveConfig.mode || "copy").toLowerCase();
  let command = "copy";
  if (mode === "sync") command = "sync";
  if (mode === "bisync") command = "bisync";

  const args = [command, vaultPath, pathValidation.remotePath, ...gdriveConfig.args];

  if (command === "bisync") {
    const marker = firstRunMarker(vaultPath);
    const hasMarker = fs.existsSync(marker);
    if (!hasMarker && gdriveConfig.firstRunResync) {
      args.push("--resync");
    }
  }

  try {
    const output = runCommand(gdriveConfig.binary, args, run);

    if (command === "bisync") {
      const marker = firstRunMarker(vaultPath);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString(), "utf8");
    }

    return { ok: true, output, command, args };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.stderr || error?.message || error),
      command,
      args
    };
  }
}
