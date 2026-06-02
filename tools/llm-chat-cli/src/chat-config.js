import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../../notes-automation/src/config.js";
import { loadLocalEnv } from "../../shared/env.js";
import { buildSyncStatusModelFromResult } from "./sync-status.js";

loadLocalEnv();

export const DEFAULT_GATEWAY_URL = `http://127.0.0.1:${process.env.ROUTER_GATEWAY_PORT || 4100}`;
export const DEFAULT_GATEWAY_MODEL = "smart-router";
export const DEFAULT_CONFIG_PATH = path.resolve("config/notes-automation.config.json");
export const NOTES_AUTOMATION_CLI_PATH = path.resolve("tools/notes-automation/src/cli.js");
export const DEFAULT_HISTORY_SUMMARY_MAX_CHARS = 16_000;
export const DEFAULT_IDLE_SYNC_MS = Number(process.env.MASSA_VAULT_CHAT_IDLE_SYNC_MS || 30_000);
export const RAG_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export function buildGatewayOptions() {
  return {
    gatewayUrl: process.env.MASSA_VAULT_CHAT_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    apiKey: process.env.LITELLM_MASTER_KEY || ""
  };
}

export function isVaultContextEnabled(env = process.env) {
  const raw = String(env.MASSA_VAULT_CHAT_RAG || "")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  return !RAG_DISABLED_VALUES.has(raw);
}

export function resolveVaultPath() {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  return config.vaultPath;
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function runNotesAutomationCommand(args = []) {
  try {
    const output = execFileSync(process.execPath, [NOTES_AUTOMATION_CLI_PATH, ...args], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, output, payload: parseJsonOutput(output) };
  } catch (error) {
    const output = String(error?.stdout || error?.stderr || error?.message || "").trim();
    return { ok: false, output, payload: parseJsonOutput(output) };
  }
}

export function readLocalSyncStatusModel() {
  return buildSyncStatusModelFromResult(runNotesAutomationCommand(["status"]));
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
