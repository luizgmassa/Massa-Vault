import test from "node:test";
import assert from "node:assert/strict";
import { createSyncClient, formatSyncFeedback } from "../tools/llm-chat-cli/src/infrastructure/sync-client.js";

// --- TST-26: formatSyncFeedback (the real implementation, no stubs) --------

test("formatSyncFeedback: no payload, ok result", () => {
  assert.equal(formatSyncFeedback({ ok: true }), "[chat] sync completed.");
});

test("formatSyncFeedback: no payload, error result uses output, falling back to 'unknown error'", () => {
  assert.equal(formatSyncFeedback({ ok: false, output: "boom" }), "[chat] sync failed: boom");
  assert.equal(formatSyncFeedback({ ok: false }), "[chat] sync failed: unknown error");
});

test("formatSyncFeedback: payload present, ok, defaults to idle/0 conflicts", () => {
  assert.equal(formatSyncFeedback({ payload: { ok: true } }), "[chat] sync status=idle conflicts=0");
});

test("formatSyncFeedback: payload present, not ok, appends the error suffix", () => {
  assert.equal(
    formatSyncFeedback({ payload: { ok: false, message: "oops" } }),
    "[chat] sync status=error conflicts=0 error=oops"
  );
});

test("formatSyncFeedback: dangerous gdrive import still emits next_action even when payload.ok is true", () => {
  const result = formatSyncFeedback({
    payload: {
      ok: true,
      sync: { status: "paused", conflictCount: 0, lastGDriveImportClassification: "dangerous" }
    }
  });
  assert.equal(
    result,
    "[chat] sync status=paused conflicts=0 gdrive_import=dangerous next_action=review local dangerous import commit before resume"
  );
  assert.match(result, /next_action=/);
});

test("formatSyncFeedback: suspicious gdrive import uses the suspicious next_action wording", () => {
  assert.equal(
    formatSyncFeedback({
      payload: {
        ok: true,
        sync: { status: "paused", conflictCount: 0, lastGDriveImportClassification: "suspicious" }
      }
    }),
    "[chat] sync status=paused conflicts=0 gdrive_import=suspicious next_action=review suspicious import diff"
  );
});

test("formatSyncFeedback: an explicit sync.nextAction overrides the classification default", () => {
  assert.equal(
    formatSyncFeedback({
      payload: {
        ok: true,
        sync: {
          status: "paused",
          conflictCount: 0,
          lastGDriveImportClassification: "dangerous",
          nextAction: "custom review"
        }
      }
    }),
    "[chat] sync status=paused conflicts=0 gdrive_import=dangerous next_action=custom review"
  );
});

test("formatSyncFeedback: gdriveImportSummary renders changed/added/modified/deleted counts", () => {
  assert.equal(
    formatSyncFeedback({
      payload: {
        ok: true,
        sync: {
          status: "paused",
          conflictCount: 0,
          gdriveImport: "dangerous",
          gdriveImportSummary: { changedCount: 5, addedCount: 1, modifiedCount: 2, deletedCount: 2 }
        }
      }
    }),
    "[chat] sync status=paused conflicts=0 gdrive_import=dangerous changed=5 added=1 modified=2 deleted=2 next_action=review local dangerous import commit before resume"
  );
});

test("formatSyncFeedback: auto-resync attempted (not applied) reports mode", () => {
  assert.equal(
    formatSyncFeedback({
      payload: {
        ok: true,
        sync: {
          status: "idle",
          conflictCount: 0,
          lastGDriveAutoResyncAttempted: true,
          lastGDriveAutoResyncApplied: false,
          lastGDriveResyncMode: "newer"
        }
      }
    }),
    "[chat] sync status=idle conflicts=0 auto_resync=attempted mode=newer"
  );
});

test("formatSyncFeedback: auto-resync applied falls back to mode=newer when unset", () => {
  assert.equal(
    formatSyncFeedback({
      payload: {
        ok: true,
        sync: {
          status: "idle",
          conflictCount: 0,
          lastGDriveAutoResyncAttempted: true,
          lastGDriveAutoResyncApplied: true
        }
      }
    }),
    "[chat] sync status=idle conflicts=0 auto_resync=applied mode=newer"
  );
});

test("formatSyncFeedback: falls back to payload.state.sync when payload.sync is absent, and to top-level state fields for auto-resync", () => {
  const result = formatSyncFeedback({
    payload: {
      ok: true,
      state: {
        sync: { status: "paused", conflictCount: 1, lastGDriveImportClassification: "dangerous" },
        lastGDriveAutoResyncAttempted: true,
        lastGDriveAutoResyncApplied: true,
        lastGDriveResyncMode: "explicit"
      }
    }
  });
  assert.equal(
    result,
    "[chat] sync status=paused conflicts=1 gdrive_import=dangerous auto_resync=applied mode=explicit next_action=review local dangerous import commit before resume"
  );
});

