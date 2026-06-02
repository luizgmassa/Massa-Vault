import fs from "node:fs";
import path from "node:path";
import {
  gitAdd,
  gitAddAll,
  gitCachedNames,
  gitCommit,
  gitEnsureIgnoreEntries,
  gitHasRepo,
  gitInit,
  gitListTracked,
  gitRevParse,
  gitTrackedFiles,
  gitRemoveCached,
  gitRemoteSetUrl
} from "./git.js";
import {
  PROTECTED_GITIGNORE_LINES,
  PROTECTED_GIT_PATHS,
  isProtectedArtifactPath,
  normalizeRelativePath
} from "./protected-artifacts.js";

export function ensureVaultGitRepo(service) {
  if (!service.config.git.enabled) return true;
  if (service.vaultGitReady) return true;
  try {
    if (!gitHasRepo(service.vaultPath)) {
      gitInit(service.vaultPath);
    }

    if (service.config.git.mode === "remote" && service.config.git.repoUrl) {
      gitRemoteSetUrl(service.config.git.remote, service.config.git.repoUrl, service.vaultPath);
    }
  } catch (error) {
    service.updateState({
      lastError: `git repo setup failure: ${String(error?.message || error)}`
    });
    return false;
  }

  service.vaultGitReady = true;
  return true;
}

export function collectProtectedArtifacts(service) {
  const dsStoreFiles = [];
  const stack = [service.vaultPath];

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

export function enforceProtectedArtifacts(service) {
  if (!service.config.git.enabled) return;
  if (!ensureVaultGitRepo(service)) return;

  gitEnsureIgnoreEntries(PROTECTED_GITIGNORE_LINES, service.vaultPath);

  for (const absolute of collectProtectedArtifacts(service)) {
    try {
      fs.unlinkSync(absolute);
    } catch {}
  }

  const tracked = gitListTracked(PROTECTED_GIT_PATHS, service.vaultPath);
  if (!tracked.length) return;
  gitRemoveCached(PROTECTED_GIT_PATHS, service.vaultPath);
}

export function commitStagedWithSubject(service, subject, { extraBody = [] } = {}) {
  const staged = gitCachedNames(service.vaultPath);
  if (!staged.length) return { committed: false, staged: [] };
  const body = [
    "source=notes-automation",
    `files=${staged.slice(0, 10).join(", ")}`,
    ...extraBody.filter(Boolean)
  ];
  gitCommit(subject, body, service.vaultPath);
  let commitHash = null;
  try {
    commitHash = gitRevParse("HEAD", service.vaultPath);
  } catch {}
  service.updateState({
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

export function commitStagedChanges(service, label) {
  const staged = gitCachedNames(service.vaultPath);
  const subject = `notes(sync): ${label}`;
  return commitStagedWithSubject(service, subject);
}

export function commitQueuedChanges(service, label) {
  if (!service.config.git.enabled) return;
  const files = [...new Set([...service.changedFiles].map(normalizeRelativePath))];
  service.changedFiles.clear();
  if (!files.length) return;

  if (!ensureVaultGitRepo(service)) return;
  for (const relPath of files) {
    if (!relPath || isProtectedArtifactPath(relPath)) continue;
    gitAdd(relPath, service.vaultPath);
  }
  return commitStagedChanges(service, label);
}

export function commitAllChanges(service, label) {
  if (!service.config.git.enabled) return;
  if (!ensureVaultGitRepo(service)) return;
  gitAddAll(service.vaultPath);
  return commitStagedChanges(service, label);
}

export function commitAllChangesWithSubject(service, subject, extraBody = []) {
  if (!service.config.git.enabled) return { committed: false, staged: [] };
  if (!ensureVaultGitRepo(service)) return { committed: false, staged: [], error: "git repo not ready" };
  gitAddAll(service.vaultPath);
  return commitStagedWithSubject(service, subject, { extraBody });
}

export function isInternalArtifactPath(_service, filePath) {
  const normalized = normalizeRelativePath(filePath);
  if (!normalized) return false;
  if (isProtectedArtifactPath(normalized)) return true;
  if (normalized === ".obsidian/workspace.json") return true;
  if (normalized === ".logs" || normalized.startsWith(".logs/")) return true;
  if (normalized === ".git" || normalized.startsWith(".git/")) return true;
  return false;
}

export function collectInternalArtifactPaths(service) {
  const entries = new Set();
  const stack = [service.vaultPath];

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
      const relative = normalizeRelativePath(path.relative(service.vaultPath, absolute));
      if (!relative || relative.startsWith("..")) continue;

      if (entry.isDirectory()) {
        if (relative === ".git") continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isInternalArtifactPath(service, relative)) continue;
      entries.add(relative);
    }
  }

  return entries;
}

export function captureGDriveImportBaseline(service) {
  const trackedFilesBefore =
    service.config.git.enabled && ensureVaultGitRepo(service) ? gitTrackedFiles(service.vaultPath).length : 0;
  return {
    trackedFilesBefore,
    internalArtifactPathsBefore: collectInternalArtifactPaths(service)
  };
}

export function createPreGDriveSnapshot(service) {
  if (!service.config.git.enabled) {
    service.updateSyncState({
      lastPreGDriveSnapshotCommit: null,
      preGDriveSnapshotSkipped: "git-disabled"
    });
    return { ok: true, skipped: true, reason: "git-disabled" };
  }
  if (!ensureVaultGitRepo(service)) {
    return { ok: false, error: "git repo not ready" };
  }

  gitAddAll(service.vaultPath);
  const staged = gitCachedNames(service.vaultPath).filter((filePath) => !isProtectedArtifactPath(filePath));
  if (!staged.length) {
    service.updateSyncState({
      lastPreGDriveSnapshotCommit: null,
      preGDriveSnapshotSkipped: "clean"
    });
    return { ok: true, skipped: true, reason: "clean" };
  }

  const snapshotCommit = commitStagedWithSubject(service, "backup(sync): snapshot before gdrive import", {
    extraBody: ["reason=pre-gdrive-import"]
  });
  service.updateSyncState({
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
