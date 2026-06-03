import { readUsageLedger, writeUsageLedger } from "../infrastructure/state.js";
import { createEmptyUsage, normalizeUsage } from "../domain/usage.js";

function createLedger() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: null,
    requests: 0,
    totals: createEmptyUsage(),
    byModel: {}
  };
}

function ensureModelEntry(ledger, modelName) {
  const key = modelName || "unknown";
  if (!ledger.byModel[key]) {
    ledger.byModel[key] = {
      requests: 0,
      totals: createEmptyUsage()
    };
  }
  return ledger.byModel[key];
}

export function addUsageToLedger({ usage, modelName }) {
  const normalized = normalizeUsage(usage);
  const ledger = readUsageLedger() || createLedger();

  ledger.requests += 1;
  ledger.lastUpdatedAt = new Date().toISOString();
  ledger.totals.prompt_tokens += normalized.prompt_tokens;
  ledger.totals.completion_tokens += normalized.completion_tokens;
  ledger.totals.total_tokens += normalized.total_tokens;

  const modelEntry = ensureModelEntry(ledger, modelName);
  modelEntry.requests += 1;
  modelEntry.totals.prompt_tokens += normalized.prompt_tokens;
  modelEntry.totals.completion_tokens += normalized.completion_tokens;
  modelEntry.totals.total_tokens += normalized.total_tokens;

  writeUsageLedger(ledger);
  return ledger;
}

export function getUsageLedger() {
  return readUsageLedger() || createLedger();
}
