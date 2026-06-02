import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_GDRIVE_RESYNC_MODE_SET,
  DEFAULT_CONFIG_PATH,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_GDRIVE_BINARY,
  DEFAULT_GDRIVE_IMPORT_THRESHOLDS,
  DEFAULT_GDRIVE_MODE,
  DEFAULT_GDRIVE_RESYNC_MODE,
  DEFAULT_GIT_AUTO_PUSH,
  DEFAULT_GIT_BRANCH,
  DEFAULT_GIT_MODE,
  DEFAULT_GIT_REMOTE,
  DEFAULT_LOCAL_CONFIG_PATH,
  DEFAULT_NOTES_AUTOMATION_ENABLED,
  DEFAULT_PUSH_INTERVAL_MIN,
  DEFAULT_SYNC_STRATEGY,
  DEFAULT_VAULT_PATH
} from "./config-constants.js";
import { createDefaultConfigDocument } from "./config-definition.js";
import { PROTECTED_ARTIFACT_GLOBS } from "./protected-artifacts.js";

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
  const defaults = createDefaultConfigDocument();
  const baseConfig = readJsonFile(configPath);
  const localPath = getLocalConfigPath(configPath, localConfigPath);
  const localConfig = localPath && fs.existsSync(localPath) ? readJsonFile(localPath) : {};
  const parsed = { ...defaults, ...baseConfig, ...localConfig };
  const syncStrategy = String(parsed.sync_strategy || DEFAULT_SYNC_STRATEGY).toLowerCase();
  const gitEnabled = syncStrategy === "git" || syncStrategy === "both";
  const gdriveEnabled = syncStrategy === "gdrive" || syncStrategy === "both";
  const gdriveMode = String(parsed.gdrive_mode || DEFAULT_GDRIVE_MODE).toLowerCase();
  const gdriveResyncMode = String(parsed.gdrive_resync_mode || DEFAULT_GDRIVE_RESYNC_MODE).toLowerCase();
  if (gdriveEnabled && gdriveMode !== DEFAULT_GDRIVE_MODE) {
    throw new Error(
      `Invalid gdrive_mode "${gdriveMode}". When Google Drive sync is enabled, gdrive_mode must be "${DEFAULT_GDRIVE_MODE}".`
    );
  }
  if (!ALLOWED_GDRIVE_RESYNC_MODE_SET.has(gdriveResyncMode)) {
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
      String(
        process.env.NOTES_AUTOMATION_ENABLED ??
          parsed.enabled ??
          DEFAULT_NOTES_AUTOMATION_ENABLED
      ).toLowerCase() ===
      "true",
    vaultPath: path.resolve(process.env.VAULT_PATH || parsed.vault_path || DEFAULT_VAULT_PATH),
    watchPaths: parsed.watch_paths || ["."],
    includeGlobs: parsed.include_globs || ["**/*.md"],
    ignoreGlobs,
    pushIntervalMin: toNumber(
      process.env.NOTES_AUTOMATION_PUSH_INTERVAL_MIN ?? parsed.push_interval_min,
      DEFAULT_PUSH_INTERVAL_MIN
    ),
    debounceMs: toNumber(parsed.debounce_ms, DEFAULT_DEBOUNCE_MS),
    syncStrategy,
    git: {
      enabled: gitEnabled,
      mode: parsed.git_mode || DEFAULT_GIT_MODE,
      repoUrl: process.env.NOTES_AUTOMATION_GIT_REPO_URL || parsed.git_repo_url || "",
      autoPush:
        String(
          process.env.NOTES_AUTOMATION_GIT_AUTO_PUSH ??
            parsed.git_auto_push ??
            DEFAULT_GIT_AUTO_PUSH
        ).toLowerCase() ===
        "true",
      remote: process.env.NOTES_AUTOMATION_REMOTE || parsed.remote || DEFAULT_GIT_REMOTE,
      branch: process.env.NOTES_AUTOMATION_BRANCH || parsed.branch || DEFAULT_GIT_BRANCH
    },
    gdrive: {
      enabled: gdriveEnabled,
      binary: process.env.NOTES_AUTOMATION_GDRIVE_BIN || parsed.gdrive_binary || DEFAULT_GDRIVE_BINARY,
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
        DEFAULT_GDRIVE_IMPORT_THRESHOLDS.suspiciousFileThreshold
      ),
      suspiciousDeleteThreshold: toNonNegativeNumber(
        parsed.gdrive_import_suspicious_delete_threshold,
        DEFAULT_GDRIVE_IMPORT_THRESHOLDS.suspiciousDeleteThreshold
      ),
      suspiciousPercentThreshold: toNonNegativeNumber(
        parsed.gdrive_import_suspicious_percent_threshold,
        DEFAULT_GDRIVE_IMPORT_THRESHOLDS.suspiciousPercentThreshold
      ),
      dangerousPercentThreshold: toNonNegativeNumber(
        parsed.gdrive_import_dangerous_percent_threshold,
        DEFAULT_GDRIVE_IMPORT_THRESHOLDS.dangerousPercentThreshold
      )
    }
  };
}
