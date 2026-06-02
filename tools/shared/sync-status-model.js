function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value) {
  return Boolean(value);
}

function firstText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function includesDriveHint(value) {
  return /\b(gdrive|google\s*drive|rclone|bisync|drive)\b/i.test(String(value || ""));
}

function includesGitHint(value) {
  return /\b(git|rebase|pull|push|merge|conflict|github)\b/i.test(String(value || ""));
}

function toSummary(value, { maxLines = 12, maxChars = 1800 } = {}) {
  const text = String(value || "").trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/).slice(-maxLines);
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(-maxChars);
}

function backendLevel({ enabled, hasError }) {
  if (hasError) return "error";
  if (enabled === false) return "disabled";
  return "ok";
}

function parseResultPayload(result) {
  if (result?.payload && typeof result.payload === "object") {
    return result.payload;
  }
  const output = String(result?.output || "").trim();
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveBackendEnabled(state) {
  const config = asObject(state.config);
  const git = asObject(config.git);
  const gdrive = asObject(config.gdrive);
  const syncStrategy = String(config.syncStrategy || "").trim().toLowerCase();

  const gitEnabled =
    typeof git.enabled === "boolean"
      ? git.enabled
      : syncStrategy
        ? syncStrategy === "git" || syncStrategy === "both"
        : null;
  const driveEnabled =
    typeof gdrive.enabled === "boolean"
      ? gdrive.enabled
      : syncStrategy
        ? syncStrategy === "gdrive" || syncStrategy === "both"
        : null;

  return { gitEnabled, driveEnabled };
}

function deriveBackends({ state, sync, status, conflictCount, alert, rawSyncError }) {
  const { gitEnabled, driveEnabled } = resolveBackendEnabled(state);
  const gitReasons = [];
  const driveReasons = [];

  const lastPullError = firstText(sync.lastPullError, state.lastPullError);
  const lastPushError = firstText(sync.lastPushError, state.lastPushError);
  const lastGDriveError = firstText(sync.lastGDriveError, state.lastGDriveError);
  const lastGDriveOutput = firstText(sync.lastGDriveOutput, state.lastGDriveOutput);
  const lastGDriveInitialError = firstText(sync.lastGDriveInitialError, state.lastGDriveInitialError);
  const gdriveImport = firstText(
    sync.gdriveImport,
    sync.gdrive_import,
    sync.lastGDriveImportClassification
  ).toLowerCase();
  const reviewNeeded = asBoolean(sync.reviewNeeded);
  const requiresResync = asBoolean(sync.lastGDriveRequiresResync ?? state.lastGDriveRequiresResync);
  const autoResyncAttempted = asBoolean(
    sync.lastGDriveAutoResyncAttempted ?? state.lastGDriveAutoResyncAttempted
  );
  const autoResyncApplied = asBoolean(
    sync.lastGDriveAutoResyncApplied ?? state.lastGDriveAutoResyncApplied
  );
  const resyncRecoveryFailed = autoResyncAttempted && !autoResyncApplied;

  if (conflictCount > 0 || status === "conflict") {
    gitReasons.push("conflict");
  }
  if (lastPullError) {
    gitReasons.push("pull-error");
  }
  if (lastPushError) {
    gitReasons.push("push-error");
  }
  if (alert && includesGitHint(alert)) {
    gitReasons.push("git-alert");
  }

  if (lastGDriveError) {
    driveReasons.push("gdrive-error");
  }
  if (requiresResync || resyncRecoveryFailed) {
    driveReasons.push("gdrive-resync-required");
  }
  if (gdriveImport === "dangerous" || reviewNeeded) {
    driveReasons.push("gdrive-review-needed");
  }
  if (alert && includesDriveHint(alert)) {
    driveReasons.push("gdrive-alert");
  }
  if (lastGDriveInitialError && resyncRecoveryFailed) {
    driveReasons.push("gdrive-resync-failed");
  }

  let gitHasError = gitReasons.length > 0;
  let driveHasError = driveReasons.length > 0;
  const genericSyncError =
    asBoolean(rawSyncError) ||
    status === "paused" ||
    status === "error" ||
    status === "conflict" ||
    conflictCount > 0;
  const unattributedSyncError = genericSyncError && !gitHasError && !driveHasError;
  if (unattributedSyncError) {
    gitHasError = true;
    driveHasError = true;
    gitReasons.push("sync-error-unattributed");
    driveReasons.push("sync-error-unattributed");
  }

  return {
    unattributedSyncError,
    git: {
      enabled: gitEnabled,
      hasError: gitHasError,
      level: backendLevel({ enabled: gitEnabled, hasError: gitHasError }),
      reasons: gitReasons,
      lastPullError: toSummary(lastPullError),
      lastPushError: toSummary(lastPushError)
    },
    drive: {
      enabled: driveEnabled,
      hasError: driveHasError,
      level: backendLevel({ enabled: driveEnabled, hasError: driveHasError }),
      reasons: driveReasons,
      lastGDriveError: toSummary(lastGDriveError),
      lastGDriveOutput: toSummary(lastGDriveOutput),
      lastGDriveInitialError: toSummary(lastGDriveInitialError),
      gdriveImport,
      reviewNeeded,
      requiresResync,
      autoResyncAttempted,
      autoResyncApplied
    }
  };
}

export function deriveSyncStatusModel(payload, { commandOk = true, output = "" } = {}) {
  const root = asObject(payload);
  const state = asObject(root.state);
  const syncFromRoot = asObject(root.sync);
  const syncFromState = asObject(state.sync);
  const sync = {
    ...syncFromState,
    ...syncFromRoot
  };

  const status = String(sync.status || "idle").trim().toLowerCase() || "idle";
  const conflictCount = asNumber(sync.conflictCount, 0);
  const alert = firstText(sync.alert, state.alert);
  const lastError = firstText(sync.lastError, state.lastError);
  const rawSyncError = !commandOk ? firstText(output, lastError, root.message, root.error) : lastError;
  const syncErrorText = toSummary(rawSyncError);
  const {
    git,
    drive,
    unattributedSyncError
  } = deriveBackends({ state, sync, status, conflictCount, alert, rawSyncError: syncErrorText });

  return {
    ok: Boolean(commandOk),
    status,
    running: asBoolean(root.running ?? state.running),
    paused: asBoolean(root.paused ?? state.paused),
    pid: Number.isInteger(Number(root.pid)) && Number(root.pid) > 0 ? Number(root.pid) : null,
    reason: firstText(sync.reason),
    queuedReason: firstText(sync.queuedReason),
    conflictCount,
    conflicts: Array.isArray(sync.conflicts) ? sync.conflicts : [],
    lastError: syncErrorText,
    alert: toSummary(alert),
    lastSuccessAt: firstText(sync.lastSuccessAt),
    startedAt: firstText(sync.startedAt),
    finishedAt: firstText(sync.finishedAt),
    updatedAt: firstText(state.updatedAt),
    lastPullAt: firstText(state.lastPullAt),
    lastPushAt: firstText(state.lastPushAt),
    lastGDriveAttemptAt: firstText(state.lastGDriveAttemptAt),
    lastGDriveSyncAt: firstText(state.lastGDriveSyncAt),
    lastGDriveAutoResyncAt: firstText(state.lastGDriveAutoResyncAt),
    backends: {
      git,
      drive
    },
    sync: {
      ...sync
    },
    state: {
      ...state
    },
    unattributedSyncError
  };
}

export function buildSyncStatusModelFromResult(result) {
  const payload = parseResultPayload(result);
  if (!payload) {
    return deriveSyncStatusModel(
      {
        running: false,
        pid: null,
        state: {},
        sync: {
          status: result?.ok ? "idle" : "error",
          lastError: firstText(result?.output, "unable to read notes-automation status")
        }
      },
      {
        commandOk: Boolean(result?.ok),
        output: String(result?.output || "")
      }
    );
  }
  return deriveSyncStatusModel(payload, {
    commandOk: Boolean(result?.ok),
    output: String(result?.output || "")
  });
}
