import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startService, isProcessRunning } from "./service.js";
import { readPid, removePid, writePid, readState, writeState } from "./state.js";
import { loadLocalEnv } from "../../shared/env.js";

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve("config/notes-automation.config.json");

function printStatus() {
  const pid = readPid();
  let state = readState();
  const running = Boolean(pid && isProcessRunning(pid));
  if (!running && state?.running) {
    state = {
      ...state,
      running: false,
      pid: null,
      updatedAt: new Date().toISOString(),
      staleStateRecovered: true
    };
    writeState(state);
  }
  console.log(
    JSON.stringify(
      {
        running,
        pid,
        state
      },
      null,
      2
    )
  );
}

function startDetached() {
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

function requestAction(action) {
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
  console.log(`[notes-automation] action requested: ${action}`);
}

async function run() {
  writePid(process.pid);
  startService(CONFIG_PATH);
}

const command = process.argv[2] || "status";

switch (command) {
  case "start":
    startDetached();
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
    requestAction("flush-sync");
    break;
  case "resume":
    requestAction("resume");
    break;
  case "run":
    await run();
    break;
  default:
    console.error(
      "Usage: node tools/notes-automation/src/cli.js [start|stop|status|flush-push|flush-sync|resume]"
    );
    process.exit(1);
}
