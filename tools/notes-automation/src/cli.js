import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "./config.js";
import { checkGoogleDriveRemote, syncToGoogleDrive } from "./gdrive.js";
import { runSyncOnce, startService, isProcessRunning } from "./service.js";
import { readPid, removePid, writePid, readState, writeState } from "./state.js";
import { loadLocalEnv } from "../../shared/env.js";
import { deriveSyncStatusModel } from "../../shared/sync-status-model.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve("config/notes-automation.config.json");

function asPid(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function printStatus() {
  let pid = asPid(readPid());
  let state = readState();
  const statePid = asPid(state?.pid);
  const pidRunning = Boolean(pid && isProcessRunning(pid));
  const statePidRunning = Boolean(statePid && isProcessRunning(statePid));

  if (!pidRunning && statePidRunning) {
    pid = statePid;
    writePid(pid);
  }

  const running = Boolean(pid && isProcessRunning(pid));
  const normalizedPid = running ? pid : null;
  const stateNeedsRecovery =
    Boolean(state?.running) !== running || asPid(state?.pid) !== normalizedPid;
  if (stateNeedsRecovery) {
    state = {
      ...state,
      running,
      pid: normalizedPid,
      updatedAt: new Date().toISOString(),
      staleStateRecovered: true
    };
    writeState(state);
  }
  if (!running) {
    removePid();
  }
  const payload = {
    running,
    pid: normalizedPid,
    state,
    sync: summarizeSyncStatus()
  };
  payload.syncModel = deriveSyncStatusModel(payload, { commandOk: true });
  console.log(JSON.stringify(payload, null, 2));
}

async function startDetached() {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`[notes-automation] already running with pid ${existingPid}`);
    return;
  }

  const child = spawn(process.execPath, [path.join(__dirname, "cli.js"), "run"], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env
  });
  child.unref();
  writePid(child.pid);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!isProcessRunning(child.pid)) {
    removePid();
    const state = readState();
    const details = state?.watchAlert || state?.lastError || "unknown startup failure";
    console.error(`[notes-automation] failed to start: ${details}`);
    process.exit(1);
  }
  console.log(`[notes-automation] started with pid ${child.pid}`);
}

