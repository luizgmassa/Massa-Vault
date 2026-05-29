import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROTECTED_ARTIFACT_GLOBS } from "./protected-artifacts.js";

const REQUIRED_GDRIVE_EXCLUDES = [
  ".git/**",
  ".obsidian/workspace.json",
  ".logs/**",
  ...PROTECTED_ARTIFACT_GLOBS
];
const ALLOWED_RESYNC_MODES = new Set(["path1", "path2", "newer", "older"]);

function resolveResyncMode(value, { fallback = "newer" } = {}) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!ALLOWED_RESYNC_MODES.has(normalized)) {
    return {
      ok: false,
      error:
        `Invalid gdrive_resync_mode "${normalized}". ` +
        "Expected one of: path1, path2, newer, older."
    };
  }
  return { ok: true, mode: normalized };
}

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

function normalizeGdriveArgs(args = []) {
  const input = Array.isArray(args) ? [...args] : [];
  const normalized = [];
  const excludedPatterns = new Set();

  for (let i = 0; i < input.length; i += 1) {
    const arg = String(input[i] || "");
    if (!arg) continue;
    if (arg === "--exclude") {
      const pattern = String(input[i + 1] || "");
      if (pattern) {
        excludedPatterns.add(pattern);
        normalized.push("--exclude", pattern);
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      const pattern = arg.slice("--exclude=".length);
      if (pattern) {
        excludedPatterns.add(pattern);
        normalized.push(arg);
      }
      continue;
    }
    normalized.push(arg);
  }

  for (const pattern of REQUIRED_GDRIVE_EXCLUDES) {
    if (!excludedPatterns.has(pattern)) {
      normalized.push("--exclude", pattern);
    }
  }

  return normalized;
}

function detectBisyncFailureType(output) {
  const text = String(output || "").toLowerCase();
  if (!text) return { conflict: false, unsafeFailure: false };
  const conflict = /\bconflict\b|\bbisync aborted\b|\bmerge\b/.test(text);
  const unsafeFailure =
    conflict ||
    /\bcritical\b|\brefusing\b|\bunsafe\b|\bmanual intervention\b|\bpanic\b/.test(text);
  return { conflict, unsafeFailure };
}

function extractFailureDetails(error) {
  const details = String(error?.stderr || error?.message || error);
  const status = Number.isInteger(error?.status) ? Number(error.status) : null;
  return { details, status };
}

function requiresBisyncResyncRecovery(details, status) {
  const text = String(details || "").toLowerCase();
  const hasExplicitRecoveryHint = text.includes("must run --resync to recover");
  const hasMissingPriorListing =
    /\b(cannot\s+find|can't\s+find|missing|not\s+found|no\s+prior)\b[\s\S]{0,120}\bprior\s+path[12]\s+listing\b/.test(
      text
    ) ||
    /\bprior\s+path[12]\s+listing\b[\s\S]{0,120}\b(missing|not\s+found|cannot\s+find|can't\s+find)\b/.test(
      text
    );
  const hasCriticalExitCode = status === 7;
  return hasExplicitRecoveryHint || hasMissingPriorListing || hasCriticalExitCode;
}

function resolveSyncCommand(mode) {
  const normalized = String(mode || "bisync").toLowerCase();
  if (normalized !== "bisync") {
    return {
      ok: false,
      error:
        `Unsupported gdrive_mode "${normalized}". Google Drive sync requires "bisync" for safe two-way convergence.`
    };
  }
  return { ok: true, command: "bisync" };
}

export function cleanupGoogleDriveProtectedArtifacts(
  gdriveConfig,
  { run = execFileSync, dryRun = false } = {}
) {
  const includeArgs = [];
  for (const pattern of PROTECTED_ARTIFACT_GLOBS) {
    includeArgs.push("--include", pattern);
  }

  const args = ["delete", gdriveConfig.remotePath, ...includeArgs, "--rmdirs"];
  if (dryRun) {
    args.push("--dry-run");
  }

  try {
    const output = runCommand(gdriveConfig.binary, args, run);
    return { ok: true, args, output, dryRun };
  } catch (error) {
    return {
      ok: false,
      args,
      dryRun,
      error: String(error?.stderr || error?.message || error)
    };
  }
}

export function prepareGoogleDriveSync(
  vaultPath,
  gdriveConfig,
  { run = execFileSync, availableRemotes, dryRun = false, forceResync = false } = {}
) {
  const resyncModeResult = resolveResyncMode(gdriveConfig.resyncMode, { fallback: "newer" });
  if (!resyncModeResult.ok) {
    return { ok: false, error: resyncModeResult.error };
  }
  const resyncMode = resyncModeResult.mode;

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

  const syncCommand = resolveSyncCommand(gdriveConfig.mode);
  if (!syncCommand.ok) {
    return { ok: false, error: syncCommand.error };
  }
  const command = syncCommand.command;

  const args = [
    command,
    vaultPath,
    pathValidation.remotePath,
    ...normalizeGdriveArgs(gdriveConfig.args)
  ];

  let resyncApplied = false;
  if (command === "bisync") {
    const marker = firstRunMarker(vaultPath);
    const hasMarker = fs.existsSync(marker);
    if (forceResync || (!hasMarker && gdriveConfig.firstRunResync)) {
      args.push("--resync", "--resync-mode", resyncMode);
      resyncApplied = true;
    }
  }

  if (dryRun) {
    args.push("--dry-run");
  }

  return {
    ok: true,
    binary: gdriveConfig.binary,
    command,
    args,
    remotePath: pathValidation.remotePath,
    remotes,
    resyncApplied,
    resyncMode,
    dryRun
  };
}

export function checkGoogleDriveRemote(
  gdriveConfig,
  { run = execFileSync, availableRemotes } = {}
) {
  const syncCommand = resolveSyncCommand(gdriveConfig.mode);
  if (!syncCommand.ok) {
    return { ok: false, error: syncCommand.error };
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

  try {
    const output = runCommand(gdriveConfig.binary, ["lsd", pathValidation.remotePath], run);
    return {
      ok: true,
      remotePath: pathValidation.remotePath,
      remotes,
      output
    };
  } catch (error) {
    return {
      ok: false,
      remotePath: pathValidation.remotePath,
      remotes,
      error: String(error?.stderr || error?.message || error)
    };
  }
}

export function syncToGoogleDrive(
  vaultPath,
  gdriveConfig,
  {
    run = execFileSync,
    availableRemotes,
    dryRun = false,
    forceResync = false,
    cleanupProtected = false
  } = {}
) {
  if (!gdriveConfig.enabled) {
    return { ok: true, skipped: true, reason: "gdrive disabled" };
  }

  const prepared = prepareGoogleDriveSync(vaultPath, gdriveConfig, {
    run,
    availableRemotes,
    dryRun,
    forceResync
  });
  if (!prepared.ok) {
    return { ok: false, error: prepared.error };
  }

  let cleanup = null;
  if (cleanupProtected) {
    cleanup = cleanupGoogleDriveProtectedArtifacts(gdriveConfig, { run, dryRun });
    if (!cleanup.ok) {
      return {
        ok: false,
        error: cleanup.error,
        command: "delete",
        args: cleanup.args,
        dryRun
      };
    }
  }

  try {
    const output = runCommand(prepared.binary, prepared.args, run);

    if (prepared.command === "bisync" && !dryRun) {
      const marker = firstRunMarker(vaultPath);
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, new Date().toISOString(), "utf8");
    }

    return {
      ok: true,
      output,
      command: prepared.command,
      args: prepared.args,
      resyncApplied: prepared.resyncApplied,
      requiresResync: false,
      autoResyncAttempted: false,
      autoResyncApplied: false,
      initialError: null,
      cleanup,
      dryRun
    };
  } catch (error) {
    const initialFailure = extractFailureDetails(error);
    const details = initialFailure.details;
    const failure = detectBisyncFailureType(details);
    const requiresResync =
      prepared.command === "bisync" &&
      requiresBisyncResyncRecovery(initialFailure.details, initialFailure.status);

    if (requiresResync && !dryRun && !prepared.resyncApplied) {
      const retryPrepared = prepareGoogleDriveSync(vaultPath, gdriveConfig, {
        run,
        availableRemotes: prepared.remotes,
        dryRun: false,
        forceResync: true
      });
      if (!retryPrepared.ok) {
        return {
          ok: false,
          error: retryPrepared.error,
          command: prepared.command,
          args: prepared.args,
          resyncApplied: prepared.resyncApplied,
          cleanup,
          conflict: failure.conflict,
          unsafeFailure: failure.unsafeFailure,
          requiresResync: true,
          autoResyncAttempted: true,
          autoResyncApplied: false,
          initialError: details,
          dryRun
        };
      }

      try {
        const retryOutput = runCommand(retryPrepared.binary, retryPrepared.args, run);
        if (retryPrepared.command === "bisync") {
          const marker = firstRunMarker(vaultPath);
          fs.mkdirSync(path.dirname(marker), { recursive: true });
          fs.writeFileSync(marker, new Date().toISOString(), "utf8");
        }
        return {
          ok: true,
          output: retryOutput,
          command: retryPrepared.command,
          args: retryPrepared.args,
          resyncApplied: retryPrepared.resyncApplied,
          requiresResync: true,
          autoResyncAttempted: true,
          autoResyncApplied: true,
          initialError: details,
          cleanup,
          dryRun
        };
      } catch (retryError) {
        const retryFailure = extractFailureDetails(retryError);
        const retryType = detectBisyncFailureType(retryFailure.details);
        return {
          ok: false,
          error: retryFailure.details,
          command: retryPrepared.command,
          args: retryPrepared.args,
          resyncApplied: retryPrepared.resyncApplied,
          cleanup,
          conflict: retryType.conflict,
          unsafeFailure: retryType.unsafeFailure,
          requiresResync: true,
          autoResyncAttempted: true,
          autoResyncApplied: false,
          initialError: details,
          dryRun
        };
      }
    }

    return {
      ok: false,
      error: details,
      command: prepared.command,
      args: prepared.args,
      resyncApplied: prepared.resyncApplied,
      cleanup,
      conflict: failure.conflict,
      unsafeFailure: failure.unsafeFailure,
      requiresResync,
      autoResyncAttempted: false,
      autoResyncApplied: false,
      initialError: null,
      dryRun
    };
  }
}
