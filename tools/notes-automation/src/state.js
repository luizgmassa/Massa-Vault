import fs from "node:fs";
import path from "node:path";

const STATE_DIR = path.resolve(".automation/notes-automation");
const PID_FILE = path.join(STATE_DIR, "service.pid");
const STATE_FILE = path.join(STATE_DIR, "state.json");

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function writePid(pid) {
  ensureDir();
  fs.writeFileSync(PID_FILE, String(pid), "utf8");
}

export function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return null;
  }
}

export function removePid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
}

export function writeState(state) {
  ensureDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function statePaths() {
  return { STATE_DIR, PID_FILE, STATE_FILE };
}
