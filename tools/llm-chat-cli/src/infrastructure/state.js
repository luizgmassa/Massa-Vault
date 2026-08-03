import fs from "node:fs";
import path from "node:path";

function resolveStatePaths() {
  const stateDir = path.resolve(".automation/llm-chat-cli");
  return {
    STATE_DIR: stateDir,
    USAGE_FILE: path.join(stateDir, "usage.json")
  };
}

function ensureStateDir() {
  fs.mkdirSync(resolveStatePaths().STATE_DIR, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function writeJson(filePath, payload) {
  ensureStateDir();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

export function readUsageLedger() {
  return readJson(resolveStatePaths().USAGE_FILE, null);
}

export function writeUsageLedger(ledger) {
  writeJson(resolveStatePaths().USAGE_FILE, ledger);
}