test("formatSyncFeedback: gdriveImport and gdriveImportSummary fall back to the nested state.sync object", () => {
  const result = formatSyncFeedback({
    payload: {
      ok: true,
      sync: { status: "idle", conflictCount: 0 },
      state: { sync: { lastGDriveImportClassification: "suspicious" } }
    }
  });
  assert.equal(
    result,
    "[chat] sync status=idle conflicts=0 gdrive_import=suspicious next_action=review suspicious import diff"
  );
});

test("formatSyncFeedback: gdriveImportSummary specifically falls back to nestedStateSync.lastGDriveImportSummary", () => {
  const result = formatSyncFeedback({
    payload: {
      ok: true,
      sync: { status: "idle", conflictCount: 0, gdriveImport: "suspicious" },
      state: {
        sync: {
          lastGDriveImportSummary: { changedCount: 3, addedCount: 3, modifiedCount: 0, deletedCount: 0 }
        }
      }
    }
  });
  assert.equal(
    result,
    "[chat] sync status=idle conflicts=0 gdrive_import=suspicious changed=3 added=3 modified=0 deleted=0 next_action=review suspicious import diff"
  );
});

test("formatSyncFeedback: a dangerous classification combined with a real error still surfaces both", () => {
  const result = formatSyncFeedback({
    payload: {
      ok: false,
      sync: {
        status: "error",
        conflictCount: 0,
        lastGDriveImportClassification: "dangerous",
        lastError: "git push failed"
      }
    }
  });
  assert.equal(
    result,
    "[chat] sync status=error conflicts=0 gdrive_import=dangerous next_action=review local dangerous import commit before resume error=git push failed"
  );
});

// --- createSyncClient: real execFileSyncImpl error -> stdout/stderr -> JSON recovery ---

test("createSyncClient runs the real notes-automation CLI invocation shape with injected collaborators", () => {
  const calls = [];
  const client = createSyncClient({
    notesAutomationCliPath: "/fake/cli.js",
    cwd: () => "/fake/cwd",
    env: () => ({ FAKE_ENV: "1" }),
    processExecPath: "/fake/node",
    execFileSyncImpl: (execPath, args, options) => {
      calls.push({ execPath, args, options });
      return `${JSON.stringify({ ok: true, sync: { status: "idle", conflictCount: 0 } })}\n`;
    }
  });

  const result = client.runNotesAutomationCommand(["status"]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].execPath, "/fake/node");
  assert.deepEqual(calls[0].args, ["/fake/cli.js", "status"]);
  assert.equal(calls[0].options.cwd, "/fake/cwd");
  assert.deepEqual(calls[0].options.env, { FAKE_ENV: "1" });
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(result.ok, true);
  assert.equal(result.payload.sync.status, "idle");
});

test("createSyncClient recovers a JSON payload from a throwing execFileSyncImpl's stdout", () => {
  const client = createSyncClient({
    execFileSyncImpl: () => {
      const error = new Error("Command failed");
      error.stdout = `${JSON.stringify({ ok: false, message: "sync locked" })}\n`;
      error.stderr = "";
      throw error;
    }
  });

  const result = client.runNotesAutomationCommand(["sync"]);
  assert.equal(result.ok, false);
  assert.equal(result.output, JSON.stringify({ ok: false, message: "sync locked" }));
  assert.deepEqual(result.payload, { ok: false, message: "sync locked" });
});

test("createSyncClient falls back to stderr, then to error.message, when stdout is empty", () => {
  const stderrClient = createSyncClient({
    execFileSyncImpl: () => {
      const error = new Error("Command failed");
      error.stdout = "";
      error.stderr = "fatal: notes-automation daemon not running";
      throw error;
    }
  });
  const stderrResult = stderrClient.runNotesAutomationCommand(["status"]);
  assert.equal(stderrResult.ok, false);
  assert.equal(stderrResult.output, "fatal: notes-automation daemon not running");
  assert.equal(stderrResult.payload, null);

  const messageOnlyClient = createSyncClient({
    execFileSyncImpl: () => {
      throw new Error("spawn ENOENT");
    }
  });
  const messageResult = messageOnlyClient.runNotesAutomationCommand(["status"]);
  assert.equal(messageResult.ok, false);
  assert.equal(messageResult.output, "spawn ENOENT");
  assert.equal(messageResult.payload, null);
});

test("createSyncClient handles a thrown non-Error value: no stdout/stderr/message means an empty output", () => {
  const client = createSyncClient({
    execFileSyncImpl: () => {
      // eslint-disable-next-line no-throw-literal
      throw "raw string failure";
    }
  });
  const result = client.runNotesAutomationCommand(["status"]);
  assert.equal(result.ok, false);
  assert.equal(result.output, "");
  assert.equal(result.payload, null);
});

test("createSyncClient.readLocalSyncStatusModel wires runNotesAutomationCommand into the status model builder", () => {
  const client = createSyncClient({
    execFileSyncImpl: () => `${JSON.stringify({ ok: true, sync: { status: "syncing", conflictCount: 0 } })}\n`,
    statusModelBuilder: (result) => ({ builtFrom: result.payload?.sync?.status ?? null })
  });

  assert.deepEqual(client.readLocalSyncStatusModel(), { builtFrom: "syncing" });
});
