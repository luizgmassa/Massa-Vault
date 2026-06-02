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
    enabled: true,
    vault_path: ".",
    watch_paths: [...DEFAULT_WATCH_PATHS],
    include_globs: [...DEFAULT_INCLUDE_GLOBS],
    ignore_globs: [...DEFAULT_IGNORE_GLOBS],
    push_interval_min: 10,
    debounce_ms: 1500,
    sync_strategy: "both",
    git_mode: "remote",
    git_repo_url: "",
    git_auto_push: true,
    remote: "origin",
    branch: "master",
    gdrive_binary: "rclone",
    gdrive_remote_path: "",
    gdrive_mode: "bisync",
    gdrive_resync_mode: "newer",
    gdrive_import_suspicious_file_threshold: 20,
    gdrive_import_suspicious_delete_threshold: 5,
    gdrive_import_suspicious_percent_threshold: 10,
    gdrive_import_dangerous_percent_threshold: 50,
    gdrive_first_run_resync: true,
    gdrive_args: [...DEFAULT_GDRIVE_ARGS]
  };
}

export function createConfigDocument({
  vaultPath,
  syncStrategy = "both",
  gitMode = "remote",
  gitRepoUrl = "",
  gitRemote = "origin",
  gitBranch = "master",
  gitAutoPush = true,
  gdriveRemotePath = "",
  gdriveMode = "bisync"
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
