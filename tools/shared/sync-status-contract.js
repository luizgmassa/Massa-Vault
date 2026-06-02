export const SYNC_STATUS = Object.freeze({
  IDLE: "idle",
  SYNCING: "syncing",
  PAUSED: "paused",
  ERROR: "error",
  CONFLICT: "conflict"
});

export const SYNC_BACKEND_LEVEL = Object.freeze({
  OK: "ok",
  ERROR: "error",
  DISABLED: "disabled"
});

export const SYNC_BACKEND_REASON = Object.freeze({
  CONFLICT: "conflict",
  PULL_ERROR: "pull-error",
  PUSH_ERROR: "push-error",
  GIT_ALERT: "git-alert",
  GDRIVE_ERROR: "gdrive-error",
  GDRIVE_RESYNC_REQUIRED: "gdrive-resync-required",
  GDRIVE_REVIEW_NEEDED: "gdrive-review-needed",
  GDRIVE_ALERT: "gdrive-alert",
  GDRIVE_RESYNC_FAILED: "gdrive-resync-failed",
  SYNC_ERROR_UNATTRIBUTED: "sync-error-unattributed"
});

export const SYNC_SUMMARY_LIMITS = Object.freeze({
  maxLines: 12,
  maxChars: 1800
});

export const SYNC_STATUS_FALLBACK_ERROR = "unable to read notes-automation status";
