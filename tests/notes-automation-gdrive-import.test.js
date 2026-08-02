import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { classifyGDriveImport } from "../tools/notes-automation/src/domain/gdrive-import.js";

const VAULT_PATH = "/vault";

function names(prefix, count, { start = 0 } = {}) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push(`${prefix}${start + index}.md`);
  }
  return out;
}

function makeChanges(status, paths) {
  return paths.map((filePath) => ({ status, path: filePath }));
}

function createFakeService({
  changes = [],
  trackedFiles = [],
  existingPaths = null,
  internalArtifactPathsAfter = new Set(),
  isInternalArtifactPath = () => false,
  gdriveImportThresholds = {},
  gitEnabled = true,
  ensureVaultGitRepoResult = true
} = {}) {
  const existing = existingPaths || new Set(trackedFiles);
  return {
    vaultPath: VAULT_PATH,
    config: {
      git: { enabled: gitEnabled },
      gdriveImport: gdriveImportThresholds
    },
    adapters: {
      fs: {
        existsSync: (absolutePath) => {
          const relative = path.relative(VAULT_PATH, absolutePath).split(path.sep).join("/");
          return existing.has(relative);
        }
      },
      git: {
        workingTreeChanges: () => changes,
        trackedFiles: () => trackedFiles
      }
    },
    ensureVaultGitRepo: () => ensureVaultGitRepoResult,
    collectInternalArtifactPaths: () => internalArtifactPathsAfter,
    isInternalArtifactPath
  };
}

test("classifyGDriveImport: normal control classifies a small edit as normal with no reasons", () => {
  const trackedFiles = names("file", 100);
  const service = createFakeService({
    changes: makeChanges("M", ["file0.md", "file1.md"]),
    trackedFiles
  });

  const result = classifyGDriveImport(service, { trackedFilesBefore: 100, internalArtifactPathsBefore: new Set() });

  assert.equal(result.classification, "normal");
  assert.equal(result.summary.changedCount, 2);
  assert.equal(result.summary.deletedCount, 0);
  assert.equal(result.summary.vaultNearlyEmpty, false);
  assert.equal(result.summary.rootRenameOrDelete, false);
  assert.deepEqual(result.summary.reasons, []);
});

test("classifyGDriveImport: dangerous when changedPercent crosses the dangerous threshold", () => {
  const trackedFiles = names("file", 100);
  const service = createFakeService({
    changes: makeChanges("M", names("file", 60)),
    trackedFiles
  });

  const result = classifyGDriveImport(service, { trackedFilesBefore: 100, internalArtifactPathsBefore: new Set() });

  assert.equal(result.classification, "dangerous");
  assert.equal(result.summary.changedPercent, 60);
  assert.equal(result.summary.vaultNearlyEmpty, false);
  assert.ok(result.summary.reasons.includes("changed_percent_above_dangerous"));
});

test("classifyGDriveImport: dangerous when deletedPercent crosses the dangerous threshold", () => {
  const trackedFiles = names("file", 100);
  const existingPaths = new Set(names("file", 40, { start: 60 }));
  const service = createFakeService({
    changes: makeChanges("D", names("file", 60)),
    trackedFiles,
    existingPaths
  });

  const result = classifyGDriveImport(service, { trackedFilesBefore: 100, internalArtifactPathsBefore: new Set() });

  assert.equal(result.classification, "dangerous");
  assert.equal(result.summary.deletedPercent, 60);
  assert.equal(result.summary.trackedFilesExisting, 40);
  assert.equal(result.summary.vaultNearlyEmpty, false);
  assert.ok(result.summary.reasons.includes("deleted_percent_above_dangerous"));
});

test("classifyGDriveImport: dangerous when the vault is nearly empty even with a tiny diff", () => {
  const trackedFiles = names("file", 100);
  const existingPaths = new Set(names("file", 5));
  const service = createFakeService({
    changes: makeChanges("M", ["file0.md", "file1.md"]),
    trackedFiles,
    existingPaths
  });

  const result = classifyGDriveImport(service, { trackedFilesBefore: 100, internalArtifactPathsBefore: new Set() });

  assert.equal(result.classification, "dangerous");
  assert.equal(result.summary.vaultNearlyEmpty, true);
  assert.equal(result.summary.changedPercent, 2);
  assert.equal(result.summary.deletedPercent, 0);
  assert.deepEqual(result.summary.reasons, ["vault_nearly_empty"]);
});

