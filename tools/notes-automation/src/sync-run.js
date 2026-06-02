import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  gitFetchBranch,
  gitAbortReconcile,
  gitListConflictedFiles,
  gitPush,
  gitRebaseOnto,
  gitReadStageFile,
  gitTrackedFiles,
  gitWorkingTreeChanges
} from "./git.js";
import { syncToGoogleDrive } from "./gdrive.js";
import { isProtectedArtifactPath, normalizeRelativePath } from "./protected-artifacts.js";
import { readState } from "./state.js";

function nowIso(clock) {
  return clock?.nowIso ? clock.nowIso() : new Date().toISOString();
}

function nextConflictId(ids) {
  return ids?.randomUUID ? ids.randomUUID() : randomUUID();
}

function fileSystemFrom(overrides = {}) {
  return {
    existsSync: overrides.existsSync || fs.existsSync.bind(fs),
    mkdirSync: overrides.mkdirSync || fs.mkdirSync.bind(fs),
    readFileSync: overrides.readFileSync || fs.readFileSync.bind(fs),
    writeFileSync: overrides.writeFileSync || fs.writeFileSync.bind(fs)
  };
}

export function createNotesAutomationAdapters(overrides = {}) {
  return {
    fs: fileSystemFrom(overrides.fs),
    clock: overrides.clock || null,
    ids: overrides.ids || null,
    gdrive: {
      syncToGoogleDrive: overrides.gdrive?.syncToGoogleDrive || syncToGoogleDrive
    },
    git: {
      fetchBranch: overrides.git?.fetchBranch || gitFetchBranch,
      abortReconcile: overrides.git?.abortReconcile || gitAbortReconcile,
      listConflictedFiles: overrides.git?.listConflictedFiles || gitListConflictedFiles,
      push: overrides.git?.push || gitPush,
      rebaseOnto: overrides.git?.rebaseOnto || gitRebaseOnto,
      readStageFile: overrides.git?.readStageFile || gitReadStageFile,
      trackedFiles: overrides.git?.trackedFiles || gitTrackedFiles,
      workingTreeChanges: overrides.git?.workingTreeChanges || gitWorkingTreeChanges
    }
  };
}

function ensureParentDir(fileSystem, filePath) {
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
}

function topLevel(filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return "";
  const index = normalized.indexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
}

function increment(map, key) {
  if (!key) return;
  map.set(key, Number(map.get(key) || 0) + 1);
}

function dominant(map, total) {
  let key = "";
  let count = 0;
  for (const [name, value] of map.entries()) {
    if (value > count) {
      key = name;
      count = value;
    }
  }
  return {
    key,
    share: total > 0 ? count / total : 0
  };
}

