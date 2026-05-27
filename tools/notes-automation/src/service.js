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
  gitFetch,
  gitHasRepo,
  gitInit,
  gitListConflictedFiles,
  gitListTracked,
  gitPush,
  gitPullRebase,
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
    ...overrides
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class NotesAutomationService {
  constructor(configPath) {
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
    this.commitStagedChanges(label);
  }

  commitAllChanges(label) {
    if (!this.config.git.enabled) return;
    if (!this.ensureVaultGitRepo()) return;
    gitAddAll(this.vaultPath);
    this.commitStagedChanges(label);
  }

  commitStagedChanges(label) {
    const staged = gitCachedNames(this.vaultPath);
    if (!staged.length) return;
    const subject = `notes(sync): ${label}`;
    const body = [`source=notes-automation`, `files=${staged.slice(0, 10).join(", ")}`];
    gitCommit(subject, body, this.vaultPath);
    this.updateState({
      lastCommitAt: new Date().toISOString(),
      lastCommitFiles: staged
    });
  }

  quarantineGitConflicts(errorOutput = "") {
    const conflicts = gitListConflictedFiles(this.vaultPath);
    if (!conflicts.length) return [];

    const root = path.join(
      this.vaultPath,
      ".automation",
      "sync-conflicts",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
    );
    fs.mkdirSync(root, { recursive: true });

    const captured = [];
    for (const filePath of conflicts) {
      const safePath = normalizeRelativePath(filePath).replace(/\//g, "__");
      const worktreePath = path.join(root, `${safePath}.worktree.txt`);
      const oursPath = path.join(root, `${safePath}.ours.txt`);
      const theirsPath = path.join(root, `${safePath}.theirs.txt`);
      const basePath = path.join(root, `${safePath}.base.txt`);

      const absolute = path.join(this.vaultPath, filePath);
      let worktree = "";
      try {
        worktree = fs.readFileSync(absolute, "utf8");
      } catch {}

      ensureParentDir(worktreePath);
      fs.writeFileSync(worktreePath, worktree, "utf8");
      fs.writeFileSync(oursPath, gitReadStageFile(2, filePath, this.vaultPath), "utf8");
      fs.writeFileSync(theirsPath, gitReadStageFile(3, filePath, this.vaultPath), "utf8");
      fs.writeFileSync(basePath, gitReadStageFile(1, filePath, this.vaultPath), "utf8");

      captured.push({
        filePath,
        worktreePath,
        oursPath,
        theirsPath,
        basePath
      });
    }

    fs.writeFileSync(
      path.join(root, "summary.json"),
      JSON.stringify(
        {
          detectedAt: new Date().toISOString(),
          errorOutput: summarizeCommandOutput(errorOutput),
          conflicts: captured
        },
        null,
        2
      ),
      "utf8"
    );

    this.conflicts = captured;
    return captured;
  }

  pullGitInbound() {
    if (!this.config.git.enabled) return { ok: true, skipped: true };
    if (this.config.git.mode === "local") return { ok: true, skipped: true };
    if (!this.ensureVaultGitRepo()) return { ok: false, error: "git repo not ready" };

    try {
      gitFetch(this.config.git.remote, this.config.git.branch, this.vaultPath);
    } catch (error) {
      return {
        ok: false,
        error: `git fetch failure: ${String(error?.stderr || error?.message || error)}`
      };
    }

    const pull = gitPullRebase(this.config.git.remote, this.config.git.branch, this.vaultPath);
    if (pull.ok) {
      this.updateState({
        lastPullAt: new Date().toISOString(),
        lastPullError: null
      });
      return { ok: true };
    }

    if (pull.conflict) {
      const conflicts = this.quarantineGitConflicts(pull.output);
      gitAbortReconcile(this.vaultPath);
      this.paused = true;
      this.updateSyncState({
        status: "conflict",
        conflictCount: conflicts.length,
        conflicts,
        lastError: summarizeCommandOutput(pull.output)
      });
      this.updateState({
        paused: true,
        alert:
          "Sync paused: Git conflict detected. Run `npm run vault -- sync conflicts`, resolve files, then `npm run vault -- sync resolve --done`.",
        lastPullError: pull.output
      });
      return { ok: false, conflict: true, error: pull.output };
    }

    this.updateState({
      lastPullError: pull.output
    });
    return { ok: false, error: pull.output };
  }

  syncGoogleDriveInbound() {
    if (!this.config.gdrive.enabled) return { ok: true, skipped: true };

    const attemptedAt = new Date().toISOString();
    const result = syncToGoogleDrive(this.vaultPath, this.config.gdrive, {
      cleanupProtected: true
    });
    const nextState = {
      lastGDriveAttemptAt: attemptedAt,
      lastGDriveMode: result.command || null,
      lastGDriveArgs: Array.isArray(result.args) ? result.args : [],
      lastGDriveDryRun: Boolean(result.dryRun),
      lastGDriveResyncApplied: Boolean(result.resyncApplied)
    };

    if (result.ok) {
      this.updateState({
        ...nextState,
        lastGDriveSyncAt: new Date().toISOString(),
        lastGDriveError: null,
        lastGDriveOutput: summarizeCommandOutput(result.output)
      });
      return { ok: true };
    }

    const errorOutput = summarizeCommandOutput(result.error || result.output || "");
    this.updateState({
      ...nextState,
      lastGDriveError: result.error || "unknown gdrive sync error",
      lastGDriveOutput: errorOutput
    });

    if (result.conflict || result.unsafeFailure) {
      this.paused = true;
      this.updateSyncState({
        status: "paused",
        lastError: errorOutput
      });
      this.updateState({
        paused: true,
        alert:
          "Sync paused: Google Drive bisync needs manual intervention. Run `npm run vault -- sync` after fixing remote/local divergence.",
        lastError: errorOutput
      });
    }

    return { ok: false, error: result.error || "unknown gdrive sync error" };
  }

  pushGitOutbound() {
    if (!this.config.git.enabled) return { ok: true, skipped: true };
    if (!this.config.git.autoPush) return { ok: true, skipped: true };
    if (this.config.git.mode === "local") return { ok: true, skipped: true };
    if (!this.ensureVaultGitRepo()) return { ok: false, error: "git repo not ready" };

    const result = gitPush(this.config.git.remote, this.config.git.branch, this.vaultPath);
    if (result.ok) {
      this.updateState({
        lastPushAt: new Date().toISOString(),
        lastPushError: null
      });
      return { ok: true };
    }

    if (result.nonFastForward) {
      this.paused = true;
      this.updateState({
        paused: true,
        alert:
          "Auto-push paused: non-fast-forward detected. Resolve manually (pull/rebase or merge), then run `npm run vault:resume`.",
        lastPushError: result.output
      });
      this.updateSyncState({
        status: "paused",
        lastError: summarizeCommandOutput(result.output)
      });
      return { ok: false, error: result.output };
    }

    this.updateState({
      lastPushError: result.output
    });
    return { ok: false, error: result.output };
  }

  executeSync(reason) {
    if (this.paused) {
      this.updateSyncState({
        status: this.conflicts.length ? "conflict" : "paused",
        reason: null,
        queuedReason: null
      });
      return { ok: false, skipped: true, reason: "paused" };
    }

    const startedAt = new Date().toISOString();
    this.updateSyncState({
      status: "syncing",
      reason,
      startedAt,
      queuedReason: null,
      lastError: null
    });

    try {
      this.enforceProtectedArtifacts();
      this.commitQueuedChanges(`local changes (${reason})`);

      const pull = this.pullGitInbound();
      if (!pull.ok) {
        const finalStatus = this.paused ? (this.conflicts.length ? "conflict" : "paused") : "idle";
        this.updateSyncState({
          status: finalStatus,
          reason: null,
          finishedAt: new Date().toISOString(),
          lastError: summarizeCommandOutput(pull.error || "")
        });
        return { ok: false, error: pull.error };
      }

      const gdrive = this.syncGoogleDriveInbound();
      if (!gdrive.ok) {
        const finalStatus = this.paused ? "paused" : "idle";
        this.updateSyncState({
          status: finalStatus,
          reason: null,
          finishedAt: new Date().toISOString(),
          lastError: summarizeCommandOutput(gdrive.error || "")
        });
        return { ok: false, error: gdrive.error };
      }

      this.enforceProtectedArtifacts();
      this.commitAllChanges(`post-sync changes (${reason})`);

      const push = this.pushGitOutbound();
      if (!push.ok) {
        const finalStatus = this.paused ? "paused" : "idle";
        this.updateSyncState({
          status: finalStatus,
          reason: null,
          finishedAt: new Date().toISOString(),
          lastError: summarizeCommandOutput(push.error || "")
        });
        return { ok: false, error: push.error };
      }

      const completedAt = new Date().toISOString();
      this.updateSyncState({
        status: "idle",
        reason: null,
        finishedAt: completedAt,
        lastSuccessAt: completedAt,
        lastError: null
      });
      return { ok: true };
    } catch (error) {
      const message = String(error?.message || error);
      this.updateSyncState({
        status: this.paused ? "paused" : "idle",
        reason: null,
        finishedAt: new Date().toISOString(),
        lastError: summarizeCommandOutput(message)
      });
      this.updateState({
        lastError: `sync failure: ${message}`
      });
      return { ok: false, error: message };
    }
  }

  runSync({ reason = "manual" } = {}) {
    if (this.syncLock) {
      this.queuedSyncReason = reason;
      this.updateSyncState({ queuedReason: reason });
      return this.syncPromise || Promise.resolve({ ok: true, queued: true });
    }

    this.syncLock = true;
    this.syncPromise = Promise.resolve()
      .then(() => {
        let nextReason = reason;
        let lastResult = { ok: true };
        do {
          lastResult = this.executeSync(nextReason);
          nextReason = this.queuedSyncReason;
          this.queuedSyncReason = null;
        } while (nextReason && lastResult.ok && !this.paused);
        return lastResult;
      })
      .finally(() => {
        this.syncLock = false;
        this.syncPromise = null;
        this.queuedSyncReason = null;
        const current = readState();
        const sync = createSyncState(current.sync || {});
        if (sync.queuedReason) {
          this.updateSyncState({ queuedReason: null });
        }
      });

    return this.syncPromise;
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
