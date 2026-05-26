import { readUsageLedger, writeUsageLedger } from "./state.js";

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeUsage(usage) {
  return {
    prompt_tokens: normalizeNumber(usage?.prompt_tokens),
    completion_tokens: normalizeNumber(usage?.completion_tokens),
    total_tokens: normalizeNumber(usage?.total_tokens)
  };
}

function createEmptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };
}

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

export function createSessionUsage() {
  return createEmptyUsage();
}

export function accumulateSessionUsage(sessionUsage, usage) {
  const normalized = normalizeUsage(usage);
  sessionUsage.prompt_tokens += normalized.prompt_tokens;
  sessionUsage.completion_tokens += normalized.completion_tokens;
  sessionUsage.total_tokens += normalized.total_tokens;
  return sessionUsage;
}

export function calculateRemainingFromLimits({
  limitsByModel,
  modelName,
  usedPromptTokens = 0,
  usedCompletionTokens = 0
}) {
  const limits = limitsByModel?.[modelName];
  if (!limits) {
    return {
      model: modelName,
      tpmRemaining: "unknown",
      rpmRemaining: "unknown",
      resetsIn: "unknown"
    };
  }

  const usedTotal = normalizeNumber(usedPromptTokens) + normalizeNumber(usedCompletionTokens);
  const tpmRemaining =
    typeof limits.tpm === "number" ? Math.max(0, limits.tpm - usedTotal) : "unknown";
  const rpmRemaining = typeof limits.rpm === "number" ? Math.max(0, limits.rpm - 1) : "unknown";

  return {
    model: modelName,
    tpmRemaining,
    rpmRemaining,
    resetsIn: "unknown"
  };
}
