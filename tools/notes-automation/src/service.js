import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import {
  gitAdd,
  gitAddAll,
  gitAbortReconcile,
  gitCachedNames,
  gitCommit,
  gitEnsureIgnoreEntries,
  gitFetchBranch,
  gitHasRepo,
  gitInit,
  gitListConflictedFiles,
  gitRebaseOnto,
  gitListTracked,
  gitRevParse,
  gitTrackedFiles,
  gitWorkingTreeChanges,
  gitPush,
  gitReadStageFile,
  gitRemoveCached,
  gitRemoteSetUrl
} from "./git.js";
import { syncToGoogleDrive } from "./gdrive.js";
import {
  PROTECTED_GITIGNORE_LINES,
  PROTECTED_GIT_PATHS,
  isProtectedArtifactPath,
  normalizeRelativePath
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

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
    const code = error && typeof error === "object" ? error.code || "UNKNOWN" : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    const failure = {
      watchPath,
      code: String(code),
      message: String(message),
      at: new Date().toISOString()
    };
    this.watchFailures.push(failure);
    if (this.watchFailures.length > 10) {
      this.watchFailures = this.watchFailures.slice(-10);
    }
    this.updateState({
      watchFailures: this.watchFailures,
      watchAlert: `watcher failure at ${watchPath}: [${failure.code}] ${failure.message}`
    });
  }

  shouldSkipDirectory(relativePath) {
    const normalized = relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
    if (matchesGlob(relativePath, this.config.ignoreGlobs)) return true;
    if (matchesGlob(normalized, this.config.ignoreGlobs)) return true;
    return false;
  }

  captureTrackedSnapshot() {
    const next = new Map();
    for (const watchPath of this.config.watchPaths) {
      const absoluteRoot = path.resolve(this.vaultPath, watchPath);
      this.walkDirectory(absoluteRoot, next);
    }
    return next;
  }

  walkDirectory(absolutePath, snapshot) {
    let entries = [];
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryAbsolutePath = path.join(absolutePath, entry.name);
      const relativePath = toPosix(path.relative(this.vaultPath, entryAbsolutePath));
      if (!relativePath || relativePath.startsWith("..")) continue;

      if (entry.isDirectory()) {
        if (this.shouldSkipDirectory(relativePath)) continue;
        this.walkDirectory(entryAbsolutePath, snapshot);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!this.shouldTrack(relativePath)) continue;

      try {
        const stat = fs.statSync(entryAbsolutePath);
        snapshot.set(relativePath, `${stat.mtimeMs}:${stat.size}`);
      } catch {}
    }
  }

  startPollingFallback(reason) {
    if (this.pollTimer) return;
    this.watchMode = "polling";
    this.trackedSnapshot = this.captureTrackedSnapshot();
    this.pollIntervalMs = Math.max(this.config.debounceMs * 2, 5000);
    this.pollTimer = setInterval(() => {
      this.pollForChanges();
    }, this.pollIntervalMs);
    this.updateState({
      watchMode: this.watchMode,
      watchAlert: reason,
      watchFailures: this.watchFailures,
      pollIntervalMs: this.pollIntervalMs
    });
  }

  pollForChanges() {
    if (this.paused) return;
    try {
      const nextSnapshot = this.captureTrackedSnapshot();
      for (const [relativePath, signature] of nextSnapshot.entries()) {
        if (this.trackedSnapshot.get(relativePath) !== signature) {
          this.queue(relativePath);
        }
      }
      this.trackedSnapshot = nextSnapshot;
    } catch (error) {
      this.updateState({
        watchAlert: `polling watcher error: ${String(error?.message || error)}`
      });
    }
  }

  ensureVaultGitRepo() {
    if (!this.config.git.enabled) return true;
    if (this.vaultGitReady) return true;
    try {
      if (!gitHasRepo(this.vaultPath)) {
        gitInit(this.vaultPath);
      }

      if (this.config.git.mode === "remote" && this.config.git.repoUrl) {
        gitRemoteSetUrl(this.config.git.remote, this.config.git.repoUrl, this.vaultPath);
      }
    } catch (error) {
      this.updateState({
        lastError: `git repo setup failure: ${String(error?.message || error)}`
      });
      return false;
    }

    this.vaultGitReady = true;
    return true;
  }

  collectProtectedArtifacts() {
    const dsStoreFiles = [];
    const stack = [this.vaultPath];

    while (stack.length) {
      const next = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(next, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absolute = path.join(next, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".git") continue;
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name !== ".DS_Store") continue;
        dsStoreFiles.push(absolute);
      }
    }

    return dsStoreFiles;
  }

  enforceProtectedArtifacts() {
    if (!this.config.git.enabled) return;
    if (!this.ensureVaultGitRepo()) return;

    gitEnsureIgnoreEntries(PROTECTED_GITIGNORE_LINES, this.vaultPath);

    for (const absolute of this.collectProtectedArtifacts()) {
      try {
        fs.unlinkSync(absolute);
      } catch {}
    }

    const tracked = gitListTracked(PROTECTED_GIT_PATHS, this.vaultPath);
    if (!tracked.length) return;
    gitRemoveCached(PROTECTED_GIT_PATHS, this.vaultPath);
  }

  commitQueuedChanges(label) {
    if (!this.config.git.enabled) return;
    const files = [...new Set([...this.changedFiles].map(normalizeRelativePath))];
    this.changedFiles.clear();
    if (!files.length) return;

    if (!this.ensureVaultGitRepo()) return;
    for (const relPath of files) {
      if (!relPath || isProtectedArtifactPath(relPath)) continue;
      gitAdd(relPath, this.vaultPath);
    }
    return this.commitStagedChanges(label);
  }

  commitAllChanges(label) {
    if (!this.config.git.enabled) return;
    if (!this.ensureVaultGitRepo()) return;
    gitAddAll(this.vaultPath);
    return this.commitStagedChanges(label);
  }

  commitAllChangesWithSubject(subject, extraBody = []) {
    if (!this.config.git.enabled) return { committed: false, staged: [] };
    if (!this.ensureVaultGitRepo()) return { committed: false, staged: [], error: "git repo not ready" };
    gitAddAll(this.vaultPath);
    return this.commitStagedWithSubject(subject, { extraBody });
  }

  commitStagedChanges(label) {
    const staged = gitCachedNames(this.vaultPath);
    const subject = `notes(sync): ${label}`;
    return this.commitStagedWithSubject(subject);
  }

  commitStagedWithSubject(subject, { extraBody = [] } = {}) {
    const staged = gitCachedNames(this.vaultPath);
    if (!staged.length) return { committed: false, staged: [] };
    const body = [
      "source=notes-automation",
      `files=${staged.slice(0, 10).join(", ")}`,
      ...extraBody.filter(Boolean)
    ];
    gitCommit(subject, body, this.vaultPath);
    let commitHash = null;
    try {
      commitHash = gitRevParse("HEAD", this.vaultPath);
    } catch {}
    this.updateState({
      lastCommitAt: new Date().toISOString(),
      lastCommitFiles: staged,
      lastCommitHash: commitHash
    });
    return {
      committed: true,
      staged,
      commitHash
    };
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
    const normalized = normalizeRelativePath(filePath);
    if (!normalized) return false;
    if (isProtectedArtifactPath(normalized)) return true;
    if (normalized === ".obsidian/workspace.json") return true;
    if (normalized === ".logs" || normalized.startsWith(".logs/")) return true;
    if (normalized === ".git" || normalized.startsWith(".git/")) return true;
    return false;
  }

  collectInternalArtifactPaths() {
    const entries = new Set();
    const stack = [this.vaultPath];

    while (stack.length) {
      const absolutePath = stack.pop();
      let dirEntries = [];
      try {
        dirEntries = fs.readdirSync(absolutePath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of dirEntries) {
        const absolute = path.join(absolutePath, entry.name);
        const relative = normalizeRelativePath(path.relative(this.vaultPath, absolute));
        if (!relative || relative.startsWith("..")) continue;

        if (entry.isDirectory()) {
          if (relative === ".git") continue;
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!this.isInternalArtifactPath(relative)) continue;
        entries.add(relative);
      }
    }

    return entries;
  }

  captureGDriveImportBaseline() {
    const trackedFilesBefore =
      this.config.git.enabled && this.ensureVaultGitRepo() ? gitTrackedFiles(this.vaultPath).length : 0;
    return {
      trackedFilesBefore,
      internalArtifactPathsBefore: this.collectInternalArtifactPaths()
    };
  }

  createPreGDriveSnapshot() {
    if (!this.config.git.enabled) {
      this.updateSyncState({
        lastPreGDriveSnapshotCommit: null,
        preGDriveSnapshotSkipped: "git-disabled"
      });
      return { ok: true, skipped: true, reason: "git-disabled" };
    }
    if (!this.ensureVaultGitRepo()) {
      return { ok: false, error: "git repo not ready" };
    }

    gitAddAll(this.vaultPath);
    const staged = gitCachedNames(this.vaultPath).filter((filePath) => !isProtectedArtifactPath(filePath));
    if (!staged.length) {
      this.updateSyncState({
        lastPreGDriveSnapshotCommit: null,
        preGDriveSnapshotSkipped: "clean"
      });
      return { ok: true, skipped: true, reason: "clean" };
    }

    const snapshotCommit = this.commitStagedWithSubject("backup(sync): snapshot before gdrive import", {
      extraBody: ["reason=pre-gdrive-import"]
    });
    this.updateSyncState({
      lastPreGDriveSnapshotCommit: snapshotCommit.commitHash || null,
      preGDriveSnapshotSkipped: null
    });
    return {
      ok: true,
      skipped: false,
      commitHash: snapshotCommit.commitHash || null,
      staged: snapshotCommit.staged || staged
    };
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
    const state = readState();
    const action = state.requestedAction;
    if (!action) return;

    if (action === "resume") {
      this.paused = false;
      this.clearConflicts();
      this.updateState({
        paused: false,
        alert: null,
        requestedAction: null,
        resumedAt: new Date().toISOString(),
        lastError: null
      });
      return;
    }

    if (action === "flush-push" || action === "flush-sync" || action === "sync") {
      this.updateState({ requestedAction: null });
      void this.runSync({ reason: action });
    }
  }

  watchOne(watchPath) {
    const absolute = path.resolve(this.vaultPath, watchPath);
    let watcher;
    try {
      watcher = fs.watch(
        absolute,
        { persistent: true, recursive: true },
        (_eventType, fileName) => {
          if (!fileName) return;
          const relPath = toPosix(path.relative(this.vaultPath, path.resolve(absolute, fileName)));
          this.queue(relPath);
        }
      );
    } catch (error) {
      this.recordWatchFailure(watchPath, error);
      return false;
    }

    watcher.on("error", (error) => {
      this.recordWatchFailure(watchPath, error);
      try {
        watcher.close();
      } catch {}
      this.watchers = this.watchers.filter((entry) => entry !== watcher);
      if (this.watchMode !== "polling") {
        this.startPollingFallback(
          "File watcher degraded to polling mode after watcher error. Auto-sync remains active."
        );
      }
    });

    this.watchers.push(watcher);
    return true;
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
