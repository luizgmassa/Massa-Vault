export function createSyncState(overrides = {}) {
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
