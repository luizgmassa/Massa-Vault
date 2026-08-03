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
} from "../infrastructure/git.js";
import { syncToGoogleDrive } from "../infrastructure/gdrive.js";
import {
  GDRIVE_IMPORT_CLASSIFICATION,
  GDRIVE_IMPORT_DANGEROUS_ALERT,
  GDRIVE_IMPORT_DANGEROUS_ERROR,
  requiresGDriveImportReview,
  resolveGDriveImportCommitSubject
} from "../domain/gdrive-import.js";
import { normalizeRelativePath } from "../domain/protected-artifacts.js";
import { formatProcessError } from "../domain/process-error.js";
import { readState } from "../infrastructure/state.js";

export { classifyGDriveImport } from "../domain/gdrive-import.js";

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
    const localPath = path.join(root, `${safePath}.local.txt`);
    const remotePath = path.join(root, `${safePath}.remote.txt`);
    const basePath = path.join(root, `${safePath}.base.txt`);

    const absolute = path.join(service.vaultPath, filePath);
    let worktree = "";
    try {
      worktree = fileSystem.readFileSync(absolute, "utf8");
    } catch {}

    ensureParentDir(fileSystem, worktreePath);
    fileSystem.writeFileSync(worktreePath, worktree, "utf8");
    // Reconciliation always runs `git rebase` (pullGitInbound), and under rebase the
    // stage roles invert relative to a merge: stage 2 ("ours") is the upstream/remote
    // tip and stage 3 ("theirs") is the local commit being replayed. Neutral
    // local/remote snapshot names keep hand-resolvers from restoring the wrong side.
    // Test: node --test tests/notes-automation-service.test.js (TST-13 pin)
    fileSystem.writeFileSync(remotePath, git.readStageFile(2, filePath, service.vaultPath), "utf8");
    fileSystem.writeFileSync(localPath, git.readStageFile(3, filePath, service.vaultPath), "utf8");
    fileSystem.writeFileSync(basePath, git.readStageFile(1, filePath, service.vaultPath), "utf8");

    captured.push({
      filePath,
      worktreePath,
      localPath,
      remotePath,
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
      error: `git fetch failure: ${formatProcessError(error)}`
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
  const reviewNeeded = requiresGDriveImportReview(classification);

  service.updateSyncState({
    lastGDriveImportClassification: classification,
    lastGDriveImportSummary: summary,
    reviewNeeded
  });

  if (!service.config.git.enabled) {
    return { ok: true, classification, summary, skipped: true };
  }

  const commit = service.commitAllChangesWithSubject(resolveGDriveImportCommitSubject(classification), [
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

  if (classification === GDRIVE_IMPORT_CLASSIFICATION.DANGEROUS) {
    const error = GDRIVE_IMPORT_DANGEROUS_ERROR;
    service.paused = true;
    service.updateSyncState({
      status: "paused",
      reviewNeeded: true,
      lastError: service.summarizeCommandOutput(error)
    });
    service.updateState({
      paused: true,
      alert: GDRIVE_IMPORT_DANGEROUS_ALERT,
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

// Upper bound on back-to-back runs in one drain, so a caller that queues a new
// reason during every run cannot spin the loop forever.
const MAX_QUEUED_SYNC_DRAIN = 10;

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
      let runs = 0;
      // A reason queued mid-flight is an explicit request, so it still runs when
      // the in-flight sync fails without pausing (e.g. a transient fetch error).
      // The drain stops only on pause or the run cap.
      // Test: node --test tests/notes-automation-service.test.js ("non-pausing failure")
      do {
        runs += 1;
        lastResult = service.executeSync(nextReason);
        nextReason = service.queuedSyncReason;
        service.queuedSyncReason = null;
      } while (nextReason && !service.paused && runs < MAX_QUEUED_SYNC_DRAIN);
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
