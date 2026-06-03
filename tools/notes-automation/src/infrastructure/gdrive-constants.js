import { PROTECTED_ARTIFACT_GLOBS } from "../domain/protected-artifacts.js";

export const GDRIVE_REMOTE_PATH_EXAMPLE = "Personal:Obsidian";
export const GDRIVE_RESYNC_MARKER_SEGMENTS = Object.freeze([
  ".automation",
  "gdrive-resync.done"
]);
export const GDRIVE_RESYNC_RECOVERY_EXIT_CODE = 7;

export const REQUIRED_GDRIVE_EXCLUDES = Object.freeze([
  ".git/**",
  ".gitignore",
  ".obsidian/workspace.json",
  ".logs/**",
  ...PROTECTED_ARTIFACT_GLOBS
]);

export const REMOTE_CLEANUP_GLOBS = Object.freeze([
  ...PROTECTED_ARTIFACT_GLOBS,
  ".gitignore"
]);
