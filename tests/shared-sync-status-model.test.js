import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSyncStatusModelFromResult,
  deriveSyncStatusModel
} from "../tools/shared/sync-status-model.js";
import {
  SYNC_BACKEND_LEVEL,
  SYNC_BACKEND_REASON,
  SYNC_STATUS,
  SYNC_STATUS_FALLBACK_ERROR,
  SYNC_SUMMARY_LIMITS
} from "../tools/shared/sync-status-contract.js";

// Producer/consumer contract: notes-automation emits a status payload (JSON on
// stdout), llm-chat-cli derives its status model from the command result. These
// tests pin the derivation both ways so either side can change safely.

function producerPayload(overrides = {}) {
  return {
    running: true,
    pid: 4242,
    paused: false,
    state: {
      updatedAt: "2026-08-02T10:00:00.000Z",
      lastPullAt: "2026-08-02T09:59:00.000Z",
      config: { syncStrategy: "both", git: { enabled: true }, gdrive: { enabled: true } },
      ...overrides.state
    },
    sync: {
      status: "idle",
      conflictCount: 0,
      conflicts: [],
      lastSuccessAt: "2026-08-02T09:59:30.000Z",
      ...overrides.sync
    }
  };
}

test("healthy producer payload derives ok backends and passes fields through", () => {
  const result = { ok: true, output: JSON.stringify(producerPayload()) };

  const model = buildSyncStatusModelFromResult(result);

  assert.equal(model.ok, true);
  assert.equal(model.status, SYNC_STATUS.IDLE);
  assert.equal(model.running, true);
  assert.equal(model.pid, 4242);
  assert.equal(model.conflictCount, 0);
  assert.equal(model.lastError, "");
  assert.equal(model.backends.git.level, SYNC_BACKEND_LEVEL.OK);
  assert.equal(model.backends.drive.level, SYNC_BACKEND_LEVEL.OK);
  assert.deepEqual(model.backends.git.reasons, []);
  assert.deepEqual(model.backends.drive.reasons, []);
  assert.equal(model.unattributedSyncError, false);
  assert.equal(model.lastSuccessAt, "2026-08-02T09:59:30.000Z");
  assert.equal(model.updatedAt, "2026-08-02T10:00:00.000Z");
});

test("a git conflict is attributed to the git backend only", () => {
  const payload = producerPayload({
    sync: {
      status: "conflict",
      conflictCount: 2,
      conflicts: [{ filePath: "notes/a.md" }, { filePath: "notes/b.md" }]
    }
  });

  const model = buildSyncStatusModelFromResult({ ok: true, output: JSON.stringify(payload) });

  assert.equal(model.status, SYNC_STATUS.CONFLICT);
  assert.equal(model.backends.git.level, SYNC_BACKEND_LEVEL.ERROR);
  assert.ok(model.backends.git.reasons.includes(SYNC_BACKEND_REASON.CONFLICT));
  assert.equal(model.backends.drive.level, SYNC_BACKEND_LEVEL.OK);
  assert.equal(model.unattributedSyncError, false);
  assert.equal(model.conflicts.length, 2);
});

test("a drive error is attributed to the drive backend only", () => {
  const payload = producerPayload({
    sync: { lastGDriveError: "bisync failed: CRITICAL divergence" }
  });

  const model = buildSyncStatusModelFromResult({ ok: true, output: JSON.stringify(payload) });

  assert.equal(model.backends.drive.level, SYNC_BACKEND_LEVEL.ERROR);
  assert.ok(model.backends.drive.reasons.includes(SYNC_BACKEND_REASON.GDRIVE_ERROR));
  assert.equal(model.backends.git.level, SYNC_BACKEND_LEVEL.OK);
  assert.match(model.backends.drive.lastGDriveError, /CRITICAL divergence/);
});

test("an unattributed failure flags both backends with the shared reason", () => {
  const payload = producerPayload({ sync: { status: "paused" } });

  const model = buildSyncStatusModelFromResult({ ok: true, output: JSON.stringify(payload) });

  assert.equal(model.unattributedSyncError, true);
  assert.equal(model.backends.git.level, SYNC_BACKEND_LEVEL.ERROR);
  assert.equal(model.backends.drive.level, SYNC_BACKEND_LEVEL.ERROR);
  assert.ok(model.backends.git.reasons.includes(SYNC_BACKEND_REASON.SYNC_ERROR_UNATTRIBUTED));
  assert.ok(model.backends.drive.reasons.includes(SYNC_BACKEND_REASON.SYNC_ERROR_UNATTRIBUTED));
});

test("disabled backends report the disabled level instead of ok", () => {
  const payload = producerPayload({
    state: { config: { syncStrategy: "git", git: { enabled: true }, gdrive: { enabled: false } } }
  });

  const model = buildSyncStatusModelFromResult({ ok: true, output: JSON.stringify(payload) });

  assert.equal(model.backends.git.level, SYNC_BACKEND_LEVEL.OK);
  assert.equal(model.backends.drive.level, SYNC_BACKEND_LEVEL.DISABLED);
});

test("a failed command with non-JSON output degrades to the fallback error model", () => {
  const model = buildSyncStatusModelFromResult({ ok: false, output: "spawn ENOENT" });

  assert.equal(model.ok, false);
  assert.equal(model.status, SYNC_STATUS.ERROR);
  assert.match(model.lastError, /spawn ENOENT/);
  assert.equal(model.running, false);
  assert.equal(model.pid, null);
});

test("a failed command with empty output uses the shared fallback message", () => {
  const model = buildSyncStatusModelFromResult({ ok: false, output: "" });

  assert.equal(model.ok, false);
  assert.equal(model.status, SYNC_STATUS.ERROR);
  assert.equal(model.lastError, SYNC_STATUS_FALLBACK_ERROR);
});

test("error text is summarized to the contract's line and char limits", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line-${index}`);
  const model = deriveSyncStatusModel(
    producerPayload({ sync: { status: "error", lastError: lines.join("\n") } })
  );

  const summaryLines = model.lastError.split("\n");
  assert.equal(summaryLines.length, SYNC_SUMMARY_LIMITS.maxLines);
  assert.equal(summaryLines[0], "line-28");
  assert.equal(summaryLines.at(-1), "line-39");
  assert.ok(model.lastError.length <= SYNC_SUMMARY_LIMITS.maxChars);
});

test("root-level sync fields override state.sync fields on merge", () => {
  const model = deriveSyncStatusModel({
    running: false,
    state: { sync: { status: "idle", queuedReason: "stale" } },
    sync: { status: "syncing", queuedReason: "manual" }
  });

  assert.equal(model.status, SYNC_STATUS.SYNCING);
  assert.equal(model.queuedReason, "manual");
});