test("classifyGDriveImport: vaultNearlyEmpty boundary is Math.max(1, floor(trackedBaseline * 0.1))", () => {
  // trackedBaseline = 5 -> floor(0.5) = 0 -> max(1, 0) = 1: 1 existing file is "nearly empty".
  const trackedFiles = names("file", 5);
  const atBoundaryService = createFakeService({
    changes: [],
    trackedFiles,
    existingPaths: new Set(["file0.md"])
  });
  const atBoundary = classifyGDriveImport(atBoundaryService, {
    trackedFilesBefore: 5,
    internalArtifactPathsBefore: new Set()
  });
  assert.equal(atBoundary.summary.vaultNearlyEmpty, true);
  assert.equal(atBoundary.summary.trackedFilesExisting, 1);

  const aboveBoundaryService = createFakeService({
    changes: [],
    trackedFiles,
    existingPaths: new Set(["file0.md", "file1.md"])
  });
  const aboveBoundary = classifyGDriveImport(aboveBoundaryService, {
    trackedFilesBefore: 5,
    internalArtifactPathsBefore: new Set()
  });
  assert.equal(aboveBoundary.summary.vaultNearlyEmpty, false);
  assert.equal(aboveBoundary.summary.trackedFilesExisting, 2);
});

test("classifyGDriveImport: suspicious when a rename crosses top-level directories", () => {
  const trackedFiles = names("file", 1000);
  const service = createFakeService({
    changes: [{ status: "R", path: "newFolder/note.md", previousPath: "oldFolder/note.md" }],
    trackedFiles
  });

  const result = classifyGDriveImport(service, { trackedFilesBefore: 1000, internalArtifactPathsBefore: new Set() });

  assert.equal(result.classification, "suspicious");
  assert.equal(result.summary.rootRenameOrDelete, true);
  assert.deepEqual(result.summary.reasons, ["root_rename_or_delete_pattern"]);
});

test("classifyGDriveImport: suspicious when changedCount crosses the suspicious file-count threshold", () => {
  const trackedFiles = names("file", 10000);
  const service = createFakeService({
    changes: makeChanges("M", names("file", 21)),
    trackedFiles
  });

  const result = classifyGDriveImport(service, {
    trackedFilesBefore: 10000,
    internalArtifactPathsBefore: new Set()
  });

  assert.equal(result.classification, "suspicious");
  assert.equal(result.summary.changedCount, 21);
  assert.deepEqual(result.summary.reasons, ["changed_count_above_suspicious"]);
});

test("classifyGDriveImport: suspicious when deletedCount crosses the suspicious delete threshold", () => {
  const trackedFiles = names("file", 10000);
  const existingPaths = new Set(trackedFiles.filter((name) => !names("file", 5).includes(name)));
  const service = createFakeService({
    changes: makeChanges("D", names("file", 5)),
    trackedFiles,
    existingPaths
  });

  const result = classifyGDriveImport(service, {
    trackedFilesBefore: 10000,
    internalArtifactPathsBefore: new Set()
  });

  assert.equal(result.classification, "suspicious");
  assert.equal(result.summary.deletedCount, 5);
  assert.equal(result.summary.vaultNearlyEmpty, false);
  assert.deepEqual(result.summary.reasons, ["delete_count_above_suspicious"]);
});

test("classifyGDriveImport: suspicious when changedPercent crosses the suspicious percent threshold", () => {
  const trackedFiles = names("file", 100);
  const service = createFakeService({
    changes: makeChanges("M", names("file", 15)),
    trackedFiles
  });

  const result = classifyGDriveImport(service, { trackedFilesBefore: 100, internalArtifactPathsBefore: new Set() });

  assert.equal(result.classification, "suspicious");
  assert.equal(result.summary.changedPercent, 15);
  assert.deepEqual(result.summary.reasons, ["changed_percent_above_suspicious"]);
});
