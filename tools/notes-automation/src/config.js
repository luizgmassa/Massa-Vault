import fs from "node:fs";
import path from "node:path";
import { PROTECTED_ARTIFACT_GLOBS } from "./protected-artifacts.js";

const DEFAULT_CONFIG_PATH = path.resolve("config/notes-automation.config.json");
const DEFAULT_LOCAL_CONFIG_PATH = path.resolve("config/notes-automation.local.json");
const ALLOWED_GDRIVE_RESYNC_MODES = new Set(["path1", "path2", "newer", "older"]);

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNonNegativeNumber(value, fallback) {
  const parsed = toNumber(value, fallback);
  return parsed >= 0 ? parsed : fallback;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function getLocalConfigPath(configPath, localConfigPath) {
  if (localConfigPath !== undefined) return localConfigPath;
  if (path.resolve(configPath) === DEFAULT_CONFIG_PATH) return DEFAULT_LOCAL_CONFIG_PATH;
  return null;
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH, { localConfigPath } = {}) {
  const baseConfig = readJsonFile(configPath);
  const localPath = getLocalConfigPath(configPath, localConfigPath);
  const localConfig = localPath && fs.existsSync(localPath) ? readJsonFile(localPath) : {};
  const parsed = { ...baseConfig, ...localConfig };
  const syncStrategy = String(parsed.sync_strategy || "git").toLowerCase();
  const gitEnabled = syncStrategy === "git" || syncStrategy === "both";
  const gdriveEnabled = syncStrategy === "gdrive" || syncStrategy === "both";
  const gdriveMode = String(parsed.gdrive_mode || "bisync").toLowerCase();
  const gdriveResyncMode = String(parsed.gdrive_resync_mode || "newer").toLowerCase();
  if (gdriveEnabled && gdriveMode !== "bisync") {
    throw new Error(
      `Invalid gdrive_mode "${gdriveMode}". When Google Drive sync is enabled, gdrive_mode must be "bisync".`
    );
  }
  if (!ALLOWED_GDRIVE_RESYNC_MODES.has(gdriveResyncMode)) {
    throw new Error(
      `Invalid gdrive_resync_mode "${gdriveResyncMode}". Expected one of: path1, path2, newer, older.`
    );
  }

  const ignoreGlobs = Array.isArray(parsed.ignore_globs) ? [...parsed.ignore_globs] : [];
  for (const glob of PROTECTED_ARTIFACT_GLOBS) {
    if (!ignoreGlobs.includes(glob)) {
      ignoreGlobs.push(glob);
    }
  }

  return {
    enabled:
      String(process.env.NOTES_AUTOMATION_ENABLED ?? parsed.enabled ?? true).toLowerCase() ===
      "true",
    vaultPath: path.resolve(process.env.VAULT_PATH || parsed.vault_path || "."),
    watchPaths: parsed.watch_paths || ["."],
    includeGlobs: parsed.include_globs || ["**/*.md"],
    ignoreGlobs,
    pushIntervalMin: toNumber(
      process.env.NOTES_AUTOMATION_PUSH_INTERVAL_MIN ?? parsed.push_interval_min,
      10
    ),
    debounceMs: toNumber(parsed.debounce_ms, 1500),
    syncStrategy,
    git: {
      enabled: gitEnabled,
      mode: parsed.git_mode || "remote",
      repoUrl: process.env.NOTES_AUTOMATION_GIT_REPO_URL || parsed.git_repo_url || "",
      autoPush:
        String(process.env.NOTES_AUTOMATION_GIT_AUTO_PUSH ?? parsed.git_auto_push ?? true).toLowerCase() ===
        "true",
      remote: process.env.NOTES_AUTOMATION_REMOTE || parsed.remote || "origin",
      branch: process.env.NOTES_AUTOMATION_BRANCH || parsed.branch || "master"
    },
    gdrive: {
      enabled: gdriveEnabled,
      binary: process.env.NOTES_AUTOMATION_GDRIVE_BIN || parsed.gdrive_binary || "rclone",
      remotePath: process.env.NOTES_AUTOMATION_GDRIVE_REMOTE_PATH || parsed.gdrive_remote_path || "",
      mode: gdriveMode,
      resyncMode: gdriveResyncMode,
      firstRunResync:
        String(parsed.gdrive_first_run_resync ?? true).toLowerCase() === "true",
      args: Array.isArray(parsed.gdrive_args) ? parsed.gdrive_args : []
    },
    gdriveImport: {
      suspiciousFileThreshold: toNonNegativeNumber(
        parsed.gdrive_import_suspicious_file_threshold,
        20
      ),
      suspiciousDeleteThreshold: toNonNegativeNumber(
        parsed.gdrive_import_suspicious_delete_threshold,
        5
      ),
      suspiciousPercentThreshold: toNonNegativeNumber(
        parsed.gdrive_import_suspicious_percent_threshold,
        10
      ),
      dangerousPercentThreshold: toNonNegativeNumber(
        parsed.gdrive_import_dangerous_percent_threshold,
        50
      )
    }
  };
}