export function quarantineGitConflicts(service, errorOutput = "") {
  const fileSystem = service.adapters.fs;
  const git = service.adapters.git;
  const conflicts = git.listConflictedFiles(service.vaultPath);
  if (!conflicts.length) return [];

  const root = path.join(
    service.vaultPath,
    ".automation",
    "sync-conflicts",
    `${nowIso(service.adapters.clock).replace(/[:.]/g, "-")}-${nextConflictId(service.adapters.ids).slice(0, 8)}`
  );
  fileSystem.mkdirSync(root, { recursive: true });

  const captured = [];
  for (const filePath of conflicts) {
    const safePath = normalizeRelativePath(filePath).replace(/\//g, "__");
    const worktreePath = path.join(root, `${safePath}.worktree.txt`);
    const oursPath = path.join(root, `${safePath}.ours.txt`);
    const theirsPath = path.join(root, `${safePath}.theirs.txt`);
    const basePath = path.join(root, `${safePath}.base.txt`);

    const absolute = path.join(service.vaultPath, filePath);
    let worktree = "";
    try {
      worktree = fileSystem.readFileSync(absolute, "utf8");
    } catch {}

    ensureParentDir(fileSystem, worktreePath);
    fileSystem.writeFileSync(worktreePath, worktree, "utf8");
    fileSystem.writeFileSync(oursPath, git.readStageFile(2, filePath, service.vaultPath), "utf8");
    fileSystem.writeFileSync(theirsPath, git.readStageFile(3, filePath, service.vaultPath), "utf8");
    fileSystem.writeFileSync(basePath, git.readStageFile(1, filePath, service.vaultPath), "utf8");

    captured.push({
      filePath,
      worktreePath,
      oursPath,
      theirsPath,
      basePath
    });
  }

  fileSystem.writeFileSync(
    path.join(root, "summary.json"),
    JSON.stringify(
      {
        detectedAt: nowIso(service.adapters.clock),
        errorOutput: service.summarizeCommandOutput(errorOutput),
        conflicts: captured
      },
      null,
      2
    ),
    "utf8"
  );

  service.conflicts = captured;
  return captured;
}

export function classifyGDriveImport(service, baseline = {}) {
  const fileSystem = service.adapters.fs;
  const git = service.adapters.git;
  const trackedFilesBefore = Number(baseline.trackedFilesBefore || 0);
  const internalBefore =
    baseline.internalArtifactPathsBefore instanceof Set
      ? baseline.internalArtifactPathsBefore
      : new Set();
  const thresholds = service.config.gdriveImport || {
    suspiciousFileThreshold: 20,
    suspiciousDeleteThreshold: 5,
    suspiciousPercentThreshold: 10,
    dangerousPercentThreshold: 50
  };

  if (!service.config.git.enabled || !service.ensureVaultGitRepo()) {
    return {
      classification: "normal",
      summary: {
        changedCount: 0,
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        trackedFilesBefore,
        trackedFilesExisting: 0,
        changedPercent: 0,
        deletedPercent: 0,
        rootRenameOrDelete: false,
        vaultNearlyEmpty: false,
        importedInternalArtifactCount: 0,
        importedInternalArtifactSample: [],
        samplePaths: [],
        reasons: ["git-disabled"]
      }
    };
  }

  const changes = git
    .workingTreeChanges(service.vaultPath)
    .map((entry) => ({
      status: String(entry.status || "").toUpperCase().charAt(0) || "M",
      path: normalizeRelativePath(entry.path),
      previousPath: entry.previousPath ? normalizeRelativePath(entry.previousPath) : null
    }))
    .filter((entry) => entry.path);

  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;
  const samplePaths = [];
  const deletedTopLevel = new Map();
  const addedTopLevel = new Map();

  for (const entry of changes) {
    if (samplePaths.length < 10) {
      samplePaths.push(
        entry.status === "R" && entry.previousPath
          ? `${entry.previousPath} -> ${entry.path}`
          : entry.path
      );
    }

    if (entry.status === "A") {
      addedCount += 1;
      increment(addedTopLevel, topLevel(entry.path));
      continue;
    }
    if (entry.status === "D") {
      deletedCount += 1;
      increment(deletedTopLevel, topLevel(entry.path));
      continue;
    }
    if (entry.status === "R") {
      modifiedCount += 1;
      increment(addedTopLevel, topLevel(entry.path));
      increment(deletedTopLevel, topLevel(entry.previousPath || ""));
      continue;
    }
    modifiedCount += 1;
  }

  const changedCount = changes.length;
  const trackedFiles = git.trackedFiles(service.vaultPath);
  const trackedFilesExisting = trackedFiles.filter((filePath) => {
    if (isProtectedArtifactPath(filePath)) return false;
    try {
      return fileSystem.existsSync(path.join(service.vaultPath, filePath));
    } catch {
      return false;
    }
  }).length;

  const trackedBaseline = trackedFilesBefore > 0 ? trackedFilesBefore : trackedFiles.length;
  const changedPercent =
    trackedBaseline > 0 ? Number(((changedCount / trackedBaseline) * 100).toFixed(2)) : 0;
  const deletedPercent =
    trackedBaseline > 0 ? Number(((deletedCount / trackedBaseline) * 100).toFixed(2)) : 0;

  const internalAfter = service.collectInternalArtifactPaths();
  const importedInternalPaths = [...internalAfter].filter((filePath) => !internalBefore.has(filePath));

  const deletedDominant = dominant(deletedTopLevel, deletedCount);
  const addedDominant = dominant(addedTopLevel, addedCount);
  const renameAcrossTopLevel = changes.some((entry) => {
    if (entry.status !== "R" || !entry.previousPath) return false;
    const from = topLevel(entry.previousPath);
    const to = topLevel(entry.path);
    return Boolean(from && to && from !== to);
  });
  const rootRenameOrDelete =
    renameAcrossTopLevel ||
    (deletedCount >= thresholds.suspiciousDeleteThreshold &&
      addedCount >= thresholds.suspiciousDeleteThreshold &&
      deletedDominant.share >= 0.8 &&
      addedDominant.share >= 0.8 &&
      deletedDominant.key &&
      addedDominant.key &&
      deletedDominant.key !== addedDominant.key);

  const vaultNearlyEmpty =
    trackedBaseline > 0 &&
    trackedFilesExisting <= Math.max(1, Math.floor(trackedBaseline * 0.1));
  const protectedArtifactChanged =
    importedInternalPaths.length > 0 ||
    changes.some(
      (entry) =>
        service.isInternalArtifactPath(entry.path) ||
        (entry.previousPath ? service.isInternalArtifactPath(entry.previousPath) : false)
    );
  const dangerous =
    protectedArtifactChanged ||
    changedPercent >= thresholds.dangerousPercentThreshold ||
    deletedPercent >= thresholds.dangerousPercentThreshold ||
    vaultNearlyEmpty;
  const suspicious =
    !dangerous &&
    (changedCount >= thresholds.suspiciousFileThreshold ||
      deletedCount >= thresholds.suspiciousDeleteThreshold ||
      changedPercent >= thresholds.suspiciousPercentThreshold ||
      rootRenameOrDelete);

  let classification = "normal";
  if (dangerous) classification = "dangerous";
  else if (suspicious) classification = "suspicious";

  const reasons = [];
  if (protectedArtifactChanged) reasons.push("internal_artifact_imported");
  if (changedPercent >= thresholds.dangerousPercentThreshold)
    reasons.push("changed_percent_above_dangerous");
  if (deletedPercent >= thresholds.dangerousPercentThreshold)
    reasons.push("deleted_percent_above_dangerous");
  if (vaultNearlyEmpty) reasons.push("vault_nearly_empty");
  if (changedCount >= thresholds.suspiciousFileThreshold)
    reasons.push("changed_count_above_suspicious");
  if (deletedCount >= thresholds.suspiciousDeleteThreshold)
    reasons.push("delete_count_above_suspicious");
  if (changedPercent >= thresholds.suspiciousPercentThreshold)
    reasons.push("changed_percent_above_suspicious");
  if (rootRenameOrDelete) reasons.push("root_rename_or_delete_pattern");

  return {
    classification,
    summary: {
      changedCount,
      addedCount,
      modifiedCount,
      deletedCount,
      trackedFilesBefore: trackedBaseline,
      trackedFilesExisting,
      changedPercent,
      deletedPercent,
      rootRenameOrDelete,
      vaultNearlyEmpty,
      importedInternalArtifactCount: importedInternalPaths.length,
      importedInternalArtifactSample: importedInternalPaths.slice(0, 10),
      samplePaths,
      reasons
    }
  };
}

export function pullGitInbound(service) {
  const git = service.adapters.git;
  if (!service.config.git.enabled) return { ok: true, skipped: true };
  if (service.config.git.mode === "local") return { ok: true, skipped: true };
  if (!service.ensureVaultGitRepo()) return { ok: false, error: "git repo not ready" };

  const remote = service.config.git.remote;
  const branch = service.config.git.branch;
  const upstreamRef = `refs/remotes/${remote}/${branch}`;

  try {
    git.fetchBranch(remote, branch, service.vaultPath);
  } catch (error) {
    return {
      ok: false,
      error: `git fetch failure: ${String(error?.stderr || error?.message || error)}`
    };
  }

  const rebase = git.rebaseOnto(upstreamRef, service.vaultPath);
  if (rebase.ok) {
    service.updateState({
      lastPullAt: nowIso(service.adapters.clock),
      lastPullError: null
    });
    return { ok: true };
  }

  const conflictedFiles = git.listConflictedFiles(service.vaultPath);
  const conflictDetected = rebase.conflict || conflictedFiles.length > 0;
  if (conflictDetected) {
    let conflicts = [];
    if (conflictedFiles.length > 0) {
      conflicts = service.quarantineGitConflicts(rebase.output);
      if (!conflicts.length) {
        conflicts = conflictedFiles.map((filePath) => ({ filePath }));
        service.conflicts = conflicts;
      }
    }
    git.abortReconcile(service.vaultPath);

    if (!conflicts.length) {
      service.updateState({
        lastPullError: rebase.output
      });
      return { ok: false, error: rebase.output };
    }

    service.paused = true;
    service.updateSyncState({
      status: "conflict",
      conflictCount: conflicts.length,
      conflicts,
      lastError: service.summarizeCommandOutput(rebase.output)
    });
    service.updateState({
      paused: true,
      alert:
        "Sync paused: Git conflict detected. Run `npm run vault -- sync conflicts`, resolve files, then `npm run vault -- sync resolve --done`.",
      lastPullError: rebase.output
    });
    return { ok: false, conflict: true, error: rebase.output };
  }

  service.updateState({
    lastPullError: rebase.output
  });
  return { ok: false, error: rebase.output };
}

export function syncGoogleDriveInbound(service) {
  if (!service.config.gdrive.enabled) return { ok: true, skipped: true };

  const attemptedAt = nowIso(service.adapters.clock);
  const result = service.adapters.gdrive.syncToGoogleDrive(service.vaultPath, service.config.gdrive, {
    cleanupProtected: true
  });
  const nextState = {
    lastGDriveAttemptAt: attemptedAt,
    lastGDriveMode: result.command || null,
    lastGDriveArgs: Array.isArray(result.args) ? result.args : [],
    lastGDriveDryRun: Boolean(result.dryRun),
    lastGDriveResyncApplied: Boolean(result.resyncApplied),
    lastGDriveRequiresResync: Boolean(result.requiresResync),
    lastGDriveAutoResyncAttempted: Boolean(result.autoResyncAttempted),
    lastGDriveAutoResyncApplied: Boolean(result.autoResyncApplied),
    lastGDriveAutoResyncAt: result.autoResyncApplied ? attemptedAt : null,
    lastGDriveResyncMode: result.resyncApplied ? service.config.gdrive.resyncMode || null : null,
    lastGDriveInitialError: result.initialError ? service.summarizeCommandOutput(result.initialError) : null
  };

  if (result.ok) {
    service.updateState({
      ...nextState,
      lastGDriveSyncAt: nowIso(service.adapters.clock),
      lastGDriveError: null,
      lastGDriveOutput: service.summarizeCommandOutput(result.output)
    });
    return { ok: true };
  }

  const errorOutput = service.summarizeCommandOutput(result.error || result.output || "");
  service.updateState({
    ...nextState,
    lastGDriveError: result.error || "unknown gdrive sync error",
    lastGDriveOutput: errorOutput
  });

  if (result.conflict || result.unsafeFailure) {
    const manualRecoveryAlert =
      result.requiresResync && result.autoResyncAttempted && !result.autoResyncApplied
        ? "Sync paused: Google Drive auto recovery (--resync) was attempted but failed. Inspect rclone output, fix remote/local divergence, then run `npm run vault -- sync`."
        : "Sync paused: Google Drive bisync needs manual intervention. Run `npm run vault -- sync` after fixing remote/local divergence.";
    service.paused = true;
    service.updateSyncState({
      status: "paused",
      lastError: errorOutput
    });
    service.updateState({
      paused: true,
      alert: manualRecoveryAlert,
      lastError: errorOutput
    });
  }

  return { ok: false, error: result.error || "unknown gdrive sync error" };
}

export function pushGitOutbound(service) {
  const git = service.adapters.git;
  if (!service.config.git.enabled) return { ok: true, skipped: true };
  if (!service.config.git.autoPush) return { ok: true, skipped: true };
  if (service.config.git.mode === "local") return { ok: true, skipped: true };
  if (!service.ensureVaultGitRepo()) return { ok: false, error: "git repo not ready" };

  const result = git.push(service.config.git.remote, service.config.git.branch, service.vaultPath);
  if (result.ok) {
    service.updateState({
      lastPushAt: nowIso(service.adapters.clock),
      lastPushError: null
    });
    return { ok: true };
  }

  if (result.nonFastForward) {
    service.paused = true;
    service.updateState({
      paused: true,
      alert:
        "Auto-push paused: non-fast-forward detected. Resolve manually (pull/rebase or merge), then run `npm run vault:resume`.",
      lastPushError: result.output
    });
    service.updateSyncState({
      status: "paused",
      lastError: service.summarizeCommandOutput(result.output)
    });
    return { ok: false, error: result.output };
  }

  service.updateState({
    lastPushError: result.output
  });
  return { ok: false, error: result.output };
}

export function handleSuccessfulGDriveImport(service, reason, baseline = {}) {
  service.enforceProtectedArtifacts();
  const evaluation = service.classifyGDriveImport(baseline);
  const classification = evaluation.classification;
  const summary = evaluation.summary;
  const reviewNeeded = classification === "suspicious" || classification === "dangerous";

  service.updateSyncState({
    lastGDriveImportClassification: classification,
    lastGDriveImportSummary: summary,
    reviewNeeded
  });

  if (!service.config.git.enabled) {
    return { ok: true, classification, summary, skipped: true };
  }

  const subjectByClass = {
    normal: "sync(gdrive): import live-storage changes",
    suspicious: "sync(gdrive): suspicious live-storage import",
    dangerous: "sync(gdrive): dangerous import held for review"
  };
  const subject = subjectByClass[classification] || subjectByClass.normal;
  const commit = service.commitAllChangesWithSubject(subject, [
    `reason=${reason}`,
    `classification=${classification}`,
    `changed=${summary.changedCount}`,
    `added=${summary.addedCount}`,
    `modified=${summary.modifiedCount}`,
    `deleted=${summary.deletedCount}`
  ]);
  if (commit.error) {
    return { ok: false, classification, summary, error: commit.error };
  }

  if (classification === "dangerous") {
    const error = "dangerous gdrive import held for review (post-import push skipped)";
    service.paused = true;
    service.updateSyncState({
      status: "paused",
      reviewNeeded: true,
      lastError: service.summarizeCommandOutput(error)
    });
    service.updateState({
      paused: true,
      alert:
        "Sync paused: dangerous Google Drive import detected. Review latest local commit and restore from pre-GDrive snapshot if needed before resuming.",
      lastError: error
    });
    return { ok: false, classification, summary, error };
  }

  if (!commit.committed) {
    return { ok: true, classification, summary, commitSkipped: true };
  }

  const push = service.pushGitOutbound();
  if (!push.ok) {
    return { ok: false, classification, summary, error: push.error };
  }

  return { ok: true, classification, summary };
}

export function executeSyncRun(service, reason) {
  if (service.paused) {
    service.updateSyncState({
      status: service.conflicts.length ? "conflict" : "paused",
      reason: null,
      queuedReason: null
    });
    return { ok: false, skipped: true, reason: "paused" };
  }

  const startedAt = nowIso(service.adapters.clock);
  service.updateSyncState({
    status: "syncing",
    reason,
    startedAt,
    queuedReason: null,
    lastError: null
  });

  try {
    service.enforceProtectedArtifacts();
    service.commitQueuedChanges(`local changes (${reason})`);

    const pull = service.pullGitInbound();
    if (!pull.ok) {
      const finalStatus = service.paused ? (service.conflicts.length ? "conflict" : "paused") : "idle";
      service.updateSyncState({
        status: finalStatus,
        reason: null,
        finishedAt: nowIso(service.adapters.clock),
        lastError: service.summarizeCommandOutput(pull.error || "")
      });
      return { ok: false, error: pull.error };
    }

    let gdriveBaseline = null;
    if (service.config.gdrive.enabled) {
      gdriveBaseline = service.captureGDriveImportBaseline();
      const preSnapshot = service.createPreGDriveSnapshot();
      if (!preSnapshot.ok) {
        service.updateSyncState({
          status: "idle",
          reason: null,
          finishedAt: nowIso(service.adapters.clock),
          lastError: service.summarizeCommandOutput(preSnapshot.error || "pre-gdrive snapshot failed")
        });
        return { ok: false, error: preSnapshot.error || "pre-gdrive snapshot failed" };
      }

      if (!preSnapshot.skipped) {
        const prePush = service.pushGitOutbound();
        if (!prePush.ok) {
          const finalStatus = service.paused ? "paused" : "idle";
          service.updateSyncState({
            status: finalStatus,
            reason: null,
            finishedAt: nowIso(service.adapters.clock),
            lastError: service.summarizeCommandOutput(prePush.error || "")
          });
          return { ok: false, error: prePush.error };
        }
      }
    }

    const gdrive = service.syncGoogleDriveInbound();
    if (!gdrive.ok) {
      const finalStatus = service.paused ? "paused" : "idle";
      service.updateSyncState({
        status: finalStatus,
        reason: null,
        finishedAt: nowIso(service.adapters.clock),
        lastError: service.summarizeCommandOutput(gdrive.error || "")
      });
      return { ok: false, error: gdrive.error };
    }

    if (service.config.gdrive.enabled) {
      const postImport = service.handleSuccessfulGDriveImport(reason, gdriveBaseline || {});
      if (!postImport.ok) {
        const finalStatus = service.paused ? "paused" : "idle";
        service.updateSyncState({
          status: finalStatus,
          reason: null,
          finishedAt: nowIso(service.adapters.clock),
          lastError: service.summarizeCommandOutput(postImport.error || "")
        });
        return { ok: false, error: postImport.error };
      }
    } else {
      service.enforceProtectedArtifacts();
      service.commitAllChanges(`post-sync changes (${reason})`);

      const push = service.pushGitOutbound();
      if (!push.ok) {
        const finalStatus = service.paused ? "paused" : "idle";
        service.updateSyncState({
          status: finalStatus,
          reason: null,
          finishedAt: nowIso(service.adapters.clock),
          lastError: service.summarizeCommandOutput(push.error || "")
        });
        return { ok: false, error: push.error };
      }
    }

    const completedAt = nowIso(service.adapters.clock);
    service.updateSyncState({
      status: "idle",
      reason: null,
      finishedAt: completedAt,
      lastSuccessAt: completedAt,
      lastError: null
    });
    return { ok: true };
  } catch (error) {
    const message = String(error?.message || error);
    service.updateSyncState({
      status: service.paused ? "paused" : "idle",
      reason: null,
      finishedAt: nowIso(service.adapters.clock),
      lastError: service.summarizeCommandOutput(message)
    });
    service.updateState({
      lastError: `sync failure: ${message}`
    });
    return { ok: false, error: message };
  }
}

export function runQueuedSync(service, { reason = "manual" } = {}) {
  if (service.syncLock) {
    service.queuedSyncReason = reason;
    service.updateSyncState({ queuedReason: reason });
    return service.syncPromise || Promise.resolve({ ok: true, queued: true });
  }

  service.syncLock = true;
  service.syncPromise = Promise.resolve()
    .then(() => {
      let nextReason = reason;
      let lastResult = { ok: true };
      do {
        lastResult = service.executeSync(nextReason);
        nextReason = service.queuedSyncReason;
        service.queuedSyncReason = null;
      } while (nextReason && lastResult.ok && !service.paused);
      return lastResult;
    })
    .finally(() => {
      service.syncLock = false;
      service.syncPromise = null;
      service.queuedSyncReason = null;
      const current = readState();
      const sync = service.createSyncState(current.sync || {});
      if (sync.queuedReason) {
        service.updateSyncState({ queuedReason: null });
      }
    });

  return service.syncPromise;
}
