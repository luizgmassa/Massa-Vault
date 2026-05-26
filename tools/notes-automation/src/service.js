import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import {
  gitAdd,
  gitCachedNames,
  gitCommit,
  gitHasRepo,
  gitInit,
  gitPush,
  gitRemoteSetUrl
} from "./git.js";
import { syncToGoogleDrive } from "./gdrive.js";
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
      this.commitNow();
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

  commitNow() {
    if (this.paused) return;
    if (!this.config.git.enabled) return;
    const files = [...this.changedFiles];
    this.changedFiles.clear();
    if (!files.length) return;

    try {
      if (!this.ensureVaultGitRepo()) return;
      for (const relPath of files) {
        gitAdd(relPath, this.vaultPath);
      }
      const staged = gitCachedNames(this.vaultPath);
      if (!staged.length) return;
      const subject = `notes(sync): update ${staged.length} file(s)`;
      const body = [`source=notes-automation`, `files=${staged.slice(0, 10).join(", ")}`];
      gitCommit(subject, body, this.vaultPath);
      this.updateState({
        lastCommitAt: new Date().toISOString(),
        lastCommitFiles: staged
      });
    } catch (error) {
      this.updateState({
        lastError: `commit failure: ${String(error?.message || error)}`
      });
    }
  }

  flushGitPush() {
    if (!this.config.git.enabled) return;
    if (!this.config.git.autoPush) return;
    if (this.config.git.mode === "local") return;
    if (this.paused) return;
    if (!this.ensureVaultGitRepo()) return;
    const result = gitPush(this.config.git.remote, this.config.git.branch, this.vaultPath);
    if (result.ok) {
      this.updateState({
        lastPushAt: new Date().toISOString(),
        lastPushError: null
      });
      return;
    }

    if (result.nonFastForward) {
      this.paused = true;
      this.updateState({
        paused: true,
        alert:
          "Auto-push paused: non-fast-forward detected. Resolve manually (pull/rebase or merge), then run `npm run vault:resume`.",
        lastPushError: result.output
      });
      return;
    }

    this.updateState({
      lastPushError: result.output
    });
  }

  flushGoogleDriveSync() {
    if (!this.config.gdrive.enabled) return;
    if (this.paused) return;

    const attemptedAt = new Date().toISOString();
    const result = syncToGoogleDrive(this.vaultPath, this.config.gdrive);
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
      return;
    }

    this.updateState({
      ...nextState,
      lastGDriveError: result.error || "unknown gdrive sync error",
      lastGDriveOutput: summarizeCommandOutput(result.error || result.output || "")
    });
  }

  flushSyncBackends() {
    this.commitNow();
    this.flushGitPush();
    this.flushGoogleDriveSync();
  }

  pollControl() {
    const state = readState();
    const action = state.requestedAction;
    if (!action) return;

    if (action === "resume") {
      this.paused = false;
      this.updateState({
        paused: false,
        alert: null,
        requestedAction: null,
        resumedAt: new Date().toISOString()
      });
      return;
    }

    if (action === "flush-push" || action === "flush-sync") {
      this.updateState({ requestedAction: null });
      this.flushSyncBackends();
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
      this.flushSyncBackends();
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
      startedAt: new Date().toISOString()
    }, { force: true });
  }

  async shutdown() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.flushSyncBackends();
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

export { isProcessRunning };
