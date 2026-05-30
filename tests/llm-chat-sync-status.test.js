import test from "node:test";
import assert from "node:assert/strict";
import { deriveSyncStatusModel } from "../tools/llm-chat-cli/src/sync-status.js";

function basePayload(overrides = {}) {
  return {
    running: true,
    pid: 1234,
    state: {
      config: {
        syncStrategy: "both",
        git: { enabled: true },
        gdrive: { enabled: true }
      },
      sync: {
        status: "idle",
        conflictCount: 0,
        reviewNeeded: false
      }
    },
    sync: {
      status: "idle",
      conflictCount: 0
    },
    ...overrides
  };
}

test("deriveSyncStatusModel marks backends ok for healthy payload", () => {
  const model = deriveSyncStatusModel(basePayload(), { commandOk: true });
  assert.equal(model.status, "idle");
  assert.equal(model.backends.git.hasError, false);
  assert.equal(model.backends.drive.hasError, false);
  assert.equal(model.backends.git.level, "ok");
  assert.equal(model.backends.drive.level, "ok");
});

test("deriveSyncStatusModel marks git backend error for conflicts", () => {
  const model = deriveSyncStatusModel(
    basePayload({
      sync: {
        status: "conflict",
        conflictCount: 2,
        conflicts: [{ filePath: "notes/a.md" }, { filePath: "notes/b.md" }]
      }
    }),
    { commandOk: false }
  );
  assert.equal(model.conflictCount, 2);
  assert.equal(model.backends.git.hasError, true);
  assert.match(model.backends.git.reasons.join(","), /conflict/);
  assert.equal(model.backends.drive.hasError, false);
});

test("deriveSyncStatusModel marks git backend error for pull/push failures", () => {
  const model = deriveSyncStatusModel(
    basePayload({
      state: {
        config: {
          syncStrategy: "both",
          git: { enabled: true },
          gdrive: { enabled: true }
        },
        lastPullError: "pull failed: non-fast-forward",
        lastPushError: "push rejected by remote",
        sync: {
          status: "paused",
          conflictCount: 0
        }
      },
      sync: {
        status: "paused",
        conflictCount: 0,
        lastError: "git sync failed"
      }
    }),
    { commandOk: false }
  );

  assert.equal(model.backends.git.hasError, true);
  assert.match(model.backends.git.reasons.join(","), /pull-error/);
  assert.match(model.backends.git.reasons.join(","), /push-error/);
  assert.equal(model.backends.drive.hasError, false);
});

test("deriveSyncStatusModel marks drive backend error for resync-required failure", () => {
  const model = deriveSyncStatusModel(
    basePayload({
      state: {
        config: {
          syncStrategy: "both",
          git: { enabled: true },
          gdrive: { enabled: true }
        },
        lastGDriveRequiresResync: true,
        lastGDriveAutoResyncAttempted: true,
        lastGDriveAutoResyncApplied: false,
        lastGDriveError: "bisync needs --resync",
        sync: {
          status: "paused",
          conflictCount: 0
        }
      },
      sync: {
        status: "paused",
        conflictCount: 0
      }
    }),
    { commandOk: false }
  );

  assert.equal(model.backends.drive.hasError, true);
  assert.match(model.backends.drive.reasons.join(","), /gdrive-resync-required/);
  assert.equal(model.backends.git.hasError, false);
});

test("deriveSyncStatusModel marks drive backend error for dangerous/review-needed import", () => {
  const model = deriveSyncStatusModel(
    basePayload({
      sync: {
        status: "paused",
        conflictCount: 0,
        gdriveImport: "dangerous",
        reviewNeeded: true,
        lastError: "dangerous gdrive import held for review"
      }
    }),
    { commandOk: false }
  );

  assert.equal(model.backends.drive.hasError, true);
  assert.match(model.backends.drive.reasons.join(","), /gdrive-review-needed/);
  assert.equal(model.backends.git.hasError, false);
});

test("deriveSyncStatusModel marks both backends red when sync error cannot be attributed", () => {
  const model = deriveSyncStatusModel(
    basePayload({
      sync: {
        status: "paused",
        conflictCount: 0,
        lastError: "sync paused for unknown reason"
      }
    }),
    { commandOk: false }
  );

  assert.equal(model.unattributedSyncError, true);
  assert.equal(model.backends.git.hasError, true);
  assert.equal(model.backends.drive.hasError, true);
  assert.match(model.backends.git.reasons.join(","), /sync-error-unattributed/);
  assert.match(model.backends.drive.reasons.join(","), /sync-error-unattributed/);
});