function stopService() {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    removePid();
    const current = readState();
    writeState({
      ...current,
      running: false,
      pid: null,
      updatedAt: new Date().toISOString()
    });
    console.log("[notes-automation] not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    removePid();
    console.log(`[notes-automation] stop signal sent to pid ${pid}`);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      removePid();
      const current = readState();
      writeState({
        ...current,
        running: false,
        pid: null,
        updatedAt: new Date().toISOString()
      });
      console.log("[notes-automation] not running");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[notes-automation] failed to stop pid ${pid}: ${message}`);
    process.exit(1);
  }
}

function requestAction(action, { quiet = false } = {}) {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    console.error(`[notes-automation] service is not running`);
    process.exit(1);
  }
  const current = readState();
  writeState({
    ...current,
    requestedAction: action,
    requestedAt: new Date().toISOString()
  });
  if (!quiet) {
    console.log(`[notes-automation] action requested: ${action}`);
  }
}

function summarizeSyncStatus() {
  const state = readState();
  const sync = state?.sync && typeof state.sync === "object" ? state.sync : {};
  const gdriveImport = sync.lastGDriveImportClassification || null;
  const gdriveImportSummary =
    sync.lastGDriveImportSummary && typeof sync.lastGDriveImportSummary === "object"
      ? sync.lastGDriveImportSummary
      : null;
  const reviewNeeded = Boolean(sync.reviewNeeded);
  const nextAction =
    gdriveImport === "dangerous"
      ? "review latest local sync(gdrive) dangerous commit; restore from pre-GDrive snapshot if needed; run sync-resolve/resume after manual verification"
      : gdriveImport === "suspicious"
        ? "review imported diff summary and confirm before continuing normal automation"
        : null;
  return {
    running: Boolean(state?.running),
    paused: Boolean(state?.paused),
    status: sync.status || "idle",
    reason: sync.reason || null,
    queuedReason: sync.queuedReason || null,
    conflictCount: Number(sync.conflictCount || 0),
    conflicts: Array.isArray(sync.conflicts) ? sync.conflicts : [],
    lastError: sync.lastError || null,
    lastSuccessAt: sync.lastSuccessAt || null,
    finishedAt: sync.finishedAt || null,
    lastGDriveRequiresResync: Boolean(state?.lastGDriveRequiresResync),
    lastGDriveAutoResyncAttempted: Boolean(state?.lastGDriveAutoResyncAttempted),
    lastGDriveAutoResyncApplied: Boolean(state?.lastGDriveAutoResyncApplied),
    lastGDriveAutoResyncAt: state?.lastGDriveAutoResyncAt || null,
    lastGDriveResyncMode: state?.lastGDriveResyncMode || null,
    lastGDriveInitialError: state?.lastGDriveInitialError || null,
    gdrive_import: gdriveImport,
    gdriveImport,
    gdriveImportSummary,
    reviewNeeded,
    lastPreGDriveSnapshotCommit: sync.lastPreGDriveSnapshotCommit || null,
    preGDriveSnapshotSkipped: sync.preGDriveSnapshotSkipped || null,
    nextAction,
    alert: state?.alert || null
  };
}

function printSyncSummary(payload) {
  const summaryPayload = { ...payload };
  summaryPayload.syncModel = deriveSyncStatusModel(summaryPayload, {
    commandOk: Boolean(summaryPayload.ok ?? true),
    output: String(summaryPayload.message || summaryPayload.error || "")
  });
  console.log(JSON.stringify(summaryPayload, null, 2));
}

async function waitForSyncCompletion({
  timeoutMs = 300_000,
  pollMs = 500
} = {}) {
  const start = Date.now();
  let sawRequested = false;
  let sawSyncing = false;
  while (Date.now() - start < timeoutMs) {
    const state = readState();
    const sync = summarizeSyncStatus();
    if (state?.requestedAction) {
      sawRequested = true;
    }
    if (sync.status === "syncing") {
      sawSyncing = true;
    }
    const requestSettled = !state?.requestedAction && sawRequested;
    const syncSettled = sync.status !== "syncing" && sawSyncing;
    if (requestSettled || syncSettled) {
      return sync;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const timedOut = summarizeSyncStatus();
  return { ...timedOut, timedOut: true };
}

async function runManualSync() {
  const pid = readPid();
  const serviceRunning = Boolean(pid && isProcessRunning(pid));
  if (serviceRunning) {
    requestAction("sync", { quiet: true });
    const sync = await waitForSyncCompletion();
    printSyncSummary({
      ok: !sync.timedOut && sync.status !== "conflict" && !sync.lastError,
      serviceMode: "daemon",
      sync
    });
    if (sync.timedOut || sync.status === "conflict" || sync.lastError) {
      process.exit(1);
    }
    return;
  }

  const result = await runSyncOnce(CONFIG_PATH, { reason: "manual-cli" });
  const sync = summarizeSyncStatus();
  printSyncSummary({
    ok: Boolean(result?.ok),
    serviceMode: "oneshot",
    result,
    sync
  });
  if (!result?.ok) {
    process.exit(1);
  }
}

function printSyncConflicts() {
  const sync = summarizeSyncStatus();
  printSyncSummary({
    ok: sync.conflictCount > 0,
    sync
  });
}

function printResolveGuide(markDone = false) {
  const state = readState();
  const sync = summarizeSyncStatus();
  if (!sync.conflictCount) {
    printSyncSummary({
      ok: true,
      message: "No active sync conflicts.",
      sync
    });
    return;
  }

  if (markDone) {
    const pid = readPid();
    if (pid && isProcessRunning(pid)) {
      requestAction("resume");
      printSyncSummary({
        ok: true,
        message: "Conflict state cleared. Daemon resume requested. Run `npm run vault -- sync` next.",
        sync: summarizeSyncStatus()
      });
      return;
    }

    writeState({
      ...state,
      paused: false,
      alert: null,
      sync: {
        ...(state?.sync && typeof state.sync === "object" ? state.sync : {}),
        status: "idle",
        conflictCount: 0,
        conflicts: [],
        lastError: null,
        queuedReason: null,
        reason: null
      },
      updatedAt: new Date().toISOString()
    });
    printSyncSummary({
      ok: true,
      message: "Conflict state cleared. Run `npm run vault -- sync` to verify.",
      sync: summarizeSyncStatus()
    });
    return;
  }

  const conflicts = Array.isArray(sync.conflicts) ? sync.conflicts : [];
  printSyncSummary({
    ok: false,
    message:
      "Resolve each conflicted file using quarantine snapshots, then run `npm run vault -- sync resolve --done`.",
    conflictRootHint:
      conflicts[0]?.worktreePath?.split("/.automation/sync-conflicts/")[0] || state?.vaultPath || null,
    conflicts
  });
  process.exit(1);
}

function printGDriveCheck() {
  const config = loadConfig(CONFIG_PATH);
  if (!config.gdrive.enabled) {
    const payload = { ok: false, skipped: true, reason: "gdrive sync is disabled by sync_strategy" };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  const result = checkGoogleDriveRemote(config.gdrive);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

function printGDriveDryRun() {
  const config = loadConfig(CONFIG_PATH);
  if (!config.gdrive.enabled) {
    const payload = { ok: false, skipped: true, reason: "gdrive sync is disabled by sync_strategy" };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  const result = syncToGoogleDrive(config.vaultPath, config.gdrive, {
    dryRun: true
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

async function run() {
  writePid(process.pid);
  try {
    startService(CONFIG_PATH);
  } catch (error) {
    const current = readState();
    writeState({
      ...current,
      running: false,
      pid: null,
      lastError: `startup failure: ${String(error?.message || error)}`,
      updatedAt: new Date().toISOString()
    });
    removePid();
    throw error;
  }
}

async function main() {
  const command = process.argv[2] || "status";

  switch (command) {
    case "start":
      await startDetached();
      break;
    case "stop":
      stopService();
      break;
    case "status":
      printStatus();
      break;
    case "flush-push":
      requestAction("flush-push");
      break;
    case "flush-sync":
      await runManualSync();
      break;
    case "sync":
      await runManualSync();
      break;
    case "sync-conflicts":
      printSyncConflicts();
      break;
    case "sync-resolve":
      printResolveGuide(process.argv.includes("--done"));
      break;
    case "resume":
      requestAction("resume");
      break;
    case "gdrive-check":
      printGDriveCheck();
      break;
    case "gdrive-dry-run":
      printGDriveDryRun();
      break;
    case "run":
      await run();
      break;
    default:
      console.error(
        "Usage: node tools/notes-automation/src/cli.js [start|stop|status|sync|sync-conflicts|sync-resolve|flush-push|flush-sync|resume|gdrive-check|gdrive-dry-run]"
      );
      process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[notes-automation] ${message}`);
  process.exit(1);
});
