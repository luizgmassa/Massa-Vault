import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { gitAdd, gitCachedNames, gitCommit, gitPush } from "./git.js";
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
  } catch {
    return false;
  }
}

export class NotesAutomationService {
  constructor(configPath) {
    this.config = loadConfig(configPath);
    this.changedFiles = new Set();
    this.commitTimer = null;
    this.pushTimer = null;
    this.controlTimer = null;
    this.watchers = [];
    this.paused = false;
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

  commitNow() {
    if (this.paused) return;
    const files = [...this.changedFiles];
    this.changedFiles.clear();
    if (!files.length) return;

    try {
      for (const relPath of files) {
        gitAdd(relPath);
      }
      const staged = gitCachedNames();
      if (!staged.length) return;
      const subject = `notes(sync): update ${staged.length} file(s)`;
      const body = [`source=notes-automation`, `files=${staged.slice(0, 10).join(", ")}`];
      gitCommit(subject, body);
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

  flushPush() {
    if (this.paused) return;
    const result = gitPush(this.config.remote, this.config.branch);
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
          "Auto-push paused: non-fast-forward detected. Resolve manually (pull/rebase or merge), then run `npm run notes-automation:resume`.",
        lastPushError: result.output
      });
      return;
    }

    this.updateState({
      lastPushError: result.output
    });
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

    if (action === "flush-push") {
      this.updateState({ requestedAction: null });
      this.flushPush();
    }
  }

  watchOne(watchPath) {
    const absolute = path.resolve(watchPath);
    const watcher = fs.watch(
      absolute,
      { persistent: true, recursive: true },
      (_eventType, fileName) => {
        if (!fileName) return;
        const relPath = toPosix(path.relative(process.cwd(), path.resolve(absolute, fileName)));
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
      this.commitNow();
      this.flushPush();
    }, this.config.pushIntervalMin * 60_000);

    this.controlTimer = setInterval(() => {
      this.pollControl();
    }, 2_000);

    this.updateState({
      running: true,
      paused: false,
      config: this.config,
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

    this.commitNow();
    this.flushPush();
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
