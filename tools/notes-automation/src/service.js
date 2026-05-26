import fs from "node:fs";
import path from "node:path";
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
  }

  updateState(partial) {
    const current = readState();
    writeState({
      running: true,
      pid: process.pid,
      paused: this.paused,
      updatedAt: new Date().toISOString(),
      ...current,
      ...partial
    });
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

  ensureVaultGitRepo() {
    if (!this.config.git.enabled) return true;
    if (this.vaultGitReady) return true;

    if (!gitHasRepo(this.vaultPath)) {
      gitInit(this.vaultPath);
    }

    if (this.config.git.mode === "remote" && this.config.git.repoUrl) {
      gitRemoteSetUrl(this.config.git.remote, this.config.git.repoUrl, this.vaultPath);
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
      this.ensureVaultGitRepo();
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
    this.ensureVaultGitRepo();
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
    const result = syncToGoogleDrive(this.vaultPath, this.config.gdrive);
    if (result.ok) {
      this.updateState({
        lastGDriveSyncAt: new Date().toISOString(),
        lastGDriveError: null
      });
      return;
    }

    this.updateState({
      lastGDriveError: result.error || "unknown gdrive sync error"
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
    const watcher = fs.watch(
      absolute,
      { persistent: true, recursive: true },
      (_eventType, fileName) => {
        if (!fileName) return;
        const relPath = toPosix(path.relative(this.vaultPath, path.resolve(absolute, fileName)));
        this.queue(relPath);
      }
    );
    this.watchers.push(watcher);
  }

  start() {
    if (!this.config.enabled) {
      this.updateState({ running: false, disabled: true });
      return;
    }

    for (const watchPath of this.config.watchPaths) {
      this.watchOne(watchPath);
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
      config: this.config,
      vaultPath: this.vaultPath,
      startedAt: new Date().toISOString()
    });
  }

  async shutdown() {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.flushSyncBackends();
    this.updateState({
      running: false,
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
