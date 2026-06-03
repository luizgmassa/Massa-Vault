import path from "node:path";
export { DEFAULT_GDRIVE_IMPORT_THRESHOLDS } from "../domain/gdrive-import-thresholds.js";

export const DEFAULT_CONFIG_PATH = path.resolve("config/notes-automation.config.json");
export const DEFAULT_LOCAL_CONFIG_PATH = path.resolve("config/notes-automation.local.json");

export const DEFAULT_NOTES_AUTOMATION_ENABLED = true;
export const DEFAULT_VAULT_PATH = ".";
export const DEFAULT_PUSH_INTERVAL_MIN = 10;
export const DEFAULT_DEBOUNCE_MS = 1500;

export const DEFAULT_SYNC_STRATEGY = "both";
export const DEFAULT_GIT_MODE = "remote";
export const DEFAULT_GIT_REMOTE = "origin";
export const DEFAULT_GIT_BRANCH = "master";
export const DEFAULT_GIT_AUTO_PUSH = true;

export const DEFAULT_GDRIVE_BINARY = "rclone";
export const DEFAULT_GDRIVE_MODE = "bisync";
export const DEFAULT_GDRIVE_RESYNC_MODE = "newer";
export const DEFAULT_GDRIVE_FIRST_RUN_RESYNC = true;

export const ALLOWED_GDRIVE_RESYNC_MODES = Object.freeze([
  "path1",
  "path2",
  "newer",
  "older"
]);
export const ALLOWED_GDRIVE_RESYNC_MODE_SET = new Set(ALLOWED_GDRIVE_RESYNC_MODES);
