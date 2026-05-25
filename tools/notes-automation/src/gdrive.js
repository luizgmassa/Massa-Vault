import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function runRclone(binary, args) {
  const output = execFileSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return output.trim();
}

function firstRunMarker(vaultPath) {
  return path.join(vaultPath, ".automation", "gdrive-resync.done");
}

export function syncToGoogleDrive(vaultPath, gdriveConfig) {
  if (!gdriveConfig.enabled) {
    return { ok: true, skipped: true, reason: "gdrive disabled" };
  }

  if (!gdriveConfig.remotePath) {
    return { ok: false, error: "Missing gdrive_remote_path in config." };
  }

  const mode = String(gdriveConfig.mode || "copy").toLowerCase();
  let command = "copy";
  if (mode === "sync") command = "sync";
  if (mode === "bisync") command = "bisync";

  const args = [command, vaultPath, gdriveConfig.remotePath, ...gdriveConfig.args];

  if (command === "bisync") {
    const marker = firstRunMarker(vaultPath);
    const hasMarker = fs.existsSync(marker);
    if (!hasMarker && gdriveConfig.firstRunResync) {
      args.push("--resync");
    }
  }

  try {
    const output = runRclone(gdriveConfig.binary, args);

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

