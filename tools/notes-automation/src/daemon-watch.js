import fs from "node:fs";
import path from "node:path";
import { isProtectedArtifactPath } from "./protected-artifacts.js";

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function escapeRegex(input) {
  return input.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function matchesGlob(filePath, globs) {
  const p = toPosix(filePath);
  return globs.some((glob) => {
    let pattern = escapeRegex(toPosix(glob));
    pattern = pattern.replace(/\*\*/g, "###DOUBLESTAR###");
    pattern = pattern.replace(/\*/g, "[^/]*");
    pattern = pattern.replace(/###DOUBLESTAR###/g, ".*");
    return new RegExp(`^${pattern}$`).test(p);
  });
}

export function recordWatchFailure(service, watchPath, error) {
  const code = error && typeof error === "object" ? error.code || "UNKNOWN" : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  const failure = {
    watchPath,
    code: String(code),
    message: String(message),
    at: new Date().toISOString()
  };
  service.watchFailures.push(failure);
  if (service.watchFailures.length > 10) {
    service.watchFailures = service.watchFailures.slice(-10);
  }
  service.updateState({
    watchFailures: service.watchFailures,
    watchAlert: `watcher failure at ${watchPath}: [${failure.code}] ${failure.message}`
  });
}

export function shouldSkipDirectory(service, relativePath) {
  const normalized = relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
  if (matchesGlob(relativePath, service.config.ignoreGlobs)) return true;
  if (matchesGlob(normalized, service.config.ignoreGlobs)) return true;
  return false;
}

export function walkDirectory(service, absolutePath, snapshot) {
  let entries = [];
  try {
    entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryAbsolutePath = path.join(absolutePath, entry.name);
    const relativePath = toPosix(path.relative(service.vaultPath, entryAbsolutePath));
    if (!relativePath || relativePath.startsWith("..")) continue;

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(service, relativePath)) continue;
      walkDirectory(service, entryAbsolutePath, snapshot);
      continue;
    }

    if (!entry.isFile()) continue;
    if (isProtectedArtifactPath(relativePath)) continue;
    if (!service.shouldTrack(relativePath)) continue;

    try {
      const stat = fs.statSync(entryAbsolutePath);
      snapshot.set(relativePath, `${stat.mtimeMs}:${stat.size}`);
    } catch {}
  }
}

export function captureTrackedSnapshot(service) {
  const next = new Map();
  for (const watchPath of service.config.watchPaths) {
    const absoluteRoot = path.resolve(service.vaultPath, watchPath);
    walkDirectory(service, absoluteRoot, next);
  }
  return next;
}

export function startPollingFallback(service, reason) {
  if (service.pollTimer) return;
  service.watchMode = "polling";
  service.trackedSnapshot = captureTrackedSnapshot(service);
  service.pollIntervalMs = Math.max(service.config.debounceMs * 2, 5000);
  service.pollTimer = setInterval(() => {
    pollForChanges(service);
  }, service.pollIntervalMs);
  service.updateState({
    watchMode: service.watchMode,
    watchAlert: reason,
    watchFailures: service.watchFailures,
    pollIntervalMs: service.pollIntervalMs
  });
}

export function pollForChanges(service) {
  if (service.paused) return;
  try {
    const nextSnapshot = captureTrackedSnapshot(service);
    for (const [relativePath, signature] of nextSnapshot.entries()) {
      if (service.trackedSnapshot.get(relativePath) !== signature) {
        service.queue(relativePath);
      }
    }
    service.trackedSnapshot = nextSnapshot;
  } catch (error) {
    service.updateState({
      watchAlert: `polling watcher error: ${String(error?.message || error)}`
    });
  }
}

export function watchOne(service, watchPath) {
  const absolute = path.resolve(service.vaultPath, watchPath);
  let watcher;
  try {
    watcher = fs.watch(
      absolute,
      { persistent: true, recursive: true },
      (_eventType, fileName) => {
        if (!fileName) return;
        const relPath = toPosix(path.relative(service.vaultPath, path.resolve(absolute, fileName)));
        service.queue(relPath);
      }
    );
  } catch (error) {
    recordWatchFailure(service, watchPath, error);
    return false;
  }

  watcher.on("error", (error) => {
    recordWatchFailure(service, watchPath, error);
    try {
      watcher.close();
    } catch {}
    service.watchers = service.watchers.filter((entry) => entry !== watcher);
    if (service.watchMode !== "polling") {
      startPollingFallback(
        service,
        "File watcher degraded to polling mode after watcher error. Auto-sync remains active."
      );
    }
  });

  service.watchers.push(watcher);
  return true;
}
