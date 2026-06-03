import path from "node:path";
import { DEFAULT_GDRIVE_IMPORT_THRESHOLDS } from "./gdrive-import-thresholds.js";
import {
  isProtectedArtifactPath,
  normalizeRelativePath
} from "./protected-artifacts.js";

export const GDRIVE_IMPORT_CLASSIFICATION = Object.freeze({
  NORMAL: "normal",
  SUSPICIOUS: "suspicious",
  DANGEROUS: "dangerous"
});

export const GDRIVE_IMPORT_COMMIT_SUBJECT = Object.freeze({
  [GDRIVE_IMPORT_CLASSIFICATION.NORMAL]: "sync(gdrive): import live-storage changes",
  [GDRIVE_IMPORT_CLASSIFICATION.SUSPICIOUS]: "sync(gdrive): suspicious live-storage import",
  [GDRIVE_IMPORT_CLASSIFICATION.DANGEROUS]: "sync(gdrive): dangerous import held for review"
});

export const GDRIVE_IMPORT_NEXT_ACTION = Object.freeze({
  [GDRIVE_IMPORT_CLASSIFICATION.DANGEROUS]:
    "review latest local sync(gdrive) dangerous commit; restore from pre-GDrive snapshot if needed; run sync-resolve/resume after manual verification",
  [GDRIVE_IMPORT_CLASSIFICATION.SUSPICIOUS]:
    "review imported diff summary and confirm before continuing normal automation"
});

export const GDRIVE_IMPORT_DANGEROUS_ERROR =
  "dangerous gdrive import held for review (post-import push skipped)";
export const GDRIVE_IMPORT_DANGEROUS_ALERT =
  "Sync paused: dangerous Google Drive import detected. Review latest local commit and restore from pre-GDrive snapshot if needed before resuming.";

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

function resolveGDriveImportThresholds(thresholds = {}) {
  return {
    ...DEFAULT_GDRIVE_IMPORT_THRESHOLDS,
    ...(thresholds && typeof thresholds === "object" ? thresholds : {})
  };
}

export function requiresGDriveImportReview(classification) {
  return (
    classification === GDRIVE_IMPORT_CLASSIFICATION.SUSPICIOUS ||
    classification === GDRIVE_IMPORT_CLASSIFICATION.DANGEROUS
  );
}

export function resolveGDriveImportCommitSubject(classification) {
  return (
    GDRIVE_IMPORT_COMMIT_SUBJECT[classification] ||
    GDRIVE_IMPORT_COMMIT_SUBJECT[GDRIVE_IMPORT_CLASSIFICATION.NORMAL]
  );
}

export function summarizeGDriveImportStatus(sync) {
  const gdriveImport = sync.lastGDriveImportClassification || null;
  const gdriveImportSummary =
    sync.lastGDriveImportSummary && typeof sync.lastGDriveImportSummary === "object"
      ? sync.lastGDriveImportSummary
      : null;
  const reviewNeeded = Boolean(sync.reviewNeeded);

  return {
    gdriveImport,
    gdriveImportSummary,
    reviewNeeded,
    nextAction: GDRIVE_IMPORT_NEXT_ACTION[gdriveImport] || null
  };
}

export function classifyGDriveImport(service, baseline = {}) {
  const fileSystem = service.adapters.fs;
  const git = service.adapters.git;
  const trackedFilesBefore = Number(baseline.trackedFilesBefore || 0);
  const internalBefore =
    baseline.internalArtifactPathsBefore instanceof Set
      ? baseline.internalArtifactPathsBefore
      : new Set();
  const thresholds = resolveGDriveImportThresholds(service.config.gdriveImport);

  if (!service.config.git.enabled || !service.ensureVaultGitRepo()) {
    return {
      classification: GDRIVE_IMPORT_CLASSIFICATION.NORMAL,
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

  let classification = GDRIVE_IMPORT_CLASSIFICATION.NORMAL;
  if (dangerous) classification = GDRIVE_IMPORT_CLASSIFICATION.DANGEROUS;
  else if (suspicious) classification = GDRIVE_IMPORT_CLASSIFICATION.SUSPICIOUS;

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
