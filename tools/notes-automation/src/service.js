import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import {
  captureGDriveImportBaseline as captureGDriveImportBaselineImpl,
  collectInternalArtifactPaths as collectInternalArtifactPathsImpl,
  collectProtectedArtifacts as collectProtectedArtifactsImpl,
  commitAllChanges as commitAllChangesImpl,
  commitAllChangesWithSubject as commitAllChangesWithSubjectImpl,
  commitQueuedChanges as commitQueuedChangesImpl,
  commitStagedChanges as commitStagedChangesImpl,
  commitStagedWithSubject as commitStagedWithSubjectImpl,
  createPreGDriveSnapshot as createPreGDriveSnapshotImpl,
  enforceProtectedArtifacts as enforceProtectedArtifactsImpl,
  ensureVaultGitRepo as ensureVaultGitRepoImpl,
  isInternalArtifactPath as isInternalArtifactPathImpl
} from "./daemon-git.js";
import { pollRequestedAction } from "./daemon-controller.js";
import {
  captureTrackedSnapshot as captureTrackedSnapshotImpl,
  pollForChanges as pollForChangesImpl,
  recordWatchFailure as recordWatchFailureImpl,
  shouldSkipDirectory as shouldSkipDirectoryImpl,
  startPollingFallback as startPollingFallbackImpl,
  walkDirectory as walkDirectoryImpl,
  watchOne as watchOneImpl
} from "./daemon-watch.js";
import {
  isProtectedArtifactPath
} from "./protected-artifacts.js";
import {
  classifyGDriveImport as classifyGDriveImportImpl,
  createNotesAutomationAdapters,
  executeSyncRun,
  handleSuccessfulGDriveImport as handleSuccessfulGDriveImportImpl,
  pullGitInbound as pullGitInboundImpl,
  pushGitOutbound as pushGitOutboundImpl,
  quarantineGitConflicts as quarantineGitConflictsImpl,
  runQueuedSync,
  syncGoogleDriveInbound as syncGoogleDriveInboundImpl
} from "./sync-run.js";
import { readState, writeState } from "./state.js";

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function escapeRegex(input) {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function globToRegex(glob) {
  let pattern = escapeRegex(toPosix(glob));
  pattern = pattern.replace(/\*\*/g, "###DOUBLESTAR###");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/###DOUBLESTAR###/g, ".*");
  return new RegExp(`^${pattern}$`);
}

export function matchesGlob(filePath, globs) {
  const p = toPosix(filePath);
  return globs.some((glob) => globToRegex(glob).test(p));
}

function isProcessRunning(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function summarizeCommandOutput(value, { maxLines = 20, maxChars = 4000 } = {}) {
  const text = String(value || "").trim();
  if (!text) return "";
  const clippedLines = text.split(/\r?\n/).slice(-maxLines).join("\n");
  if (clippedLines.length <= maxChars) return clippedLines;
  return clippedLines.slice(-maxChars);
}

function createSyncState(overrides = {}) {
  return {
    status: "idle",
    reason: null,
    queuedReason: null,
    startedAt: null,
    finishedAt: null,
    lastSuccessAt: null,
    lastError: null,
    conflictCount: 0,
    conflicts: [],
    lastGDriveImportClassification: null,
    lastGDriveImportSummary: null,
    lastPreGDriveSnapshotCommit: null,
    preGDriveSnapshotSkipped: null,
    reviewNeeded: false,
    ...overrides
  };
}

export class NotesAutomationService {
  constructor(configPath, { adapters = {} } = {}) {
    this.config = loadConfig(configPath);
    this.vaultPath = this.config.vaultPath;
    this.changedFiles = new Set();
    this.commitTimer = null;
    this.pushTimer = null;
    this.controlTimer = null;
    this.watchers = [];
    this.paused = false;
    this.vaultGitReady = false;
    this.pollTimer = null;
    this.watchMode = "fswatch";
    this.watchFailures = [];
    this.trackedSnapshot = new Map();
    this.pollIntervalMs = null;
    this.runId = randomUUID();
    this.syncLock = false;
    this.syncPromise = null;
    this.queuedSyncReason = null;
    this.conflicts = [];
    this.adapters = createNotesAutomationAdapters(adapters);
  }

  updateState(partial, { force = false } = {}) {
    const current = readState();
    const ownerRunId = typeof current.runId === "string" ? current.runId : "";
    const ownedByThisProcess =
      !ownerRunId || ownerRunId === this.runId || Number(current.pid) === process.pid;
    if (!ownedByThisProcess && !force) {
      return false;
    }

    const hasRunning = Object.prototype.hasOwnProperty.call(partial, "running");
    const hasPid = Object.prototype.hasOwnProperty.call(partial, "pid");

    const next = {
      ...current,
      paused: this.paused,
      updatedAt: new Date().toISOString(),
      ...partial,
      runId: this.runId
    };

    if (!hasRunning && typeof next.running !== "boolean") {
      next.running = true;
    }
    if (!hasPid) {
      next.pid = next.running === false ? null : process.pid;
    }

    writeState(next);
    return true;
  }

  updateSyncState(partial, { force = false } = {}) {
    const current = readState();
    const sync = createSyncState({
      ...(current.sync && typeof current.sync === "object" ? current.sync : {}),
      ...partial
    });
    this.updateState({ sync }, { force });
  }

  clearConflicts() {
    this.conflicts = [];
    this.updateSyncState({
      status: this.paused ? "paused" : "idle",
      conflictCount: 0,
      conflicts: []
    });
  }

  summarizeCommandOutput(value, options) {
    return summarizeCommandOutput(value, options);
  }

  createSyncState(overrides = {}) {
    return createSyncState(overrides);
  }

  assertNoRunningOwner() {
    const current = readState();
    const ownerRunId = typeof current.runId === "string" ? current.runId : "";
    const ownerPid = Number(current.pid);
    const currentVaultPath = current.vaultPath ? path.resolve(String(current.vaultPath)) : "";
    const sameVault = !currentVaultPath || currentVaultPath === path.resolve(this.vaultPath);
    if (
      sameVault &&
      ownerRunId &&
      ownerRunId !== this.runId &&
      Number.isInteger(ownerPid) &&
      ownerPid !== process.pid &&
      isProcessRunning(ownerPid)
    ) {
      throw new Error(`another notes-automation instance is already running with pid ${ownerPid}`);
    }
  }

  shouldTrack(relativePath) {
    if (!relativePath) return false;
    if (isProtectedArtifactPath(relativePath)) return false;
    if (matchesGlob(relativePath, this.config.ignoreGlobs)) return false;
    return matchesGlob(relativePath, this.config.includeGlobs);
  }

  queue(relativePath) {
    if (!this.shouldTrack(relativePath)) return;
    this.changedFiles.add(relativePath);

    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
    }

    this.commitTimer = setTimeout(() => {
      void this.runSync({ reason: "debounce" });
    }, this.config.debounceMs);
  }

  recordWatchFailure(watchPath, error) {
    return recordWatchFailureImpl(this, watchPath, error);
  }

  shouldSkipDirectory(relativePath) {
    return shouldSkipDirectoryImpl(this, relativePath);
  }

  captureTrackedSnapshot() {
    return captureTrackedSnapshotImpl(this);
  }

  walkDirectory(absolutePath, snapshot) {
    return walkDirectoryImpl(this, absolutePath, snapshot);
  }

  startPollingFallback(reason) {
    return startPollingFallbackImpl(this, reason);
  }

  pollForChanges() {
    return pollForChangesImpl(this);
  }

  ensureVaultGitRepo() {
    return ensureVaultGitRepoImpl(this);
  }

  collectProtectedArtifacts() {
    return collectProtectedArtifactsImpl(this);
  }

  enforceProtectedArtifacts() {
    return enforceProtectedArtifactsImpl(this);
  }

  commitQueuedChanges(label) {
    return commitQueuedChangesImpl(this, label);
  }

  commitAllChanges(label) {
    return commitAllChangesImpl(this, label);
  }

  commitAllChangesWithSubject(subject, extraBody = []) {
    return commitAllChangesWithSubjectImpl(this, subject, extraBody);
  }

  commitStagedChanges(label) {
    return commitStagedChangesImpl(this, label);
  }

  commitStagedWithSubject(subject, { extraBody = [] } = {}) {
    return commitStagedWithSubjectImpl(this, subject, { extraBody });
  }

  quarantineGitConflicts(errorOutput = "") {
    return quarantineGitConflictsImpl(this, errorOutput);
  }

  pullGitInbound() {
    return pullGitInboundImpl(this);
  }

  syncGoogleDriveInbound() {
    return syncGoogleDriveInboundImpl(this);
  }

  pushGitOutbound() {
    return pushGitOutboundImpl(this);
  }

  isInternalArtifactPath(filePath) {
    return isInternalArtifactPathImpl(this, filePath);
  }

  collectInternalArtifactPaths() {
    return collectInternalArtifactPathsImpl(this);
  }

  captureGDriveImportBaseline() {
    return captureGDriveImportBaselineImpl(this);
  }

  createPreGDriveSnapshot() {
    return createPreGDriveSnapshotImpl(this);
  }

  classifyGDriveImport(baseline = {}) {
    return classifyGDriveImportImpl(this, baseline);
  }

  handleSuccessfulGDriveImport(reason, baseline = {}) {
    return handleSuccessfulGDriveImportImpl(this, reason, baseline);
  }

  executeSync(reason) {
    return executeSyncRun(this, reason);
  }

  runSync({ reason = "manual" } = {}) {
    return runQueuedSync(this, { reason });
  }

  pollControl() {
    return pollRequestedAction(this);
  }

  watchOne(watchPath) {
    return watchOneImpl(this, watchPath);
  }

  start() {
    if (!this.config.enabled) {
      this.updateState({ running: false, disabled: true });
      return;
    }
    this.assertNoRunningOwner();

    let attachedWatchers = 0;
    for (const watchPath of this.config.watchPaths) {
      if (this.watchOne(watchPath)) {
        attachedWatchers += 1;
      }
    }
    if (attachedWatchers === 0) {
      this.startPollingFallback(
        "No fs.watch watchers attached. Falling back to polling mode to avoid startup failure."
      );
    }

    this.pushTimer = setInterval(() => {
      void this.runSync({ reason: "interval" });
    }, this.config.pushIntervalMin * 60_000);

    this.controlTimer = setInterval(() => {
      this.pollControl();
    }, 2_000);

    this.updateState({
      running: true,
      paused: false,
      alert: null,
      requestedAction: null,
      requestedAt: null,
      watchMode: this.watchMode,
      watchFailures: this.watchFailures,
      watchAlert: this.watchMode === "polling" ? "polling fallback active" : null,
      pollIntervalMs: this.watchMode === "polling" ? this.pollIntervalMs : null,
      staleStateRecovered: false,
      lastError: null,
      stoppedAt: null,
      config: this.config,
      vaultPath: this.vaultPath,
      sync: createSyncState(),
      startedAt: new Date().toISOString()
    }, { force: true });

    void this.runSync({ reason: "start" });
  }

  async shutdown() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const watcher of this.watchers) {
      watcher.close();
    }

    await this.runSync({ reason: "stop" });
    this.updateState({
      running: false,
      pid: null,
      stoppedAt: new Date().toISOString()
    });
  }
}

export function startService(configPath) {
  const service = new NotesAutomationService(configPath);
  service.start();

  const stop = async () => {
    await service.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  return service;
}

export async function runSyncOnce(configPath, { reason = "manual-cli" } = {}) {
  const service = new NotesAutomationService(configPath);
  const startedAt = new Date().toISOString();
  service.updateState(
    {
      running: false,
      pid: null,
      paused: false,
      alert: null,
      sync: createSyncState({
        status: "syncing",
        reason,
        startedAt
      })
    },
    { force: true }
  );
  return service.runSync({ reason });
}

export { createSyncState, isProcessRunning };
