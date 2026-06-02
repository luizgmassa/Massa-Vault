import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_GDRIVE_BINARY,
  DEFAULT_GDRIVE_FIRST_RUN_RESYNC,
  DEFAULT_GDRIVE_IMPORT_THRESHOLDS,
  DEFAULT_GDRIVE_MODE,
  DEFAULT_GDRIVE_RESYNC_MODE,
  DEFAULT_GIT_AUTO_PUSH,
  DEFAULT_GIT_BRANCH,
  DEFAULT_GIT_MODE,
  DEFAULT_GIT_REMOTE,
  DEFAULT_NOTES_AUTOMATION_ENABLED,
  DEFAULT_PUSH_INTERVAL_MIN,
  DEFAULT_SYNC_STRATEGY,
  DEFAULT_VAULT_PATH
} from "./config-constants.js";

export const DEFAULT_WATCH_PATHS = Object.freeze(["."]);
export const DEFAULT_INCLUDE_GLOBS = Object.freeze([
  "**/*.md",
  "templates/**/*.md",
  ".obsidian/app.json",
  ".obsidian/community-plugins.json",
  ".obsidian/core-plugins.json"
]);
export const DEFAULT_IGNORE_GLOBS = Object.freeze([
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
]);
export const DEFAULT_GDRIVE_ARGS = Object.freeze([
  "--exclude",
  ".git/**",
  "--exclude",
  ".gitignore",
  "--exclude",
  ".obsidian/workspace.json",
  "--exclude",
  ".automation/**",
  "--exclude",
  ".DS_Store",
  "--exclude",
  "**/.DS_Store"
]);

export function createDefaultConfigDocument() {
  return {
    enabled: DEFAULT_NOTES_AUTOMATION_ENABLED,
    vault_path: DEFAULT_VAULT_PATH,
    watch_paths: [...DEFAULT_WATCH_PATHS],
    include_globs: [...DEFAULT_INCLUDE_GLOBS],
    ignore_globs: [...DEFAULT_IGNORE_GLOBS],
    push_interval_min: DEFAULT_PUSH_INTERVAL_MIN,
    debounce_ms: DEFAULT_DEBOUNCE_MS,
    sync_strategy: DEFAULT_SYNC_STRATEGY,
    git_mode: DEFAULT_GIT_MODE,
    git_repo_url: "",
    git_auto_push: DEFAULT_GIT_AUTO_PUSH,
    remote: DEFAULT_GIT_REMOTE,
    branch: DEFAULT_GIT_BRANCH,
    gdrive_binary: DEFAULT_GDRIVE_BINARY,
    gdrive_remote_path: "",
    gdrive_mode: DEFAULT_GDRIVE_MODE,
    gdrive_resync_mode: DEFAULT_GDRIVE_RESYNC_MODE,
    gdrive_import_suspicious_file_threshold:
      DEFAULT_GDRIVE_IMPORT_THRESHOLDS.suspiciousFileThreshold,
    gdrive_import_suspicious_delete_threshold:
      DEFAULT_GDRIVE_IMPORT_THRESHOLDS.suspiciousDeleteThreshold,
    gdrive_import_suspicious_percent_threshold:
      DEFAULT_GDRIVE_IMPORT_THRESHOLDS.suspiciousPercentThreshold,
    gdrive_import_dangerous_percent_threshold:
      DEFAULT_GDRIVE_IMPORT_THRESHOLDS.dangerousPercentThreshold,
    gdrive_first_run_resync: DEFAULT_GDRIVE_FIRST_RUN_RESYNC,
    gdrive_args: [...DEFAULT_GDRIVE_ARGS]
  };
}

export function createConfigDocument({
  vaultPath,
  syncStrategy = DEFAULT_SYNC_STRATEGY,
  gitMode = DEFAULT_GIT_MODE,
  gitRepoUrl = "",
  gitRemote = DEFAULT_GIT_REMOTE,
  gitBranch = DEFAULT_GIT_BRANCH,
  gitAutoPush = DEFAULT_GIT_AUTO_PUSH,
  gdriveRemotePath = "",
  gdriveMode = DEFAULT_GDRIVE_MODE
} = {}) {
  const config = createDefaultConfigDocument();
  config.vault_path = vaultPath || config.vault_path;
  config.sync_strategy = syncStrategy;
  config.git_mode = gitMode;
  config.git_repo_url = gitRepoUrl;
  config.git_auto_push = gitAutoPush;
  config.remote = gitRemote;
  config.branch = gitBranch;
  config.gdrive_remote_path = gdriveRemotePath;
  config.gdrive_mode = gdriveMode;
  return config;
}
