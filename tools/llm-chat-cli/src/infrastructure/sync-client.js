import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildSyncStatusModelFromResult } from "../domain/sync-status.js";

export const NOTES_AUTOMATION_CLI_PATH = path.resolve("tools/notes-automation/src/cli.js");

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function formatSyncFeedback(result) {
  const payload = result?.payload && typeof result.payload === "object" ? result.payload : null;
  if (!payload) {
    if (result?.ok) return "[chat] sync completed.";
    return `[chat] sync failed: ${result?.output || "unknown error"}`;
  }

  const sync =
    payload.sync && typeof payload.sync === "object"
      ? payload.sync
      : payload.state && typeof payload.state?.sync === "object"
        ? payload.state.sync
        : {};
  const state = payload.state && typeof payload.state === "object" ? payload.state : {};
  const status = sync.status || (payload.ok ? "idle" : "error");
  const conflictCount = Number(sync.conflictCount || 0);
  const errorText = sync.lastError || payload.message || payload.error || "";
  const autoResyncAttempted = Boolean(
    sync.lastGDriveAutoResyncAttempted ?? state.lastGDriveAutoResyncAttempted
  );
  const autoResyncApplied = Boolean(
    sync.lastGDriveAutoResyncApplied ?? state.lastGDriveAutoResyncApplied
  );
  const resyncMode = String(sync.lastGDriveResyncMode || state.lastGDriveResyncMode || "").trim();
  const nestedStateSync = state?.sync && typeof state.sync === "object" ? state.sync : {};
  const gdriveImport = String(
    sync.gdriveImport ||
      sync.lastGDriveImportClassification ||
      nestedStateSync.lastGDriveImportClassification ||
      ""
  ).trim();
  const gdriveImportSummary =
    (sync.gdriveImportSummary && typeof sync.gdriveImportSummary === "object"
      ? sync.gdriveImportSummary
      : null) ||
    (sync.lastGDriveImportSummary && typeof sync.lastGDriveImportSummary === "object"
      ? sync.lastGDriveImportSummary
      : null) ||
    (nestedStateSync.lastGDriveImportSummary &&
    typeof nestedStateSync.lastGDriveImportSummary === "object"
      ? nestedStateSync.lastGDriveImportSummary
      : null);
  const gdriveImportPart = gdriveImport ? ` gdrive_import=${gdriveImport}` : "";
  const gdriveImportCounts =
    gdriveImportSummary && typeof gdriveImportSummary.changedCount === "number"
      ? ` changed=${Number(gdriveImportSummary.changedCount || 0)} added=${Number(gdriveImportSummary.addedCount || 0)} modified=${Number(gdriveImportSummary.modifiedCount || 0)} deleted=${Number(gdriveImportSummary.deletedCount || 0)}`
      : "";
  const nextAction =
    sync.nextAction ||
    (gdriveImport === "dangerous"
      ? "review local dangerous import commit before resume"
      : gdriveImport === "suspicious"
        ? "review suspicious import diff"
        : "");
  const nextActionPart =
    gdriveImport === "dangerous" || gdriveImport === "suspicious"
      ? ` next_action=${String(nextAction || "").trim() || "review import"}`
      : "";
  const autoResyncSummary = autoResyncAttempted
    ? ` auto_resync=${autoResyncApplied ? "applied" : "attempted"} mode=${resyncMode || "newer"}`
    : "";
  const base = `[chat] sync status=${status} conflicts=${conflictCount}${gdriveImportPart}${gdriveImportCounts}${autoResyncSummary}${nextActionPart}`;
  if (!payload.ok || errorText) {
    return `${base} error=${errorText || "unknown"}`;
  }
  return base;
}

export function createSyncClient({
  notesAutomationCliPath = NOTES_AUTOMATION_CLI_PATH,
  cwd = () => process.cwd(),
  env = () => process.env,
  execFileSyncImpl = execFileSync,
  processExecPath = process.execPath,
  statusModelBuilder = buildSyncStatusModelFromResult
} = {}) {
  const runNotesAutomationCommand = (args = []) => {
    try {
      const output = execFileSyncImpl(processExecPath, [notesAutomationCliPath, ...args], {
        cwd: cwd(),
        env: env(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      return { ok: true, output, payload: parseJsonOutput(output) };
    } catch (error) {
      const output = String(error?.stdout || error?.stderr || error?.message || "").trim();
      return { ok: false, output, payload: parseJsonOutput(output) };
    }
  };
  const syncStatusModelFromResult = (result) => statusModelBuilder(result);

  return {
    formatSyncFeedback,
    syncStatusModelFromResult,
    readLocalSyncStatusModel() {
      return syncStatusModelFromResult(runNotesAutomationCommand(["status"]));
    },
    runNotesAutomationCommand
  };
}

const defaultSyncClient = createSyncClient();

export const readLocalSyncStatusModel = defaultSyncClient.readLocalSyncStatusModel;
export const runNotesAutomationCommand = defaultSyncClient.runNotesAutomationCommand;
export const syncStatusModelFromResult = defaultSyncClient.syncStatusModelFromResult;
